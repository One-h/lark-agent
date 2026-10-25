import type Database from "better-sqlite3";
import { sendLarkTextReply, sendLarkMediaReply, sendLarkReaction, type LarkSentMessage } from "@lark-agent/adapter-lark-cli";

export type LarkStickerRow = {
  id: string;
  name: string;
  description: string;
  tags: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  source_url: string | null;
  source_site: string | null;
  content_hash: string | null;
  enabled: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
export type LarkContactRow = {
  open_id: string;
  user_id: string | null;
  name: string;
  aliases: string;
  enterprise_email: string | null;
  department: string | null;
  p2p_chat_id: string | null;
  is_activated: number;
  is_cross_tenant: number;
  has_chatted: number;
  source: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};
export type LarkMessageRow = Record<string, unknown> & { id: number; event_id: string | null; message_id: string | null; chat_id: string | null; chat_type: string | null; sender_id: string | null; sender_type: string | null; recipient_id: string | null; direction: "inbound" | "outbound"; message_type: string | null; content: string | null; message_at: string; outbound_source: string | null; reply_to_message_id: string | null; root_message_id: string | null; thread_id: string | null; reply_to_message_type: string | null; reply_to_content: string | null; reply_to_raw_json: string | null; mentioned: number; reply_trigger: "none" | "p2p" | "mention" | "spontaneous"; reply_status: string; reply_error: string | null; reply_delivery_key: string | null; reply_delivery_text: string | null; reply_delivery_attempts: number; reply_next_attempt_at: string | null; reply_sent_at: string | null; codex_status: "skipped" | "queued" | "running" | "answered" | "no_reply" | "failed" | "timeout"; codex_reply: string | null; codex_error: string | null; codex_session_id: string | null; codex_turn_id: string | null; codex_last_heartbeat_at: string | null; codex_runner_generation: string | null; codex_task_dir: string | null; codex_started_at: string | null; codex_finished_at: string | null; raw_json: string; received_at: string; created_at: string };
export type LarkCodexSessionRow = { session_key: string; chat_id: string; trust_scope: "trusted" | "untrusted"; codex_session_id: string; created_at: string; updated_at: string };
export type LarkExecutionApprovalRow = { id: number; token: string; lark_message_id: number; requester_id: string | null; approver_id: string; request_method: string; server_request_id: string; thread_id: string; turn_id: string; item_id: string; operation: string | null; cwd: string | null; reason: string | null; status: "pending" | "approved" | "rejected" | "expired" | "failed"; approval_scope: "once" | "turn"; card_message_id: string | null; card_error: string | null; created_at: string; expires_at: string; decided_at: string | null };

export const config = { runtimeMode: "shadow" as "shadow" | "active", workspaceRoot: "", larkStickerDirectory: "", repoRoot: "", taskOutputDir: "", larkAgentRuntimeUrl: "", larkAgentRuntimeToken: "", larkGroupSpontaneousReplyCooldownMs: 600_000, larkGroupSpontaneousReplyRate: 0.08, larkCodexInterimReplyDelayMs: 30_000, larkCodexMaxInterimReplies: 1, larkCodexModel: "gpt-5.6-terra", larkCodexOrphanRecoveryMs: 120_000, larkCodexReasoningEffort: "low", larkCodexStartupStallMs: 60_000, larkCodexStreamReplyMinIntervalMs: 15_000, larkExecutionApproverId: "", larkRecentMessageContextMaxChars: 6000, larkRecentMessageFetchLimit: 50, trustedLarkCodexSenderIds: [] as string[] };
export let db: Database.Database;
export type LarkTextReplySender = (messageId: string, text: string, idempotencyKey: string) => LarkSentMessage | { ok: false; error: string };
export type LarkReactionSender = (messageId: string, emojiType: string) => { ok: true } | { ok: false; error: string };
export let larkTextReplySender: LarkTextReplySender = sendLarkTextReply;
export let larkMediaReplySender: typeof sendLarkMediaReply = sendLarkMediaReply;
export let larkReactionSender: LarkReactionSender = sendLarkReaction;

export function configureConversationRuntime(input: { database: Database.Database; mode?: "shadow" | "active"; larkStickerDirectory: string; repoRoot: string; workspaceRoot?: string; taskOutputDir?: string; approverId?: string; trustedSenderIds?: string[]; model?: string; runtimeUrl?: string; runtimeToken?: string; textReplySender?: LarkTextReplySender; mediaReplySender?: typeof sendLarkMediaReply; reactionSender?: LarkReactionSender }): void {
  db = input.database;
  config.runtimeMode = input.mode ?? "shadow";
  config.larkStickerDirectory = input.larkStickerDirectory;
  config.repoRoot = input.repoRoot;
  config.workspaceRoot = input.workspaceRoot ?? input.repoRoot;
  config.taskOutputDir = input.taskOutputDir ?? `${input.repoRoot}/.lark-agent/tasks`;
  config.larkExecutionApproverId = input.approverId ?? "";
  config.trustedLarkCodexSenderIds = input.trustedSenderIds ?? [];
  config.larkCodexModel = input.model ?? config.larkCodexModel;
  config.larkAgentRuntimeUrl = input.runtimeUrl ?? "";
  config.larkAgentRuntimeToken = input.runtimeToken ?? "";
  larkTextReplySender = input.textReplySender ?? sendLarkTextReply;
  larkMediaReplySender = input.mediaReplySender ?? sendLarkMediaReply;
  larkReactionSender = input.reactionSender ?? sendLarkReaction;
}

export function recordOutboundLarkMessage(input: { messageId: string; chatId: string | null; chatType: string | null; recipientId: string | null; content: string; replyToMessageId: string | null; messageAt?: string | null; messageType?: string | null; source: "reply" | "proactive" }): number | null {
  const messageAt = input.messageAt ?? nowIso();
  const parent = input.replyToMessageId
    ? db.prepare("SELECT message_id, root_message_id, thread_id FROM lark_messages WHERE message_id=?").get(input.replyToMessageId) as { message_id: string; root_message_id: string | null; thread_id: string | null } | undefined
    : undefined;
  const rootMessageId = parent?.thread_id ? parent.root_message_id ?? parent.message_id : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO lark_messages (
      message_id, chat_id, chat_type, sender_type, recipient_id, direction, message_type, content,
      message_at, outbound_source, reply_to_message_id, root_message_id, thread_id, mentioned, reply_trigger, reply_status,
      codex_status, raw_json, received_at, created_at
    ) VALUES (?, ?, ?, 'bot', ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, 0, 'none', 'skipped', 'skipped', '{}', ?, ?)
  `).run(input.messageId, input.chatId, input.chatType, input.recipientId, input.messageType ?? "text", input.content, messageAt, input.source, input.replyToMessageId, rootMessageId, parent?.thread_id ?? null, messageAt, nowIso());
  if (result.changes > 0) return Number(result.lastInsertRowid);
  return (db.prepare("SELECT id FROM lark_messages WHERE message_id=?").get(input.messageId) as { id?: number } | undefined)?.id ?? null;
}

export function nowIso(): string { return new Date().toISOString(); }
export function appSettingValue(key: string): string | undefined { return (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value; }
export function setAppSettingValue(key: string, value: string): void { db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, nowIso()); }
export function getAppSettings() {
  return {
    larkMessageListenerEnabled: db ? (db.prepare("SELECT value FROM settings WHERE key='listenerEnabled'").get() as { value?: string } | undefined)?.value !== "false" : true,
    larkGroupSpontaneousRepliesEnabled: db ? (db.prepare("SELECT value FROM settings WHERE key='groupSpontaneousRepliesEnabled'").get() as { value?: string } | undefined)?.value === "true" : false,
    larkGroupSpontaneousChatIds: groupSpontaneousChatIds(),
    larkGroupSpontaneousReplyRate: groupSpontaneousReplyRate(),
    larkGroupSpontaneousReplyCooldownMs: groupSpontaneousReplyCooldownMs(),
    larkAcknowledgeReactionEmoji: db ? (db.prepare("SELECT value FROM settings WHERE key='acknowledgeReactionEmoji'").get() as { value?: string } | undefined)?.value ?? "THUMBSUP" : "THUMBSUP",
    larkGroupMessageReactionEnabled: db ? appSettingValue("groupMessageReactionEnabled") === "true" : false,
    larkGroupMessageReactionEmoji: db ? appSettingValue("groupMessageReactionEmoji") ?? "THUMBSUP" : "THUMBSUP",
    larkGroupMessageReactionChatIds: groupMessageReactionChatIds(),
    larkCodexRepliesEnabled: db ? (db.prepare("SELECT value FROM settings WHERE key='repliesEnabled'").get() as { value?: string } | undefined)?.value !== "false" : true,
    larkCodexInterimRepliesEnabled: db ? appSettingValue("interimRepliesEnabled") !== "false" : true,
    larkCodexModel: configuredLarkCodexModel(),
    larkCodexReasoningEffort: configuredLarkCodexReasoningEffort(),
    larkStickerUsageMode: configuredLarkStickerUsageMode(),
    larkExecutionReceiptsEnabled: db ? appSettingValue("executionReceiptsEnabled") !== "false" : true,
    larkTurnAutoApprovalEnabled: db ? appSettingValue("turnAutoApprovalEnabled") === "true" : false,
    larkGroupContextMaxChars: Number(appSettingValue("groupContextMaxChars") ?? 6000),
    larkGroupContextMessageLimit: Number(appSettingValue("groupContextMessageLimit") ?? 50),
    larkTrustedExecutionEnabled: configuredTrustedExecutionEnabled()
  };
}

export function configuredTrustedExecutionEnabled(): boolean {
  return Boolean(db && appSettingValue("trustedExecutionEnabled") === "true");
}

export function isTrustedLarkSender(senderId: string | null | undefined): boolean {
  return Boolean(configuredTrustedExecutionEnabled() && senderId
    && (senderId === config.larkExecutionApproverId || config.trustedLarkCodexSenderIds.includes(senderId)));
}

export const larkStickerUsageModes = ["off", "explicit", "natural", "always"] as const;
export type LarkStickerUsageMode = typeof larkStickerUsageModes[number];

export type LarkStickerUsageOverride = "global" | LarkStickerUsageMode;

export function configuredLarkStickerUsageMode(chatId?: string | null): LarkStickerUsageMode {
  const conversationMode = chatId && db ? appSettingValue(`conversation.stickerUsageMode:${chatId}`) : undefined;
  if (larkStickerUsageModes.includes(conversationMode as LarkStickerUsageMode)) return conversationMode as LarkStickerUsageMode;
  const stored = db ? appSettingValue("stickerUsageMode") : undefined;
  return larkStickerUsageModes.includes(stored as LarkStickerUsageMode) ? stored as LarkStickerUsageMode : "natural";
}

export function conversationStickerUsageSettings(chatId: string): { mode: LarkStickerUsageOverride; effectiveMode: LarkStickerUsageMode; globalMode: LarkStickerUsageMode } {
  const stored = db ? appSettingValue(`conversation.stickerUsageMode:${chatId}`) : undefined;
  const mode = larkStickerUsageModes.includes(stored as LarkStickerUsageMode) ? stored as LarkStickerUsageMode : "global";
  const globalMode = configuredLarkStickerUsageMode();
  return { mode, effectiveMode: mode === "global" ? globalMode : mode, globalMode };
}

export function setConversationStickerUsageMode(chatId: string, mode: LarkStickerUsageOverride): void {
  if (mode !== "global" && !larkStickerUsageModes.includes(mode)) throw new Error("无效的表情包使用策略");
  setAppSettingValue(`conversation.stickerUsageMode:${chatId}`, mode);
}

export function validLarkCodexModel(value: string): boolean {
  return value.length >= 1 && value.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export function configuredLarkCodexModel(): string {
  const stored = db ? appSettingValue("codexModel")?.trim() : "";
  return stored && validLarkCodexModel(stored) ? stored : config.larkCodexModel;
}

export const larkCodexReasoningEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type LarkCodexReasoningEffort = typeof larkCodexReasoningEfforts[number];

export function configuredLarkCodexReasoningEffort(): LarkCodexReasoningEffort {
  const stored = db ? appSettingValue("codexReasoningEffort") : undefined;
  return larkCodexReasoningEfforts.includes(stored as LarkCodexReasoningEffort)
    ? stored as LarkCodexReasoningEffort
    : larkCodexReasoningEfforts.includes(config.larkCodexReasoningEffort as LarkCodexReasoningEffort)
      ? config.larkCodexReasoningEffort as LarkCodexReasoningEffort
      : "low";
}

export function groupSpontaneousReplyRate(): number {
  const raw = db ? appSettingValue("groupSpontaneousReplyRate") : undefined;
  const rate = raw?.trim() ? Number(raw) : config.larkGroupSpontaneousReplyRate;
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.08;
}

export function groupSpontaneousReplyCooldownMs(): number {
  const raw = db ? appSettingValue("groupSpontaneousReplyCooldownMs") : undefined;
  const value = raw?.trim() ? Number(raw) : config.larkGroupSpontaneousReplyCooldownMs;
  return Number.isInteger(value) && value >= 0 && value <= 604_800_000 ? value : 600_000;
}

export function groupSpontaneousChatIds(): string[] {
  if (!db) return [];
  try {
    const value: unknown = JSON.parse(appSettingValue("groupSpontaneousChatIds") ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^oc_[A-Za-z0-9]+$/.test(id)))] : [];
  } catch {
    return [];
  }
}

export function groupMessageReactionChatIds(): string[] {
  if (!db) return [];
  try {
    const value: unknown = JSON.parse(appSettingValue("groupMessageReactionChatIds") ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^oc_[A-Za-z0-9]+$/.test(id)))] : [];
  } catch {
    return [];
  }
}
export function addLocalAuditEvent(_action: string, _summary: string, _details?: Record<string, unknown>): void { /* Standalone events are persisted by the runtime adapter. */ }
export function larkSenderReplyProfile(senderId: string | null): { replyTone: string } | null {
  if (!senderId) return null;
  const stored = appSettingValue("larkSenderReplyProfiles"); if (!stored) return null;
  try { const profile = (JSON.parse(stored) as Record<string, { replyTone?: unknown }>)[senderId]; return typeof profile?.replyTone === "string" && profile.replyTone.trim() ? { replyTone: profile.replyTone.trim().slice(0, 300) } : null; } catch { return null; }
}
