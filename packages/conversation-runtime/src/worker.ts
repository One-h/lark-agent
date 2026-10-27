import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { defaultLarkAcknowledgeReactionEmoji, isLarkReactionEmojiType, larkReactionEmojiTypes } from "@lark-agent/adapter-lark-cli";
import { config, db, getAppSettings, larkReactionSender, nowIso } from "./context.js";
import { decideLarkExecutionApprovalFromCard, enqueueLarkCodexReply } from "./responder.js";
import { backfillLarkContactsFromMessageMentions, upsertLarkContactsFromMentions } from "./contacts.js";
import { conversationSpontaneousSettings } from "./spontaneous.js";
import { imageKeysFromContent } from "./mediaImages.js";

const messageConsumeCommand = "tail -f /dev/null | lark-cli event consume im.message.receive_v1 --as bot";
const approvalConsumeCommand = "tail -f /dev/null | lark-cli event consume card.action.trigger --as bot";

type LarkEvent = Record<string, unknown>;

type ListenerKind = "message" | "approval";

type ListenerState = {
  command: string;
  label: string;
  consumer: ChildProcessWithoutNullStreams | null;
  stdoutBuffer: string;
  restartTimer: NodeJS.Timeout | undefined;
  handleLine: (line: string) => void;
};

const listeners = {} as Record<ListenerKind, ListenerState>;
let intentionallyStopped = false;
let currentBotOpenId: string | undefined;
let botOpenIdRetryAfterMs = 0;
let externalMessageHandler: ((event: LarkEvent) => boolean) | null = null;
export function setExternalMessageHandler(handler: ((event: LarkEvent) => boolean) | null) { externalMessageHandler = handler; }

let additionalApprovalHandler: ((event: LarkEvent) => boolean) | null = null;
const botOpenIdRetryDelayMs = 5_000;

function cleanupStaleConsumers(): void {
  const result = spawnSync("ps", ["-axo", "pid,ppid,pgid,command"], { encoding: "utf8" });
  if (result.status !== 0) {
    return;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const [, pidText, ppidText, pgidText, command] = match;
    if (Number(ppidText) !== 1 || ![messageConsumeCommand, approvalConsumeCommand].some((candidate) => ["-c", "-lc"].some(flag => command.includes(`sh ${flag} ${candidate}`)))) {
      continue;
    }
    const pgid = Number(pgidText);
    if (!Number.isFinite(pgid) || pgid <= 0 || pgid === process.pid) {
      continue;
    }
    try {
      process.kill(-pgid, "SIGTERM");
      console.warn(`Cleaned stale Lark message listener process group ${pgid} (pid ${pidText})`);
    } catch (error) {
      console.warn(`Failed to clean stale Lark listener ${pidText}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventMessageAt(event: LarkEvent, fallback: string): string {
  const value = stringValue(event.create_time) ?? stringValue(event.message_at);
  if (!value) return fallback;
  const numeric = /^\d+$/.test(value) ? Number(value) : NaN;
  const parsed = Number.isFinite(numeric) ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function eventMentions(event: LarkEvent): unknown[] {
  const mentions = event.mentions;
  if (Array.isArray(mentions)) {
    return mentions;
  }
  const rawEvent = event.event;
  if (rawEvent && typeof rawEvent === "object") {
    const message = (rawEvent as { message?: { mentions?: unknown } }).message;
    return Array.isArray(message?.mentions) ? message.mentions : [];
  }
  return [];
}

function mentionIdentifier(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return null;
  const nested = value as { open_id?: unknown; openId?: unknown; user_id?: unknown; userId?: unknown };
  return stringValue(nested.open_id) ?? stringValue(nested.openId) ?? stringValue(nested.user_id) ?? stringValue(nested.userId);
}

export function larkBotOpenIdFromAuthStatus(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { identities?: { bot?: { openId?: unknown; open_id?: unknown } } };
    return stringValue(parsed.identities?.bot?.openId) ?? stringValue(parsed.identities?.bot?.open_id);
  } catch {
    return null;
  }
}

function resolveCurrentBotOpenId(): string | null {
  if (currentBotOpenId) {
    return currentBotOpenId;
  }
  if (Date.now() < botOpenIdRetryAfterMs) {
    return null;
  }
  const result = spawnSync("lark-cli", ["auth", "status", "--json", "--verify"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
    }
  });
  const resolved = result.status === 0 ? larkBotOpenIdFromAuthStatus(result.stdout) : null;
  if (resolved) {
    currentBotOpenId = resolved;
    botOpenIdRetryAfterMs = 0;
    return resolved;
  }
  botOpenIdRetryAfterMs = Date.now() + botOpenIdRetryDelayMs;
  if (!resolved) {
    console.warn(`Unable to resolve current Lark bot open_id: ${(result.stderr || result.stdout || "lark-cli auth status failed").trim()}`);
  }
  return null;
}

export function isAtMeMessage(event: LarkEvent, botOpenId?: string): boolean {
  if (event.chat_type === "p2p") {
    return true;
  }
  const currentBotOpenId = botOpenId ?? resolveCurrentBotOpenId();
  const mentions = eventMentions(event);
  if (!currentBotOpenId) {
    return false;
  }
  return mentions.some((mention) => {
    if (!mention || typeof mention !== "object") {
      return false;
    }
    const value = mention as { id?: unknown; open_id?: unknown; openId?: unknown };
    return mentionIdentifier(value.id) === currentBotOpenId
      || mentionIdentifier(value.open_id) === currentBotOpenId
      || mentionIdentifier(value.openId) === currentBotOpenId;
  });
}

export function shouldStartSpontaneousLarkReply(
  event: LarkEvent,
  explicitlyMentioned: boolean,
  hasRecentReply: boolean,
  randomValue = Math.random(),
  enabled = getAppSettings().larkGroupSpontaneousRepliesEnabled,
  rate = getAppSettings().larkGroupSpontaneousReplyRate,
  allowedChatIds = getAppSettings().larkGroupSpontaneousChatIds
): boolean {
  if (typeof event.chat_id !== "string") return false;
  const policy = db?.open ? conversationSpontaneousSettings(event.chat_id) : null;
  const effectiveEnabled = policy?.mode === "on" ? true : policy?.mode === "off" ? false : enabled && allowedChatIds.includes(event.chat_id);
  const normalizedRate = Math.max(0, Math.min(1, policy?.mode === "on" ? policy.effectiveReplyRate : rate));
  return effectiveEnabled
    && !explicitlyMentioned
    && !hasRecentReply
    && event.chat_type === "group"
    && event.sender_type === "user"
    && event.message_type === "text"
    && Boolean(stringValue(event.content))
    && randomValue < normalizedRate;
}

export function hasRecentHandledLarkMessage(chatId: string | null, nowMs = Date.now()): boolean {
  if (!chatId) return false;
  const cooldownMs = conversationSpontaneousSettings(chatId).effectiveCooldownMs;
  if (cooldownMs <= 0) return false;
  const cutoff = new Date(nowMs - cooldownMs).toISOString();
  return Boolean(db.prepare(`
    SELECT 1
    FROM lark_messages
    WHERE chat_id = ?
      AND (mentioned = 1 OR reply_trigger = 'spontaneous')
      AND received_at >= ?
      AND codex_status IN ('queued', 'running', 'answered', 'no_reply')
    LIMIT 1
  `).get(chatId, cutoff));
}

function validReactionEmoji(selected: string): string {
  return isLarkReactionEmojiType(selected) ? selected : defaultLarkAcknowledgeReactionEmoji;
}

export function groupMessageReactionEmoji(event: LarkEvent, active = config.runtimeMode === "active"): string | null {
  const settings = getAppSettings();
  if (!active || !settings.larkGroupMessageReactionEnabled || event.chat_type !== "group" || typeof event.chat_id !== "string" || !settings.larkGroupMessageReactionChatIds.includes(event.chat_id)) return null;
  return validReactionEmoji(settings.larkGroupMessageReactionEmoji);
}

function reactToMessage(messageId: string, emojiType: string): { ok: true } | { ok: false; error: string } {
  return larkReactionSender(messageId, emojiType);
}

type LarkMessageSnapshot = {
  message_id?: string;
  msg_type?: string;
  message_type?: string;
  content?: string;
  reply_to?: string;
};

type LarkReplyContext = {
  replyToMessageId: string | null;
  replyToMessageType: string | null;
  replyToContent: string | null;
  replyToRawJson: string | null;
};

function firstFetchedMessage(stdout: string): LarkMessageSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { messages?: unknown } };
    const messages = parsed.data?.messages;
    return Array.isArray(messages) && messages[0] && typeof messages[0] === "object" ? messages[0] as LarkMessageSnapshot : null;
  } catch {
    return null;
  }
}

function fetchLarkMessage(messageId: string): LarkMessageSnapshot | null {
  const result = spawnSync("lark-cli", ["im", "+messages-mget", "--as", "bot", "--message-ids", messageId, "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.warn(`Unable to fetch Lark message ${messageId}: ${(result.stderr || result.stdout).trim()}`);
    return null;
  }
  return firstFetchedMessage(result.stdout);
}

function resolveReplyContext(messageId: string | null, eventReplyToId: string | null): LarkReplyContext {
  if (!messageId) {
    return { replyToMessageId: null, replyToMessageType: null, replyToContent: null, replyToRawJson: null };
  }
  const replyToMessageId = eventReplyToId ?? stringValue(fetchLarkMessage(messageId)?.reply_to);
  if (!replyToMessageId) {
    return { replyToMessageId: null, replyToMessageType: null, replyToContent: null, replyToRawJson: null };
  }
  const repliedMessage = fetchLarkMessage(replyToMessageId);
  const local = db.prepare("SELECT message_type,content,raw_json FROM lark_messages WHERE message_id=?").get(replyToMessageId) as { message_type: string | null; content: string | null; raw_json: string } | undefined;
  const remoteContent = stringValue(repliedMessage?.content);
  const localContent = local?.content ?? null;
  const replyToContent = imageKeysFromContent(localContent).length > imageKeysFromContent(remoteContent).length
    ? localContent : remoteContent ?? localContent;
  return {
    replyToMessageId,
    replyToMessageType: stringValue(repliedMessage?.msg_type) ?? stringValue(repliedMessage?.message_type) ?? local?.message_type ?? null,
    replyToContent,
    replyToRawJson: repliedMessage ? JSON.stringify(repliedMessage) : local?.raw_json ?? null
  };
}

function persistLarkEvent(event: LarkEvent): void {
  const eventId = stringValue(event.event_id);
  const messageId = stringValue(event.message_id) ?? stringValue(event.id);
  const directlyMentioned = isAtMeMessage(event);
  const chatId = stringValue(event.chat_id);
  const rootMessageId = stringValue(event.root_id);
  const threadId = stringValue(event.thread_id);
  const spontaneous = shouldStartSpontaneousLarkReply(event, directlyMentioned, hasRecentHandledLarkMessage(chatId));
  const replyContext = resolveReplyContext(messageId, stringValue(event.reply_to));
  const externallyRouted = externalMessageHandler?.({ ...event, reply_to: replyContext.replyToMessageId }) ?? false;
  const shouldRespond = !externallyRouted && config.runtimeMode === "active" && (directlyMentioned || spontaneous);
  const replyTrigger = spontaneous ? "spontaneous" : event.chat_type === "p2p" ? "p2p" : directlyMentioned ? "mention" : "none";
  upsertLarkContactsFromMentions(eventMentions(event));
  let replyStatus = shouldRespond ? "pending" : "skipped";
  let replyError: string | null = null;

  if (shouldRespond && !messageId) {
    replyStatus = "failed";
    replyError = "Missing message_id for Lark reply";
  }

  const receivedAt = nowIso();
  const messageAt = eventMessageAt(event, receivedAt);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, sender_type, direction, message_type, content, message_at,
      reply_to_message_id, root_message_id, thread_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_trigger, reply_status, reply_error, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    messageId,
    chatId,
    stringValue(event.chat_type),
    stringValue(event.sender_id),
    stringValue(event.sender_type) ?? "user",
    stringValue(event.message_type),
    stringValue(event.content),
    messageAt,
    replyContext.replyToMessageId,
    rootMessageId,
    threadId,
    replyContext.replyToMessageType,
    replyContext.replyToContent,
    replyContext.replyToRawJson,
    directlyMentioned ? 1 : 0,
    replyTrigger,
    replyStatus,
    replyError,
    JSON.stringify(event),
    receivedAt,
    receivedAt
  );
  if (insert.changes === 0) {
    const keyColumn = messageId ? "message_id" : "event_id";
    const keyValue = messageId ?? eventId;
    if (!keyValue) {
      return;
    }
    const existing = db.prepare(`SELECT reply_status, reply_error FROM lark_messages WHERE ${keyColumn} = ?`).get(keyValue) as { reply_status: string; reply_error: string | null } | undefined;
    replyStatus = existing?.reply_status ?? replyStatus;
    replyError = existing?.reply_error ?? replyError;
    db.prepare(`
      UPDATE lark_messages
      SET event_id = COALESCE(?, event_id),
          chat_id = ?,
          chat_type = ?,
          sender_id = ?,
          sender_type = ?,
          direction = 'inbound',
          message_type = ?,
          content = ?,
          message_at = ?,
          reply_to_message_id = ?,
          root_message_id = COALESCE(?, root_message_id),
          thread_id = COALESCE(?, thread_id),
          reply_to_message_type = ?,
          reply_to_content = ?,
          reply_to_raw_json = ?,
          mentioned = ?,
          reply_trigger = ?,
          reply_status = ?,
          reply_error = ?,
          codex_status = CASE WHEN ? = 1 THEN codex_status ELSE 'skipped' END,
          raw_json = ?,
          received_at = ?
      WHERE ${keyColumn} = ?
    `).run(
      eventId,
      chatId,
      stringValue(event.chat_type),
      stringValue(event.sender_id),
      stringValue(event.sender_type) ?? "user",
      stringValue(event.message_type),
      stringValue(event.content),
      messageAt,
      replyContext.replyToMessageId,
      rootMessageId,
      threadId,
      replyContext.replyToMessageType,
      replyContext.replyToContent,
      replyContext.replyToRawJson,
      directlyMentioned ? 1 : 0,
      replyTrigger,
      replyStatus,
      replyError,
      shouldRespond ? 1 : 0,
      JSON.stringify(event),
      receivedAt,
      keyValue
    );
  }
  if (insert.changes > 0 && messageId) {
    const groupEmoji = groupMessageReactionEmoji(event);
    const reactionEmoji = groupEmoji ?? (directlyMentioned ? validReactionEmoji(getAppSettings().larkAcknowledgeReactionEmoji) : null);
    if (reactionEmoji) {
      const reaction = reactToMessage(messageId, reactionEmoji);
      if (!reaction.ok) {
        console.warn(`Unable to react to Lark group message ${messageId}: ${reaction.error}`);
      }
    }
  }
  if (shouldRespond && insert.changes > 0) {
    const row = db.prepare("SELECT id FROM lark_messages WHERE message_id = ? OR event_id = ? ORDER BY id DESC LIMIT 1").get(messageId, eventId) as { id: number } | undefined;
    if (row) {
      if (!enqueueLarkCodexReply(row.id)) {
        db.prepare("UPDATE lark_messages SET reply_status = 'skipped' WHERE id = ? AND codex_status = 'skipped' AND reply_status = 'pending'").run(row.id);
      }
    }
  }
}

export function ingestLarkEvent(event: Record<string, unknown>): { id: number | null; duplicate: boolean; responded: boolean } {
  const messageId = stringValue(event.message_id) ?? stringValue(event.id);
  const eventId = stringValue(event.event_id);
  const existing = messageId
    ? db.prepare("SELECT id FROM lark_messages WHERE message_id=?").get(messageId) as { id: number } | undefined
    : eventId
      ? db.prepare("SELECT id FROM lark_messages WHERE event_id=?").get(eventId) as { id: number } | undefined
      : undefined;
  persistLarkEvent(event);
  const row = messageId
    ? db.prepare("SELECT id, codex_status FROM lark_messages WHERE message_id=?").get(messageId) as { id: number; codex_status: string } | undefined
    : eventId
      ? db.prepare("SELECT id, codex_status FROM lark_messages WHERE event_id=?").get(eventId) as { id: number; codex_status: string } | undefined
      : undefined;
  return { id: row?.id ?? null, duplicate: Boolean(existing), responded: config.runtimeMode === "active" && Boolean(row && ["queued", "running", "answered", "no_reply"].includes(row.codex_status)) };
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    persistLarkEvent(JSON.parse(trimmed) as LarkEvent);
  } catch (error) {
    console.warn(`Lark message event skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type LarkExecutionApprovalAction = {
  token: string;
  decision: "approve" | "approve-turn" | "reject";
};

export function parseLarkExecutionApprovalAction(event: LarkEvent): LarkExecutionApprovalAction | null {
  if (event.action_tag !== "button") {
    return null;
  }
  let value: unknown = event.action_value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = stringValue((value as Record<string, unknown>).action);
  const token = stringValue((value as Record<string, unknown>).approval_token);
  if (!token || (action !== "approve" && action !== "approve-turn" && action !== "reject")) {
    return null;
  }
  return { token, decision: action };
}

function handleApprovalLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const event = JSON.parse(trimmed) as LarkEvent;
    const action = parseLarkExecutionApprovalAction(event);
    if (!action) {
      if (additionalApprovalHandler?.(event)) return;
      console.warn("Lark approval callback skipped: unsupported card action");
      return;
    }
    const operatorId = stringValue(event.operator_id);
    const messageId = stringValue(event.message_id);
    if (!operatorId || !messageId) {
      console.warn("Lark approval callback skipped: missing operator_id or message_id");
      return;
    }
    const result = decideLarkExecutionApprovalFromCard({
      token: action.token,
      decision: action.decision,
      operatorId,
      messageId
    });
    if (!result.ok) {
      console.warn(`Lark approval callback rejected: ${result.status}`);
    }
  } catch (error) {
    console.warn(`Lark approval callback skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function setAdditionalLarkApprovalHandler(handler: ((event: LarkEvent) => boolean) | null): void {
  additionalApprovalHandler = handler;
}

listeners.message = {
  command: messageConsumeCommand,
  label: "message",
  consumer: null,
  stdoutBuffer: "",
  restartTimer: undefined,
  handleLine
};
listeners.approval = {
  command: approvalConsumeCommand,
  label: "approval",
  consumer: null,
  stdoutBuffer: "",
  restartTimer: undefined,
  handleLine: handleApprovalLine
};

function scheduleRestart(kind: ListenerKind): void {
  const listener = listeners[kind];
  if (intentionallyStopped || !getAppSettings().larkMessageListenerEnabled || listener.restartTimer) {
    return;
  }
  listener.restartTimer = setTimeout(() => {
    listener.restartTimer = undefined;
    startListener(kind);
  }, 5000);
}

function startListener(kind: ListenerKind): void {
  const listener = listeners[kind];
  if (listener.consumer || intentionallyStopped || !getAppSettings().larkMessageListenerEnabled) {
    return;
  }
  listener.stdoutBuffer = "";
  // A login shell rewrites PATH on macOS, silently bypassing our pinned CLI.
  const child = spawn("sh", ["-c", listener.command], {
    cwd: process.cwd(),
    detached: true,
    env: process.env
  });
  listener.consumer = child;
  console.log(`Started Lark ${listener.label} listener: ${listener.command}`);

  child.stdout.on("data", (chunk: Buffer) => {
    listener.stdoutBuffer += chunk.toString();
    const lines = listener.stdoutBuffer.split(/\r?\n/);
    listener.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      listener.handleLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn(`Lark ${listener.label} listener: ${text}`);
    }
  });
  child.on("error", (error) => {
    console.warn(`Lark ${listener.label} listener failed: ${error.message}`);
  });
  child.on("close", (code) => {
    console.warn(`Lark ${listener.label} listener exited with code ${code}`);
    if (listener.consumer === child) {
      listener.consumer = null;
    }
    scheduleRestart(kind);
  });
}

export function startLarkMessageWorker(): void {
  if (!getAppSettings().larkMessageListenerEnabled) {
    return;
  }
  if (process.env.LARK_MESSAGE_LISTENER_RUNTIME === "false") {
    console.warn("Lark message listener runtime is disabled by LARK_MESSAGE_LISTENER_RUNTIME=false");
    return;
  }
  cleanupStaleConsumers();
  const contactBackfill = backfillLarkContactsFromMessageMentions();
  if (contactBackfill.upserted > 0) {
    console.log(`Discovered ${contactBackfill.upserted} Lark contact mentions from ${contactBackfill.scanned} stored messages`);
  }
  intentionallyStopped = false;
  startListener("message");
  startListener("approval");
}

export function startMigratedMessageListener(): void {
  cleanupStaleConsumers();
  intentionallyStopped = false;
  startListener("message");
}

export function stopMigratedMessageListener(): void {
  const listener = listeners.message;
  if (listener.restartTimer) { clearTimeout(listener.restartTimer); listener.restartTimer = undefined; }
  listener.consumer?.kill("SIGTERM");
  listener.consumer = null;
}

export function migratedMessageListenerRunning(): boolean { return Boolean(listeners.message.consumer); }

export function stopLarkMessageWorker(): void {
  intentionallyStopped = true;
  for (const listener of Object.values(listeners)) {
    if (listener.restartTimer) {
      clearTimeout(listener.restartTimer);
      listener.restartTimer = undefined;
    }
    if (!listener.consumer) {
      continue;
    }
    if (listener.consumer.pid) {
      try {
        process.kill(-listener.consumer.pid, "SIGTERM");
      } catch {
        listener.consumer.kill("SIGTERM");
      }
    } else {
      listener.consumer.kill("SIGTERM");
    }
    listener.consumer = null;
  }
}

export function reconcileLarkMessageWorker(): void {
  if (getAppSettings().larkMessageListenerEnabled) {
    startLarkMessageWorker();
  } else {
    stopLarkMessageWorker();
  }
}

export function larkMessageWorkerStatus(): {
  enabled: boolean;
  running: boolean;
  command: string;
  approvalRunning: boolean;
  approvalCommand: string;
  acknowledgeReactionEmoji: string;
  acknowledgeReactionOptions: string[];
} {
  return {
    enabled: getAppSettings().larkMessageListenerEnabled,
    running: Boolean(listeners.message.consumer) && Boolean(listeners.approval.consumer),
    command: messageConsumeCommand,
    approvalRunning: Boolean(listeners.approval.consumer),
    approvalCommand: approvalConsumeCommand,
    acknowledgeReactionEmoji: getAppSettings().larkAcknowledgeReactionEmoji,
    acknowledgeReactionOptions: larkReactionEmojiTypes
  };
}
