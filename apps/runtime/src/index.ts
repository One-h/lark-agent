import { GroupPrivacy, registerGroupPrivacyRoutes } from "./groupPrivacy.js";
import { AgentMessaging, registerAgentMessagingRoutes } from "./agentMessaging.js";
import { setExternalMessageHandler } from "@lark-agent/conversation-runtime";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { sendApprovalCard, sendLarkTextMessage, sendLarkTextReply, updateApprovalCard, type LarkSentMessage } from "@lark-agent/adapter-lark-cli";
import { config as conversationConfig, configuredLarkCodexModel, configuredLarkCodexReasoningEffort, configureConversationRuntime, defaultConfigurablePrompt, enqueueLarkCodexReply, ingestLarkEvent, larkCodexAppServerStatus, larkMessageWorkerStatus, listLarkCodexModels, reconcileLarkCodexResponder, reconcileOrphanedLarkCodexRuns, reconcilePendingLarkThreadArchives, recordOutboundLarkMessage, retryPendingLarkExecutionReceipts, retryPendingLarkMediaReplies, retryPendingLarkTextReplies, runLarkHistoryImageMcpTool, runLarkStickerMcpTool, setAdditionalLarkApprovalHandler, startLarkMessageWorker, stopLarkCodexResponder, stopLarkMessageWorker, suppressPendingLarkExecutionReceipts, syncLarkContactsFromCli, type LarkReactionSender, type LarkTextReplySender } from "@lark-agent/conversation-runtime";
import { registerHostOutboundRoutes } from "./outbound.js";
import { PersonalInbox, registerPersonalInboxRoutes } from "./personalInbox.js";
import { createGroupNameCache } from "./groupNames.js";
import { registerPersonaRoutes } from "./personaRoutes.js";
import { registerApprovalHistoryRoutes } from "./approvalHistory.js";
import { replaceStickersFromBundle } from "./stickerBundleImport.js";
import { createLarkAuthProbe, createLarkCliProbe } from "./health.js";
import { ownerMessageAllowed } from "./ownerMessagePolicy.js";
import { parseRuntimeSettingsPatch, runtimeSettingEntries, strictSettingsObject, type RuntimeSettingsPatch } from "./settingsSchema.js";
import { parseLarkExecutionConfigs } from "@lark-agent/conversation-runtime";
import { configuredTrustedExecutionEnabled, isTrustedLarkSender } from "@lark-agent/conversation-runtime";
import { configuredLarkStickerUsageMode, groupMessageReactionChatIds, groupSpontaneousChatIds, groupSpontaneousReplyCooldownMs, groupSpontaneousReplyRate } from "@lark-agent/conversation-runtime";
import { retryPendingLarkCompletionReactions } from "@lark-agent/conversation-runtime";
import { drainLarkProgressCards, retryPendingLarkProgressCards, type LarkProgressSender, type LarkProgressUpdater } from "@lark-agent/conversation-runtime";
import { runLarkAttachmentMcpTool } from "@lark-agent/conversation-runtime";
import { configureOwnerMentionAssist, reconcileOwnerMentionAssists, retryOwnerAssistNotifications, runLarkOwnerAssistMcpTool, ownerAssistMayExecute,
  onOwnerAssistContextChanged, refreshOwnerAssistPolicies, cancelOwnerAssistPendingApprovals, drainOwnerAssistNotifications, activeOwnerAssistRequests, ownerMentionAssistSettings } from "@lark-agent/conversation-runtime";
import { registerOwnerMentionAssistRoutes } from "./ownerMentionAssistRoutes.js";
import { configuredTurnAutoApprovalDataSources } from "@lark-agent/conversation-runtime";
import { topicNativeModeEnabled, resetTopicNativeEnrollmentEpoch } from "@lark-agent/conversation-runtime";
import { approvalTask, deploymentOperationMatchesTask, configureAutoApprovalNotificationSender, retryPendingAutoApprovalNotifications, configureTurnApprovalReviewer, configuredTurnAutoApprovalModel, markTurnAutoApprovalApplied, reviewLarkTurnAutoApproval, type TurnApprovalReviewer, type AutoApprovalNotificationSender } from "@lark-agent/conversation-runtime";
import { onLarkTurnEnded, hasLarkManualTurnApproval, loadApprovalTaskContext, formatApprovalTaskContext, postHostJson, reconcilePendingExecutionTurnApprovals, confirmLarkNativeTurnActive, waitForTurnAuthorization } from "@lark-agent/conversation-runtime";

type ProactiveMessageSender = (recipientId: string, text: string, idempotencyKey: string) => LarkSentMessage | { ok: false; error: string };
export type RuntimeConfig = { databasePath: string; mode: "shadow" | "active"; trustedSenderIds: string[]; approverId?: string; workspaceRoot?: string; hostBaseUrl?: string; hostToken?: string; runtimeToken?: string; host?: string; port?: number; turnActivityProbe?: (messageId: number, turnId: string) => Promise<boolean>; approvalCardSender?: typeof sendApprovalCard; approvalCardUpdater?: typeof updateApprovalCard; textReplySender?: LarkTextReplySender; reactionSender?: LarkReactionSender; proactiveMessageSender?: ProactiveMessageSender; turnApprovalReviewer?: TurnApprovalReviewer; autoApprovalNotificationSender?: AutoApprovalNotificationSender; progressSender?: LarkProgressSender; progressUpdater?: LarkProgressUpdater; ownerMentionAssistMembershipProbe?: (chatId: string, ownerId: string) => Promise<boolean | null>; ownerMentionAssistDelayMs?: number };
type StoredCapability = { id: string; title: string; description: string; input_schema: string; risk: "read" | "local-write" | "external-write" };
type PendingApproval = { resolve: (approved: boolean) => void; timer: NodeJS.Timeout; cleanup: () => void };
type MessageCursor = { messageAt: string; id: number };

const messageSelectColumns = `
  lark_messages.*, sender_contacts.name AS sender_name,
  sender_contacts.enterprise_email AS sender_enterprise_email,
  sender_contacts.department AS sender_department,
  lark_messages.sender_type AS senderType, lark_messages.recipient_id AS recipientId,
  recipient_contacts.name AS recipientName, lark_messages.message_at AS messageAt,
  lark_messages.outbound_source AS outboundSource,
  CASE WHEN COALESCE((SELECT value FROM settings WHERE key='trustedExecutionEnabled'), 'false') = 'true'
    AND (lark_messages.sender_id IN (SELECT value FROM json_each(COALESCE((SELECT value FROM settings WHERE key='trustedSenderIds'), '[]')))
      OR lark_messages.sender_id = COALESCE((SELECT value FROM settings WHERE key='approverId'), ''))
    THEN 'trusted' ELSE 'untrusted' END AS trust_scope
`;
const messageContactJoins = `
  LEFT JOIN lark_contacts sender_contacts ON sender_contacts.open_id=lark_messages.sender_id
  LEFT JOIN lark_contacts recipient_contacts ON recipient_contacts.open_id=lark_messages.recipient_id
`;

function boundedLimit(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(maximum, parsed) : null;
}

function nonNegativeOffset(value: unknown): number | null {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(1_000_000, parsed) : null;
}

function contactIdFromPath(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return /^o[uc]_[A-Za-z0-9]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMessageCursor(value: unknown): MessageCursor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.messageAt !== "string" || Number.isNaN(new Date(parsed.messageAt).getTime()) || !Number.isSafeInteger(parsed.id) || Number(parsed.id) < 1) return null;
    return { messageAt: new Date(parsed.messageAt).toISOString(), id: Number(parsed.id) };
  } catch {
    return null;
  }
}

function textResult(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function artifactMimeType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".gif" ? "image/gif" : extension === ".webp" ? "image/webp" : extension === ".md" ? "text/markdown" : extension === ".html" || extension === ".htm" ? "text/html" : "application/octet-stream";
}
export function capabilityApprovalAction(event: Record<string, unknown>): { id: number; decision: "approve" | "approve-turn" | "reject"; actorId: string; messageId: string } | null {
  const nested = event.event && typeof event.event === "object" ? event.event as Record<string, unknown> : {};
  let value = event.action_value ?? nested.action_value;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const action = value as { approval_id?: unknown; action?: unknown };
  const id = Number(action.approval_id);
  if (!Number.isInteger(id) || id < 1 || !["approve", "approve-turn", "reject"].includes(String(action.action))) return null;
  const operator = event.operator && typeof event.operator === "object" ? event.operator as Record<string, unknown> : nested.operator && typeof nested.operator === "object" ? nested.operator as Record<string, unknown> : {};
  const actorId = typeof event.operator_id === "string" ? event.operator_id : typeof operator.open_id === "string" ? operator.open_id : typeof event.open_id === "string" ? event.open_id : typeof nested.open_id === "string" ? nested.open_id : "";
  const messageId = typeof event.message_id === "string" ? event.message_id : typeof nested.message_id === "string" ? nested.message_id : "";
  if (!actorId || !messageId) return null;
  return { id, decision: action.action as "approve" | "approve-turn" | "reject", actorId, messageId };
}
function messageTaskDirectory(store: SqliteAgentStore, messageId: number): string | null {
  const row = store.db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id=?").get(messageId) as { codex_task_dir?: string | null } | undefined;
  if (!row?.codex_task_dir) return null;
  return path.isAbsolute(row.codex_task_dir) ? row.codex_task_dir : path.resolve(row.codex_task_dir);
}
function messageTaskFile(store: SqliteAgentStore, messageId: number, name: string): string | null {
  const directory = messageTaskDirectory(store, messageId); if (!directory) return null;
  const file = path.resolve(directory, name); if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}
function messageImages(store: SqliteAgentStore, messageId: number) {
  const directory = messageTaskDirectory(store, messageId); const text = messageTaskFile(store, messageId, "referenced-images.json"); if (!directory || !text) return [];
  try { return (JSON.parse(text) as string[]).flatMap((item) => { const file = path.isAbsolute(item) ? item : path.resolve(directory, item); if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !existsSync(file)) return []; const bytes = readFileSync(file); const mimeType = artifactMimeType(file); return [{ name: path.basename(file), path: file, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` }]; }); } catch { return []; }
}
function messageFiles(store: SqliteAgentStore, messageId: number) {
  const directory = messageTaskDirectory(store, messageId); const text = messageTaskFile(store, messageId, "referenced-files.json"); if (!directory || !text) return [];
  try { return (JSON.parse(text) as Array<{ name: string; path: string; mimeType?: string; size?: number; text: string }>).flatMap((item) => { const file = path.isAbsolute(item.path) ? item.path : path.resolve(directory, item.path); if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !existsSync(file)) return []; return [{ name: item.name, path: file, mimeType: item.mimeType ?? "text/plain", size: item.size ?? readFileSync(file).byteLength, text: item.text }]; }); } catch { return []; }
}

export function createRuntime(config: RuntimeConfig) {
  const app = Fastify({ logger: true });
  const probeLarkCli = createLarkCliProbe();
  const probeLarkAuth = createLarkAuthProbe();
  const store = new SqliteAgentStore(config.databasePath);
  let stickerImportRunning = false;
  const groupNames = createGroupNameCache(store);
  app.addHook("onClose", async () => { groupNames.stop(); await groupNames.wait(); });
  let workspaceRoot = store.setting("workspaceRoot", "").trim() || config.workspaceRoot || process.cwd();
  const runtimeUrl = `http://127.0.0.1:${config.port ?? 4780}`;
  // Bot-only installs can stage attachments without creating host credentials.
  // The fallback is process-local and never authorizes host capability routes.
  const attachmentRuntimeToken = config.runtimeToken || randomBytes(32).toString("base64url");
  const dataDirectory = path.resolve(path.dirname(config.databasePath));
  const storedTrusted = store.db.prepare("SELECT value FROM settings WHERE key='trustedSenderIds'").get() as { value?: string } | undefined;
  let initialTrustedSenderIds = config.trustedSenderIds;
  if (storedTrusted?.value) {
    try {
      const parsed = JSON.parse(storedTrusted.value) as unknown;
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) initialTrustedSenderIds = parsed as string[];
    } catch { /* Invalid persisted values fall back to deployment defaults. */ }
  }
  const storedApprover = store.db.prepare("SELECT value FROM settings WHERE key='approverId'").get() as { value?: string } | undefined;
  let approverId = storedApprover ? storedApprover.value?.trim() || undefined : config.approverId;
  const trustedSenderIds = new Set(initialTrustedSenderIds);
  if (!storedTrusted) store.setSetting("trustedSenderIds", JSON.stringify([...trustedSenderIds]));
  if (!storedApprover && approverId) store.setSetting("approverId", approverId);
  configureConversationRuntime({ database: store.db, groupPrivacyEnforced: store.setting("groupPrivacy.enabled", "false") === "true", mode: config.mode, larkStickerDirectory: path.join(dataDirectory, "stickers"), repoRoot: process.cwd(), workspaceRoot, taskOutputDir: path.join(dataDirectory, "tasks"), approverId, trustedSenderIds: [...trustedSenderIds], runtimeUrl, runtimeToken: attachmentRuntimeToken, textReplySender: config.textReplySender, reactionSender: config.reactionSender, progressSender: config.progressSender, progressUpdater: config.progressUpdater });
  configureTurnApprovalReviewer(config.turnApprovalReviewer);
  configureOwnerMentionAssist({ membershipProbe: config.ownerMentionAssistMembershipProbe, privateSender: config.proactiveMessageSender, delayMs: config.ownerMentionAssistDelayMs, reviewAvailable: Boolean(config.runtimeToken) });
  configureAutoApprovalNotificationSender(config.autoApprovalNotificationSender);
  store.registerCapabilities([{ id: "lark.message.send", title: "发送飞书消息", description: "Send a bot text message to a known Lark contact. Input requires recipient (name, alias, or open_id) and text.", inputSchema: { type: "object", properties: { recipient: { type: "string" }, text: { type: "string" } }, required: ["recipient", "text"] }, risk: "external-write" }]);
  reconcileLarkCodexResponder();
  reconcileOwnerMentionAssists();
  const pendingApprovals = new Map<number, PendingApproval>();
  const authorizations = new Set<{ turnId: string; messageId: number; controller: AbortController; started: boolean }>();
  const removeOwnerContextListener = onOwnerAssistContextChanged(messageId => {
    cancelOwnerAssistPendingApprovals(messageId);
    for (const call of authorizations) if (call.messageId === messageId && !call.started) call.controller.abort();
  });
  app.addHook("onClose", async () => { removeOwnerContextListener(); });
  let activeCapabilityCalls = 0;
  let listener: { stop(): void; running(): boolean } | null = null;

  const capabilities = (): StoredCapability[] => store.db.prepare("SELECT id, title, description, input_schema, risk FROM capabilities ORDER BY id").all() as StoredCapability[];
  const liveTurn = (messageId: number, turnId: string) => {
    const row = store.db.prepare("SELECT codex_status,codex_turn_id FROM lark_messages WHERE id=?").get(messageId) as { codex_status: string; codex_turn_id: string } | undefined;
    return row?.codex_status === "running" && row.codex_turn_id === turnId;
  };
  const confirmTurn = async (messageId: number, turnId: string) => {
    if (!liveTurn(messageId, turnId)) return false;
    const row = store.db.prepare("SELECT codex_session_id FROM lark_messages WHERE id=?").get(messageId) as { codex_session_id: string | null };
    // Native-backed calls must also survive an independent native status read.
    const active = config.turnActivityProbe ? await config.turnActivityProbe(messageId, turnId)
      : Boolean(row.codex_session_id && await confirmLarkNativeTurnActive(row.codex_session_id, turnId));
    return active && liveTurn(messageId, turnId);
  };
  const approvalDetails = (messageId: number, operation: string) => {
    const source = store.db.prepare("SELECT m.content,m.sender_id,c.name FROM lark_messages m LEFT JOIN contacts c ON c.open_id=m.sender_id WHERE m.id=?").get(messageId) as { content?: string; sender_id?: string; name?: string } | undefined;
    return { operation, originalMessage: source?.content ?? "", requester: source?.name ?? source?.sender_id ?? "未知发送人", cwd: workspaceRoot,
      taskContext: formatApprovalTaskContext(loadApprovalTaskContext(store.db, messageId, source?.sender_id ?? null)) };
  };
  const approvalIdentityMatches = (row: NonNullable<ReturnType<typeof store.approval>>) => {
    const source = store.db.prepare("SELECT sender_id,codex_session_id FROM lark_messages WHERE id=?").get(row.lark_message_id) as { sender_id: string; codex_session_id: string | null } | undefined;
    return source?.sender_id === row.requester_id && source?.codex_session_id === row.thread_id;
  };
  const settleApproval = (id: number, status: "approved" | "rejected" | "expired" | "failed", scope: "once" | "turn" = "once", reason: string | null = null) => {
    const row = store.approval(id);
    if (row && status === "approved" && !ownerAssistMayExecute(row.lark_message_id)) { status = "failed"; reason = "协同上下文或配置已变化，未放行操作。"; }
    if (!row || !store.db.prepare("UPDATE lark_capability_approvals SET status=?,approval_scope=?,error=?,decided_at=? WHERE id=? AND status='pending'")
      .run(status, scope, reason, new Date().toISOString(), id).changes) return false;
    const pending = pendingApprovals.get(id);
    if (pending) { clearTimeout(pending.timer); pending.cleanup(); pendingApprovals.delete(id); pending.resolve(status === "approved"); }
    if (row.card_message_id) {
      try { (config.approvalCardUpdater ?? updateApprovalCard)(row.card_message_id, { ...approvalDetails(row.lark_message_id, row.operation), status, approvalScope: scope, decidedAt: new Date().toISOString(), reason }); }
      catch { app.log.warn("capability_approval_card_update_failed"); }
    }
    return true;
  };
  const awaitApproval = async (input: { messageId: number; turnId: string; capabilityId?: string; operation: string; originalMessage?: string }, signal: AbortSignal): Promise<boolean> => {
    if (!approverId || signal.aborted || !liveTurn(input.messageId, input.turnId)) return false;
    const approvalId = store.createApproval({ larkMessageId: input.messageId, turnId: input.turnId, capabilityId: input.capabilityId, operation: input.operation, approverId, expiresAt: new Date(Date.now() + 600000).toISOString() });
    const result = new Promise<boolean>(resolve => {
      const abort = () => settleApproval(approvalId, "failed", "once", "会话已结束或调用已断开，操作未执行。");
      const timer = setTimeout(() => settleApproval(approvalId, "expired"), 600000);
      signal.addEventListener("abort", abort, { once: true });
      pendingApprovals.set(approvalId, { resolve, timer, cleanup: () => signal.removeEventListener("abort", abort) });
    });
    try {
      const card = (config.approvalCardSender ?? sendApprovalCard)(approverId, { approvalId, ...approvalDetails(input.messageId, input.operation), reason: "仅在本 turn 仍有效时执行；批准不代表操作已完成。" });
      if (card.ok && card.messageId) store.setApprovalCardMessage(approvalId, card.messageId);
      else settleApproval(approvalId, "failed", "once", "审批卡未取得发送回执，操作未执行。");
    } catch { settleApproval(approvalId, "failed", "once", "审批卡发送失败，操作未执行。"); }
    return result;
  };
  const expirePendingApprovals = () => {
    const rows = store.db.prepare("SELECT * FROM lark_capability_approvals WHERE status='pending'").all() as ReturnType<typeof store.approval>[];
    for (const row of rows) {
      if (!row) continue;
      if (!pendingApprovals.has(row.id) || !liveTurn(row.lark_message_id, row.turn_id ?? "") || !approvalIdentityMatches(row) || row.approver_id !== approverId)
        settleApproval(row.id, "failed", "once", "对应会话或审批等待已结束，操作未执行。");
      else if (Date.parse(row.expires_at) <= Date.now()) settleApproval(row.id, "expired");
      else {
        const source = store.db.prepare("SELECT sender_id FROM lark_messages WHERE id=?").get(row.lark_message_id) as { sender_id: string };
        if (hasLarkManualTurnApproval(store.db, { turnId: row.turn_id!, threadId: row.thread_id, senderId: source.sender_id, approverId })) settleApproval(row.id, "approved", "turn");
      }
    }
    reconcilePendingExecutionTurnApprovals();
  };
  const decide = async (id: number, decision: "approve" | "approve-turn" | "reject", actorId?: string, messageId?: string) => {
    const row = store.approval(id);
    if (!row || row.status !== "pending" || (actorId && (actorId !== row.approver_id || messageId !== row.card_message_id))) return { ok: false };
    if (!await confirmTurn(row.lark_message_id, row.turn_id ?? "")) {
      settleApproval(id, "failed", "once", "无法确认原生会话仍在执行，操作未执行。"); return { ok: false };
    }
    if (!pendingApprovals.has(id) || !liveTurn(row.lark_message_id, row.turn_id ?? "") || !approvalIdentityMatches(row) || row.approver_id !== approverId) {
      settleApproval(id, "failed", "once", "对应会话或审批等待已结束，操作未执行。"); return { ok: false };
    }
    if (Date.parse(row.expires_at) <= Date.now()) { settleApproval(id, "expired"); return { ok: false }; }
    const ok = settleApproval(id, decision === "reject" ? "rejected" : "approved", decision === "approve-turn" ? "turn" : "once");
    if (ok && decision === "approve-turn") expirePendingApprovals();
    return { ok };
  };
  const removeTurnListener = onLarkTurnEnded(store.db, turnId => {
    for (const call of authorizations) if (call.turnId === turnId && !call.started) call.controller.abort();
  });
  app.addHook("preClose", async () => {
    stopListener();
    for (const call of authorizations) if (!call.started) call.controller.abort();
    for (const id of [...pendingApprovals.keys()]) settleApproval(id, "failed", "once", "服务已关闭，操作未执行。");
    while (activeCapabilityCalls > 0) await new Promise(resolve => setTimeout(resolve, 20));
    stopLarkCodexResponder();
    await drainLarkProgressCards();
    await drainOwnerAssistNotifications();
    removeTurnListener();
  });
  const decideApprovalFromCard = (event: Record<string, unknown>) => {
    const action = capabilityApprovalAction(event);
    return action ? decide(action.id, action.decision, action.actorId, action.messageId) : Promise.resolve({ ok: false });
  };
  setAdditionalLarkApprovalHandler((event) => {
    if (!capabilityApprovalAction(event)) return false;
    void decideApprovalFromCard(event);
    return true;
  });
  const invokeHost = async (capability: StoredCapability, input: unknown, context: Record<string, unknown>): Promise<unknown> => {
    if (capability.id === "lark.message.send") {
      const payload = input && typeof input === "object" ? input as { recipient?: unknown; text?: unknown } : {};
      const recipient = typeof payload.recipient === "string" ? payload.recipient.trim() : "";
      const message = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!recipient || !message) throw new Error("recipient and text are required");
      const contact = recipient.startsWith("ou_")
        ? store.db.prepare("SELECT open_id, name, p2p_chat_id FROM contacts WHERE open_id=?").get(recipient) as { open_id: string; name: string; p2p_chat_id: string | null } | undefined
        : store.db.prepare("SELECT contacts.open_id, contacts.name, contacts.p2p_chat_id FROM contacts LEFT JOIN contact_aliases ON contact_aliases.open_id=contacts.open_id WHERE contacts.name=? OR contact_aliases.alias=? ORDER BY contacts.has_chatted DESC, contacts.updated_at DESC LIMIT 1").get(recipient, recipient) as { open_id: string; name: string; p2p_chat_id: string | null } | undefined;
      if (!contact) throw new Error(`Lark contact not found: ${recipient}`);
      const idempotencyKey = `lag-contact-${createHash("sha1").update(`${contact.open_id}:${message}`).digest("hex").slice(0, 24)}`;
      const sent = (config.proactiveMessageSender ?? sendLarkTextMessage)(contact.open_id, message, idempotencyKey);
      if (!sent.ok) throw new Error(sent.error);
      if (sent.messageId) {
        try {
          recordOutboundLarkMessage({ messageId: sent.messageId, chatId: sent.chatId ?? contact.p2p_chat_id, chatType: "p2p", recipientId: contact.open_id, content: message, replyToMessageId: null, messageAt: sent.messageAt, messageType: sent.messageType, source: "proactive" });
        } catch (error) {
          app.log.error(`lark_outbound_record_failed source=proactive recipientId=${contact.open_id} platformMessageId=${sent.messageId} error=${error instanceof Error ? error.message : String(error)}`);
        }
      }
      else app.log.warn(`lark_outbound_record_skipped source=proactive recipientId=${contact.open_id} reason=missing_platform_message_id`);
      return { sent: true, recipient: contact.name, messageId: sent.messageId, _receipt: { status: sent.messageId ? "verified" : "executed", summary: sent.messageId ? `已向 ${contact.name} 发送飞书消息。` : `已向 ${contact.name} 提交飞书消息发送。`, evidence: sent.messageId ? [`message_id: ${sent.messageId}`] : [] } };
    }
    if (!config.hostBaseUrl) throw new Error("Host integration is not configured");
    const response = await postHostJson(`${config.hostBaseUrl.replace(/\/$/, "")}/api/lark-agent/capabilities/${encodeURIComponent(capability.id)}`, { input, context }, config.hostToken ? { authorization: `Bearer ${config.hostToken}` } : {});
    const body = response.body;
    if (!response.ok) throw new Error(body || `Host returned HTTP ${response.status}`);
    try { return JSON.parse(body); } catch { return body; }
  };
  const executeCapabilityInternal = async (id: string, input: unknown, context: { larkMessageId?: unknown; chatId?: unknown; trustScope?: unknown; turnId?: unknown; callId?: unknown }, requestSignal?: AbortSignal): Promise<unknown> => {
    const capability = capabilities().find((entry) => entry.id === id);
    if (!capability) throw new Error("Capability is not registered");
    const larkMessageId = Number(context.larkMessageId);
    const message = Number.isInteger(larkMessageId) && typeof context.chatId === "string"
      ? store.db.prepare("SELECT chat_id, chat_type, sender_id, content, codex_session_id, codex_turn_id, codex_status, message_type, sender_type, direction FROM lark_messages WHERE id=?").get(larkMessageId) as { chat_id?: string | null; chat_type?: string | null; sender_id?: string | null; content?: string; codex_session_id?: string | null; codex_turn_id?: string | null; codex_status?: string; message_type?: string; sender_type?: string; direction?: string } | undefined
      : undefined;
    if (!message || message.chat_id !== context.chatId) throw new Error("Invalid capability context");
    if (!ownerAssistMayExecute(larkMessageId)) throw new Error("Owner assistance has not accepted this request; publishing a draft does not authorize execution");
    if (message.chat_type === "group" && conversationConfig.groupPrivacyEnforced) throw new Error("群消息不能调用旧宿主能力；请使用群聊隐私单次审批。");
    const expectedScope = isTrustedLarkSender(message.sender_id) ? "trusted" : "untrusted";
    if (context.trustScope !== expectedScope) throw new Error("Capability trust scope does not match the current sender");
    const turnId = typeof context.turnId === "string" && context.turnId ? context.turnId : message.codex_turn_id ?? `capability:${id}`;
    const inputHash = createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
    const createdAt = new Date().toISOString();
    const inserted = store.db.prepare("INSERT OR IGNORE INTO lark_capability_invocations (lark_message_id, turn_id, capability_id, input_hash, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)").run(larkMessageId, turnId, id, inputHash, createdAt);
    if (inserted.changes === 0) {
      const existing = store.db.prepare("SELECT status, result_json, error FROM lark_capability_invocations WHERE turn_id=? AND capability_id=? AND input_hash=?").get(turnId, id, inputHash) as { status: string; result_json: string | null; error: string | null };
      if (existing.status === "completed") return JSON.parse(existing.result_json ?? "null");
      if (existing.status === "failed") throw new Error(existing.error ?? "Previous capability invocation failed");
      throw new Error("The same capability invocation is already running in this turn");
    }
    const approvalRequired = capability.risk === "external-write" || (capability.risk === "local-write" && expectedScope !== "trusted");
    const call = { turnId, messageId: larkMessageId, controller: new AbortController(), started: false };
    authorizations.add(call);
    const signal = requestSignal ? AbortSignal.any([requestSignal, call.controller.signal]) : call.controller.signal;
    const cancelled = () => {
      if (!call.started && store.db.open) store.db.prepare("UPDATE lark_capability_invocations SET status='failed',error=?,finished_at=? WHERE turn_id=? AND capability_id=? AND input_hash=? AND status='running'")
        .run("授权等待已取消，操作未执行。", new Date().toISOString(), turnId, id, inputHash);
    };
    signal.addEventListener("abort", cancelled, { once: true });
    const assertActive = () => {
      if (!ownerAssistMayExecute(larkMessageId)) throw new Error("协同上下文或开关已变化，未放行新的操作。");
      if (signal.aborted || !liveTurn(larkMessageId, turnId)) throw new Error("会话已结束、turn 已变化或调用已断开，未开始新的操作。");
      const current = store.db.prepare("SELECT sender_id,chat_id,codex_session_id FROM lark_messages WHERE id=?").get(larkMessageId) as { sender_id: string; chat_id: string; codex_session_id: string | null };
      if (current.sender_id !== message.sender_id || current.chat_id !== context.chatId || current.codex_session_id !== message.codex_session_id || (isTrustedLarkSender(current.sender_id) ? "trusted" : "untrusted") !== expectedScope)
        throw new Error("Capability identity changed while awaiting authorization");
    };
    try {
      assertActive();
      let ownerMessageApproved = false;
      if (id === "lark.message.send" && message.codex_status === "running" && message.codex_turn_id === turnId) {
        const payload = input as { recipient?: unknown; text?: unknown } | null;
        if (payload && typeof payload.recipient === "string" && typeof payload.text === "string") {
          const recipient = payload.recipient.trim();
          const matches = store.db.prepare(`SELECT DISTINCT contacts.open_id, contacts.name, contacts.is_activated, contacts.is_cross_tenant
            FROM contacts LEFT JOIN contact_aliases ON contact_aliases.open_id=contacts.open_id
            WHERE contacts.open_id=? OR contacts.name=? OR contact_aliases.alias=?`).all(recipient, recipient, recipient) as Array<{ open_id: string; name: string; is_activated: number; is_cross_tenant: number }>;
          const contact = matches.length === 1 ? matches[0] : undefined;
          const aliases = contact ? store.db.prepare("SELECT alias FROM contact_aliases WHERE open_id=?").all(contact.open_id) as Array<{ alias: string }> : [];
          ownerMessageApproved = ownerMessageAllowed({
            enabled: store.setting("ownerMessageFastPathEnabled", "false") === "true",
            ownerId: store.setting("ownerMessageFastPathOwnerId", ""), approverId: approverId ?? "",
            senderId: message.sender_id ?? "", trusted: expectedScope === "trusted",
            chatType: message.chat_type ?? "", messageType: message.message_type ?? "",
            senderType: message.sender_type ?? "", direction: message.direction ?? "",
            originalText: message.content ?? "", recipient, text: payload.text,
            contact: { identities: contact ? [contact.open_id, contact.name, ...aliases.map((row) => row.alias)] : [],
              active: contact?.is_activated === 1, internal: contact?.is_cross_tenant === 0, unique: matches.length === 1 }
          });
        }
      }
      let automaticallyApproved = ownerMessageApproved || hasLarkManualTurnApproval(store.db, { turnId, threadId: message.codex_session_id, senderId: message.sender_id ?? null, approverId });
      const deploymentInScope=deploymentOperationMatchesTask(approvalTask(message.content ?? ""),`${capability.id}: ${textResult(input)}`);
      if (approvalRequired && !automaticallyApproved && (capability.risk === "local-write" || (id === "forge.deploy.production" && deploymentInScope)) && store.setting("turnAutoApprovalEnabled", "false") === "true") {
        const reviewerApprover = approverId;
        const decision = await waitForTurnAuthorization(reviewLarkTurnAutoApproval({ messageId: larkMessageId, turnId, senderId: message.sender_id ?? null,
          originalMessage: message.content ?? "", operation: `${capability.id}: ${textResult(input)}`, cwd: workspaceRoot }), signal);
        assertActive();
        if (!await confirmTurn(larkMessageId, turnId)) throw new Error("自动审核返回时原生会话已失效，操作未执行。");
        assertActive();
        automaticallyApproved = decision.approved && store.setting("turnAutoApprovalEnabled", "false") === "true" && approverId === reviewerApprover;
        if (automaticallyApproved && decision.reviewId) markTurnAutoApprovalApplied(decision.reviewId);
      }
      if (approvalRequired && !automaticallyApproved && !await awaitApproval({ messageId: larkMessageId, turnId, capabilityId: id, operation: `${capability.title}: ${textResult(input)}`, originalMessage: message.content }, signal)) throw new Error("Operation was not approved or its turn ended");
      assertActive();
      if (!await confirmTurn(larkMessageId, turnId)) throw new Error("无法确认原生 turn 仍有效，未执行操作。");
      assertActive();
      call.started = true;
      const hostResult = await invokeHost(capability, input, {
        ...context,
        senderId: message.sender_id,
        chatType: message.chat_type ?? null
      });
      const result = ownerMessageApproved
        ? { ...(hostResult as Record<string, unknown>), _authorization: { mode: "explicit-owner-message", policyVersion: 1 } }
        : hostResult;
      store.db.prepare("UPDATE lark_capability_invocations SET status='completed', result_json=?, error=NULL, finished_at=? WHERE turn_id=? AND capability_id=? AND input_hash=?").run(JSON.stringify(result ?? null), new Date().toISOString(), turnId, id, inputHash);
      return result;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (store.db.open) store.db.prepare("UPDATE lark_capability_invocations SET status='failed', error=?, finished_at=? WHERE turn_id=? AND capability_id=? AND input_hash=?").run(messageText, new Date().toISOString(), turnId, id, inputHash);
      throw error;
    } finally { signal.removeEventListener("abort", cancelled); authorizations.delete(call); }
  };
  const executeCapability = async (...args: Parameters<typeof executeCapabilityInternal>): Promise<unknown> => {
    activeCapabilityCalls++;
    try { return await executeCapabilityInternal(...args); }
    finally { activeCapabilityCalls--; }
  };
  const authenticated = (request: FastifyRequest) => !config.runtimeToken || request.headers.authorization === `Bearer ${config.runtimeToken}`;
  let groupPrivacy: GroupPrivacy;
  const agentMessaging = new AgentMessaging(store, { ownerId: () => approverId ?? "",
    groupReviewRequired: () => groupPrivacy.enabled(),
    queueGroup: input => groupPrivacy.propose(input) });
  registerAgentMessagingRoutes(app, agentMessaging, req => Boolean(config.runtimeToken) && authenticated(req));
  groupPrivacy = new GroupPrivacy(store, { ownerId: () => approverId ?? "", model: configuredLarkCodexModel,
    canChangeEnabled: () => activeCapabilityCalls === 0 && larkCodexAppServerStatus().activeTurns === 0
      && !store.db.prepare("SELECT 1 FROM lark_messages WHERE codex_status IN ('queued','running') LIMIT 1").get(),
    enabledChanged: enabled => { conversationConfig.groupPrivacyEnforced = enabled; },
    approvedReceipt: (outreachId, messageId, chatId) => agentMessaging.approvedGroupReceipt(outreachId, messageId, chatId),
    forward: (message, identity) => agentMessaging.ingest(message, identity) });
  registerGroupPrivacyRoutes(app, groupPrivacy, request => Boolean(config.runtimeToken) && authenticated(request));
  setExternalMessageHandler(event => groupPrivacy.ingestEvent(event) || agentMessaging.ingestEvent(event));
  if (config.mode === "active" && process.env.LARK_AGENT_TEST_DATABASE !== "1") groupPrivacy.start();
  app.addHook("onClose", async () => { setExternalMessageHandler(null); });
  if (config.mode === "active") agentMessaging.start();
  const personalInbox = new PersonalInbox(store, { ownerId: () => approverId ?? "", model: configuredLarkCodexModel,
    routeMessage: message => groupPrivacy.ingest(message, "user") || agentMessaging.ingest(message, "user"),
    botAssistClaimed: message => message.chatType === "group" && ownerMentionAssistSettings(message.chatId).effectiveEnabled
      && Boolean(store.db.prepare(`SELECT 1 FROM lark_owner_mention_assists a JOIN lark_messages m ON m.id=a.lark_message_id WHERE m.message_id=? AND a.owner_id=?`)
        .get(message.messageId,store.setting("personalInbox.ownerId",approverId ?? ""))) });
  registerPersonalInboxRoutes(app, personalInbox, request => Boolean(config.runtimeToken) && authenticated(request));
  registerOwnerMentionAssistRoutes(app, request => Boolean(config.runtimeToken) && authenticated(request));
  if (config.mode === "active") personalInbox.start();
  registerPersonaRoutes(app, authenticated, Boolean(config.runtimeToken));
  registerHostOutboundRoutes(app, store, authenticated, {
    sendDirect: config.proactiveMessageSender ?? sendLarkTextMessage,
    sendReply: config.textReplySender ?? sendLarkTextReply,
    record: recordOutboundLarkMessage
  });

  app.get("/v1/live", async () => ({ ok: true, pid: process.pid }));
  const runtimeHealth = async () => {
    const larkCli = await probeLarkCli();
    const listenerRunning = listener?.running() ?? false;
    const approvalListenerRunning = larkMessageWorkerStatus().approvalRunning;
    const listenersRequired = config.mode === "active" && process.env.LARK_AGENT_LISTEN !== "false" && store.setting("listenerEnabled", "true") === "true";
    const ok = larkCli.ok && (!listenersRequired || (listenerRunning && approvalListenerRunning));
    return { ok, mode: config.mode, pid: process.pid, node: process.execPath,
      listenerRunning, approvalListenerRunning, dependencies: { larkCli },
      activeTurns: larkCodexAppServerStatus().activeTurns,
      activeOwnerAssists: activeOwnerAssistRequests(),
      delivery: {
        pendingText: (store.db.prepare("SELECT count(*) AS count FROM lark_messages WHERE reply_status='pending' AND reply_delivery_text IS NOT NULL").get() as { count: number }).count,
        failedText: (store.db.prepare("SELECT count(*) AS count FROM lark_messages WHERE reply_status='failed' AND reply_delivery_text IS NOT NULL").get() as { count: number }).count
      },
      archivePending: (store.db.prepare("SELECT count(*) AS count FROM lark_codex_archive_queue WHERE attempts<5").get() as { count: number }).count,
      archiveFailed: (store.db.prepare("SELECT count(*) AS count FROM lark_codex_archive_queue WHERE attempts>=5").get() as { count: number }).count };
  };
  app.get("/v1/health", async (_request, reply) => {
    const health = await runtimeHealth();
    return reply.code(health.ok ? 200 : 503).send(health);
  });
  app.get("/v1/readiness", async (_request, reply) => {
    const health = await runtimeHealth();
    const larkAuth = health.dependencies.larkCli.ok ? await probeLarkAuth() : { ok: false, checkedAt: new Date().toISOString(), error: "CLI is unavailable" };
    const ok = health.ok && larkAuth.ok;
    return reply.code(ok ? 200 : 503).send({ ...health, ok, dependencies: { ...health.dependencies, larkAuth } });
  });
  app.get("/v1/models", async (_request, reply) => {
    try { return { models: await listLarkCodexModels() }; }
    catch (error) {
      app.log.warn({ err: error }, "Unable to load Codex models");
      return reply.code(503).send({ error: "Codex model catalog is unavailable" });
    }
  });
  app.get("/v1/conversations", async () => store.db.prepare("SELECT * FROM lark_codex_sessions ORDER BY updated_at DESC LIMIT 200").all());
  app.get("/v1/contact-conversations/:contactId/sessions", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ code: "UNAUTHORIZED", message: "Unauthorized", traceId: request.id });
    const chatId = contactIdFromPath((request.params as { contactId: string }).contactId);
    if (!chatId) return reply.code(400).send({ code: "INVALID_CONTACT_ID", message: "Invalid contactId", traceId: request.id });
    return {
      active: store.db.prepare("SELECT session_key AS sessionKey, trust_scope AS trustScope, codex_session_id AS codexSessionId, created_at AS createdAt FROM lark_codex_sessions WHERE chat_id=? ORDER BY updated_at DESC").all(chatId),
      previous: store.db.prepare("SELECT id, session_key AS sessionKey, trust_scope AS trustScope, codex_session_id AS codexSessionId, reset_at AS resetAt FROM lark_codex_session_resets WHERE chat_id=? ORDER BY id DESC LIMIT 50").all(chatId)
    };
  });
  app.post("/v1/contact-conversations/:contactId/sessions/reset", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ code: "UNAUTHORIZED", message: "Unauthorized", traceId: request.id });
    const chatId = contactIdFromPath((request.params as { contactId: string }).contactId);
    const body = request.body as { sessionKey?: unknown; expectedSessionId?: unknown } | null;
    if (!chatId || typeof body?.sessionKey !== "string" || body.sessionKey.length > 300 || typeof body.expectedSessionId !== "string" || body.expectedSessionId.length > 100) {
      return reply.code(400).send({ code: "INVALID_SESSION_RESET", message: "Invalid session reset request", traceId: request.id });
    }
    if (larkCodexAppServerStatus().activeTurns > 0) return reply.code(409).send({ code: "CODEX_TURN_ACTIVE", message: "Wait for the current Codex turn to finish", traceId: request.id });
    const result = store.db.transaction(() => {
      const session = store.db.prepare("SELECT session_key, chat_id, trust_scope, codex_session_id FROM lark_codex_sessions WHERE session_key=? AND chat_id=?")
        .get(body.sessionKey, chatId) as { session_key: string; chat_id: string; trust_scope: string; codex_session_id: string } | undefined;
      if (!session || session.codex_session_id !== body.expectedSessionId) return null;
      const resetAt = new Date().toISOString();
      store.db.prepare("INSERT INTO lark_codex_session_resets (session_key, chat_id, trust_scope, codex_session_id, reset_at) VALUES (?,?,?,?,?)")
        .run(session.session_key, session.chat_id, session.trust_scope, session.codex_session_id, resetAt);
      store.db.prepare("DELETE FROM lark_codex_sessions WHERE session_key=?").run(session.session_key);
      const cursorKey = session.session_key.slice(0, -`::${session.trust_scope}`.length);
      store.db.prepare("DELETE FROM lark_group_context_cursors WHERE chat_id=? AND trust_scope=?").run(cursorKey, session.trust_scope);
      return { sessionKey: session.session_key, oldSessionId: session.codex_session_id, resetAt };
    })();
    if (!result) return reply.code(409).send({ code: "SESSION_CHANGED", message: "Session changed; refresh before resetting", traceId: request.id });
    return result;
  });
  app.get("/v1/contact-conversations", async (request, reply) => {
    const query = request.query as { keyword?: unknown; limit?: unknown; offset?: unknown; chat_type?: unknown };
    if (query.chat_type !== undefined && query.chat_type !== "group" && query.chat_type !== "p2p") return reply.code(400).send({ code: "INVALID_CHAT_TYPE", message: "Invalid chat type", traceId: request.id });
    const chatType = query.chat_type === "group" ? "group" : "p2p";
    const namesRefreshing = chatType === "group" && config.mode === "active" ? groupNames.refresh() : false;
    const identity = chatType === "group" ? "chat_id" : "CASE WHEN direction='outbound' THEN recipient_id ELSE sender_id END";
    if (query.keyword !== undefined && (typeof query.keyword !== "string" || query.keyword.length > 200)) return reply.code(400).send({ code: "INVALID_KEYWORD", message: "Keyword must be a string up to 200 characters", traceId: request.id });
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().toLowerCase() : "";
    const pattern = `%${keyword}%`;
    const limit = boundedLimit(query.limit, 50, 100);
    const offset = nonNegativeOffset(query.offset);
    if (limit === null) return reply.code(400).send({ code: "INVALID_LIMIT", message: "Limit must be a positive integer", traceId: request.id });
    if (offset === null) return reply.code(400).send({ code: "INVALID_OFFSET", message: "Offset must be a non-negative integer", traceId: request.id });
    const joins = "LEFT JOIN lark_contacts ON lark_contacts.open_id=summaries.contact_id LEFT JOIN settings group_names ON group_names.key='lark.chat.name:' || summaries.contact_id";
    const where = keyword ? "WHERE (lower(COALESCE(group_names.value, lark_contacts.name, '')) LIKE ? OR lower(summaries.contact_id) LIKE ? OR lower(COALESCE(summaries.chat_id, '')) LIKE ?)" : "";
    const values = keyword ? [pattern, pattern, pattern] : [];
    const summaryCte = `
      WITH p2p_messages AS (
        SELECT id, content, direction, chat_id,
          ${identity} AS contact_id,
          COALESCE(message_at, received_at, created_at) AS effective_message_at
        FROM lark_messages
        WHERE chat_type='${chatType}'
          AND ${identity} IS NOT NULL
      ), ranked AS (
        SELECT *,
          row_number() OVER (PARTITION BY contact_id ORDER BY effective_message_at DESC, id DESC) AS position,
          count(*) OVER (PARTITION BY contact_id) AS message_count,
          sum(CASE WHEN direction='outbound' THEN 0 ELSE 1 END) OVER (PARTITION BY contact_id) AS inbound_count,
          sum(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) OVER (PARTITION BY contact_id) AS outbound_count
        FROM p2p_messages
      ), summaries AS (SELECT * FROM ranked WHERE position=1)
    `;
    const total = (store.db.prepare(`${summaryCte} SELECT count(*) AS total FROM summaries ${joins} ${where}`).get(...values) as { total: number }).total;
    const items = store.db.prepare(`
      ${summaryCte}
      SELECT summaries.contact_id AS contactId,
        '${chatType}' AS chatType, summaries.chat_id AS chatId,
        (SELECT json_group_array(codex_session_id) FROM (
          SELECT codex_session_id FROM lark_codex_sessions WHERE chat_id=summaries.chat_id
          UNION SELECT codex_session_id FROM lark_codex_session_resets WHERE chat_id=summaries.chat_id
        )) AS session_ids,
        COALESCE(group_names.value, lark_contacts.name, summaries.contact_id) AS contactName,
        summaries.effective_message_at AS lastMessageAt,
        substr(COALESCE(summaries.content, ''), 1, 160) AS lastMessagePreview,
        summaries.message_count AS messageCount,
        summaries.inbound_count AS inboundCount,
        summaries.outbound_count AS outboundCount
      FROM summaries
      ${joins}
      ${where}
      ORDER BY summaries.effective_message_at DESC, summaries.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Array<Record<string, unknown>>;
    return { namesRefreshing, items: items.map(({ session_ids, ...item }) => ({ ...item, codexSessionIds: JSON.parse(String(session_ids ?? "[]")) })), pagination: { total, limit, offset, hasMore: offset + items.length < total } };
  });
  app.get("/v1/contact-conversations/:contactId/messages", async (request, reply) => {
    const contactId = contactIdFromPath((request.params as { contactId: string }).contactId);
    if (!contactId) return reply.code(400).send({ code: "INVALID_CONTACT_ID", message: "Invalid contactId", traceId: request.id });
    const query = request.query as { cursor?: unknown; limit?: unknown };
    const limit = boundedLimit(query.limit, 50, 100);
    if (limit === null) return reply.code(400).send({ code: "INVALID_LIMIT", message: "Limit must be a positive integer", traceId: request.id });
    if (query.cursor !== undefined && typeof query.cursor !== "string") return reply.code(400).send({ code: "INVALID_CURSOR", message: "Invalid message cursor", traceId: request.id });
    const cursor = query.cursor ? decodeMessageCursor(query.cursor) : null;
    if (query.cursor && !cursor) return reply.code(400).send({ code: "INVALID_CURSOR", message: "Invalid message cursor", traceId: request.id });
    const group = contactId.startsWith("oc_");
    const conditions = group
      ? ["lark_messages.chat_type='group'", "lark_messages.chat_id=?"]
      : ["lark_messages.chat_type='p2p'", "(lark_messages.sender_id=? OR lark_messages.recipient_id=?)"];
    const values: unknown[] = group ? [contactId] : [contactId, contactId];
    if (cursor) {
      conditions.push("(lark_messages.message_at < ? OR (lark_messages.message_at = ? AND lark_messages.id < ?))");
      values.push(cursor.messageAt, cursor.messageAt, cursor.id);
    }
    const rows = store.db.prepare(`
      SELECT ${messageSelectColumns}
      FROM lark_messages
      ${messageContactJoins}
      WHERE ${conditions.join(" AND ")}
      ORDER BY lark_messages.message_at DESC, lark_messages.id DESC
      LIMIT ?
    `).all(...values, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeMessageCursor({ messageAt: String(last.messageAt ?? last.message_at ?? last.received_at ?? last.created_at), id: Number(last.id) })
      : null;
    return { items, pagination: { limit, hasMore, nextCursor } };
  });
  app.get("/v1/messages", async (request) => {
    const query = request.query as { after_id?: string; include_ids?: string; chat_type?: string; sender_id?: string; chat_id?: string; status?: string; q?: string; limit?: string };
    const conditions: string[] = [];
    const values: unknown[] = [];
    const afterId = Number(query.after_id);
    const includeIds = (query.include_ids ?? "").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, 100);
    if (Number.isSafeInteger(afterId) && afterId > 0) {
      if (includeIds.length > 0) { conditions.push(`(lark_messages.id > ? OR lark_messages.id IN (${includeIds.map(() => "?").join(",")}))`); values.push(afterId, ...includeIds); }
      else { conditions.push("lark_messages.id > ?"); values.push(afterId); }
    } else if (includeIds.length > 0) { conditions.push(`lark_messages.id IN (${includeIds.map(() => "?").join(",")})`); values.push(...includeIds); }
    if (query.chat_type === "group" || query.chat_type === "p2p") { conditions.push("lark_messages.chat_type = ?"); values.push(query.chat_type); }
    if (query.sender_id) { conditions.push("(lark_messages.sender_id = ? OR lark_messages.recipient_id = ?)"); values.push(query.sender_id, query.sender_id); }
    if (query.chat_id) { conditions.push("lark_messages.chat_id = ?"); values.push(query.chat_id); }
    if (query.status === "active") conditions.push("lark_messages.codex_status IN ('queued','running')");
    if (query.status === "answered") conditions.push("lark_messages.codex_status IN ('answered','no_reply')");
    if (query.status === "failed") conditions.push("lark_messages.codex_status IN ('failed','interrupted','timeout')");
    if (query.q?.trim()) { const pattern = `%${query.q.trim().toLowerCase()}%`; conditions.push("(lower(COALESCE(lark_messages.content,'')) LIKE ? OR lower(COALESCE(lark_messages.codex_reply,'')) LIKE ? OR lower(COALESCE(lark_messages.sender_id,'')) LIKE ? OR lower(COALESCE(lark_messages.recipient_id,'')) LIKE ? OR lower(COALESCE(sender_contacts.name,'')) LIKE ? OR lower(COALESCE(recipient_contacts.name,'')) LIKE ? OR lower(COALESCE(lark_messages.chat_id,'')) LIKE ?)"); values.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern); }
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 150));
    return store.db.prepare(`
      SELECT ${messageSelectColumns}
      FROM lark_messages
      ${messageContactJoins}
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY COALESCE(lark_messages.message_at, lark_messages.received_at) DESC, lark_messages.id DESC LIMIT ?
    `).all(...values, limit);
  });
  app.get("/v1/messages/filters", async () => ({
    senders: store.db.prepare(`SELECT COALESCE(lark_messages.sender_id, lark_messages.recipient_id) AS id, lark_contacts.name, lark_contacts.enterprise_email, lark_contacts.department, count(*) AS message_count, sum(CASE WHEN lark_messages.chat_type='group' THEN 1 ELSE 0 END) AS group_count, sum(CASE WHEN lark_messages.chat_type='p2p' THEN 1 ELSE 0 END) AS p2p_count FROM lark_messages LEFT JOIN lark_contacts ON lark_contacts.open_id=COALESCE(lark_messages.sender_id, lark_messages.recipient_id) WHERE COALESCE(lark_messages.sender_id, lark_messages.recipient_id) IS NOT NULL GROUP BY COALESCE(lark_messages.sender_id, lark_messages.recipient_id) ORDER BY message_count DESC`).all(),
    chats: store.db.prepare(`SELECT chat_id AS id, max(chat_type) AS chat_type, NULL AS name, count(*) AS message_count, max(COALESCE(message_at, received_at)) AS last_message_at FROM lark_messages WHERE chat_id IS NOT NULL GROUP BY chat_id ORDER BY last_message_at DESC`).all()
  }));
  app.get("/v1/messages/:id", async (request, reply) => { const id = Number((request.params as { id: string }).id); const row = store.db.prepare("SELECT lark_messages.*, sender_contacts.name AS sender_name, sender_contacts.enterprise_email AS sender_enterprise_email, sender_contacts.department AS sender_department, lark_messages.sender_type AS senderType, lark_messages.recipient_id AS recipientId, recipient_contacts.name AS recipientName, lark_messages.message_at AS messageAt, lark_messages.outbound_source AS outboundSource FROM lark_messages LEFT JOIN lark_contacts sender_contacts ON sender_contacts.open_id=lark_messages.sender_id LEFT JOIN lark_contacts recipient_contacts ON recipient_contacts.open_id=lark_messages.recipient_id WHERE lark_messages.id=?").get(id) as Record<string, unknown> | undefined; return row ? { ...row, executionConfigs: parseLarkExecutionConfigs(messageTaskFile(store, id, "execution-configs.jsonl")) } : reply.code(404).send({ error: "not found" }); });
  app.get("/v1/messages/:id/artifacts", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!store.db.prepare("SELECT 1 FROM lark_messages WHERE id=?").get(id)) return reply.code(404).send({ error: "not found" });
    const approvals = [
      ...store.db.prepare("SELECT * FROM lark_execution_approvals WHERE lark_message_id=?").all(id),
        ...store.db.prepare("SELECT id, lark_message_id, approver_id, capability_id AS request_method, operation, NULL AS cwd, capability_id AS reason, status, approval_scope, card_message_id, error AS card_error, created_at, expires_at, decided_at FROM lark_capability_approvals WHERE lark_message_id=?").all(id)
    ].sort((left, right) => Number((left as { id: number }).id) - Number((right as { id: number }).id));
    return { executionConfigs: parseLarkExecutionConfigs(messageTaskFile(store, id, "execution-configs.jsonl")), prompt: messageTaskFile(store, id, "prompt.md"), stdout: messageTaskFile(store, id, "codex.stdout.jsonl"), stderr: messageTaskFile(store, id, "codex.stderr.log"), launcher: messageTaskFile(store, id, "run-codex-lark.sh"), referencedImages: messageTaskFile(store, id, "referenced-images.json"), referencedFiles: messageTaskFile(store, id, "referenced-files.json"), imageDownloadError: messageTaskFile(store, id, "image-download-error.log"), fileDownloadError: messageTaskFile(store, id, "file-download-error.log"), trustedSender: messageTaskFile(store, id, "trusted-sender.json"), resumeSession: messageTaskFile(store, id, "resume-session.json"), outboundMedia: messageTaskFile(store, id, "outbound-media.json"), turnResult: messageTaskFile(store, id, "turn-result.json"), approvals, receipts: store.db.prepare("SELECT * FROM lark_execution_receipts WHERE lark_message_id=? ORDER BY id").all(id), deliveries: store.db.prepare("SELECT id, kind, status, attempts, last_error, sent_at, created_at FROM lark_delivery_outbox WHERE lark_message_id=? ORDER BY id").all(id), events: [] };
  });
  app.get("/v1/messages/:id/images", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!store.db.prepare("SELECT 1 FROM lark_messages WHERE id=?").get(id)) return reply.code(404).send({ error: "not found" });
    return messageImages(store, id);
  });
  app.get("/v1/messages/:id/files", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!store.db.prepare("SELECT 1 FROM lark_messages WHERE id=?").get(id)) return reply.code(404).send({ error: "not found" });
    return messageFiles(store, id);
  });
  app.get("/v1/approvals", async () => ({ appServer: store.db.prepare("SELECT * FROM lark_execution_approvals ORDER BY id DESC LIMIT 200").all(), capabilities: store.db.prepare("SELECT * FROM lark_capability_approvals ORDER BY id DESC LIMIT 200").all(), autoReviews: store.db.prepare("SELECT * FROM lark_turn_auto_reviews ORDER BY id DESC LIMIT 200").all() }));
  registerApprovalHistoryRoutes(app, store, authenticated);
  app.get("/v1/contacts", async () => store.db.prepare("SELECT * FROM contacts ORDER BY name, open_id").all());
  app.post("/v1/contacts/sync", async () => syncLarkContactsFromCli());
  app.get("/v1/stickers", async () => (store.db.prepare("SELECT id, name, description, tags, file_name AS fileName, mime_type AS mimeType, size_bytes AS sizeBytes, source_url AS sourceUrl, source_site AS sourceSite, enabled, created_at AS createdAt, updated_at AS updatedAt FROM stickers ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>).map((sticker) => ({ ...sticker, tags: JSON.parse(String(sticker.tags ?? "[]")), imageUrl: `/v1/stickers/${encodeURIComponent(String(sticker.id))}/image` })));
  app.post("/v1/stickers/replace-from-bundle", async (request, reply) => {
    if (!config.runtimeToken || !authenticated(request) || !["127.0.0.1", "::1"].includes(request.ip)) {
      return reply.code(403).send({ code: "STICKER_IMPORT_FORBIDDEN", message: "Local runtime token required" });
    }
    const directory = (request.body as { bundleDirectory?: unknown } | null)?.bundleDirectory;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 1000) {
      return reply.code(400).send({ code: "INVALID_STICKER_BUNDLE", message: "An absolute bundle directory is required" });
    }
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE", message: "A sticker import is already running" });
    stickerImportRunning = true;
    try {
      return await replaceStickersFromBundle({
        db: store.db, databasePath: config.databasePath, bundleDirectory: directory,
        ensureIdle: () => { if (larkCodexAppServerStatus().activeTurns > 0) throw new Error("Wait for active Codex turns before replacing stickers"); }
      });
    } catch (error) {
      return reply.code(409).send({ code: "STICKER_IMPORT_FAILED", message: error instanceof Error ? error.message : String(error) });
    } finally { stickerImportRunning = false; }
  });
  app.post("/v1/stickers/batch", async (request, reply) => {
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" });
    const payload = request.body as { files?: Array<{ name?: string; description?: string; tags?: string[]; fileName?: string; mimeType?: string; dataBase64?: string; sourceUrl?: string; sourceSite?: string }> };
    const files = payload.files ?? [];
    if (files.length < 1 || files.length > 50) return reply.code(400).send({ error: "files must contain 1-50 stickers" });
    const directory = path.join(path.dirname(config.databasePath), "stickers"); mkdirSync(directory, { recursive: true });
    const insert = store.db.prepare("INSERT INTO stickers (id, name, description, tags, file_name, mime_type, size_bytes, source_url, source_site, enabled, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)");
    const created: string[] = []; const now = new Date().toISOString();
    store.db.transaction(() => files.forEach((file) => {
      if (!file.dataBase64 || !file.fileName || !file.mimeType) throw new Error("sticker file metadata is required");
      const bytes = Buffer.from(file.dataBase64, "base64"); if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error("sticker file must be 1B-2MB");
      const id = `stk_${randomBytes(8).toString("hex")}`; const name = (file.name ?? path.basename(file.fileName, path.extname(file.fileName))).trim().slice(0, 80); if (!name) throw new Error("sticker name is required");
      const storedName = `${id}${path.extname(file.fileName).toLowerCase()}`; const storedPath = path.join(directory, storedName); writeFileSync(storedPath, bytes);
      insert.run(id, name, (file.description ?? "").trim().slice(0, 300), JSON.stringify((file.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12)), storedName, file.mimeType, bytes.length, file.sourceUrl ?? null, file.sourceSite ?? null, storedPath, now, now); created.push(id);
    }))();
    return reply.code(201).send((store.db.prepare(`SELECT id, name, description, tags, file_name AS fileName, mime_type AS mimeType, size_bytes AS sizeBytes, source_url AS sourceUrl, source_site AS sourceSite, enabled, created_at AS createdAt, updated_at AS updatedAt FROM stickers WHERE id IN (${created.map(() => "?").join(",")})`).all(...created) as Array<Record<string, unknown>>).map((sticker) => ({ ...sticker, tags: JSON.parse(String(sticker.tags)), imageUrl: `/v1/stickers/${encodeURIComponent(String(sticker.id))}/image` })));
  });
  app.patch("/v1/stickers/:id", async (request, reply) => { if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" }); const patch = request.body as { name?: string; description?: string; tags?: string[]; enabled?: boolean }; const existing = store.db.prepare("SELECT * FROM stickers WHERE id=?").get((request.params as { id: string }).id) as Record<string, unknown> | undefined; if (!existing) return reply.code(404).send({ error: "not found" }); const name = patch.name === undefined ? String(existing.name) : patch.name.trim().slice(0, 80); if (!name) return reply.code(400).send({ error: "name is required" }); store.db.prepare("UPDATE stickers SET name=?, description=?, tags=?, enabled=?, updated_at=? WHERE id=?").run(name, patch.description === undefined ? existing.description : patch.description.trim().slice(0, 300), patch.tags === undefined ? existing.tags : JSON.stringify(patch.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12)), patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0, new Date().toISOString(), existing.id); return store.db.prepare("SELECT id, name, description, tags, file_name AS fileName, mime_type AS mimeType, size_bytes AS sizeBytes, source_url AS sourceUrl, source_site AS sourceSite, enabled, created_at AS createdAt, updated_at AS updatedAt FROM stickers WHERE id=?").get(existing.id); });
  app.delete("/v1/stickers/:id", async (request, reply) => { if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" }); const changed = store.db.prepare("UPDATE stickers SET enabled=0, updated_at=? WHERE id=?").run(new Date().toISOString(), (request.params as { id: string }).id).changes; return changed ? reply.code(204).send() : reply.code(404).send({ error: "not found" }); });
  app.get("/v1/stickers/:id/image", async (request, reply) => { const sticker = store.db.prepare("SELECT local_path, mime_type FROM stickers WHERE id=? AND enabled=1").get((request.params as { id: string }).id) as { local_path?: string; mime_type?: string } | undefined; if (!sticker?.local_path || !existsSync(sticker.local_path)) return reply.code(404).send({ error: "not found" }); return reply.type(sticker.mime_type ?? "application/octet-stream").send(readFileSync(sticker.local_path)); });
  app.get("/v1/prompts", async () => { const custom = store.setting("prompt.larkAssistant", "").trim(); const defaultValue = defaultConfigurablePrompt("larkAssistant"); return { larkAssistant: custom || defaultValue, defaultLarkAssistant: defaultValue, customized: Boolean(custom) }; });
  app.put("/v1/prompts", async (request, reply) => {
    let payload: Record<string, unknown>;
    try {
      payload = strictSettingsObject(request.body, ["larkAssistant"], "prompts");
      if (typeof payload.larkAssistant !== "string" || payload.larkAssistant.length > 50_000) throw new Error("larkAssistant must be a prompt up to 50000 characters");
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    store.setSetting("prompt.larkAssistant", (payload.larkAssistant as string).trim());
    const custom = store.setting("prompt.larkAssistant", "").trim(); const defaultValue = defaultConfigurablePrompt("larkAssistant");
    return { larkAssistant: custom || defaultValue, defaultLarkAssistant: defaultValue, customized: Boolean(custom) };
  });
  for (const decision of ["approve", "approve-turn", "reject"] as const) app.post(`/v1/approvals/:id/${decision}`, async (request, reply) => {
    if (!config.runtimeToken || !authenticated(request)) return reply.code(401).send({ error: "runtime token required" });
    const result = await decide(Number((request.params as { id: string }).id), decision);
    return reply.code(result.ok ? 200 : 409).send(result);
  });
  app.post("/v1/messages", async (request, reply) => { if (!request.body || typeof request.body !== "object") return reply.code(400).send({ error: "invalid Lark event" }); return ingestLarkEvent(request.body as Record<string, unknown>); });
  app.post("/v1/messages/:id/retry", async (request, reply) => { const id = Number((request.params as { id: string }).id); const message = store.db.prepare("SELECT id, codex_status FROM lark_messages WHERE id=?").get(id) as { id: number; codex_status: string } | undefined; if (!message) return reply.code(404).send({ error: "message not found" }); return enqueueLarkCodexReply(id) ? reply.code(202).send({ id, status: "queued" }) : reply.code(409).send({ error: `message status ${message.codex_status} cannot be retried` }); });
  app.post("/v1/capabilities/register", async (request, reply) => {
    if (!config.runtimeToken || !authenticated(request)) return reply.code(401).send({ error: "runtime token required" });
    const payload = request.body as { capabilities?: Array<{ id: string; title: string; description: string; inputSchema: Record<string, unknown>; risk: string }> };
    const entries = payload?.capabilities;
    if (!Array.isArray(entries) || entries.length > 100 || !entries.every(entry => entry && typeof entry.id === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(entry.id)
      && !entry.id.startsWith("lark.") && typeof entry.title === "string" && typeof entry.description === "string" && entry.inputSchema && typeof entry.inputSchema === "object" && !Array.isArray(entry.inputSchema)
      && ["read", "local-write", "external-write"].includes(entry.risk))) return reply.code(400).send({ error: "invalid capability registration or reserved builtin id" });
    store.registerCapabilities(entries); return { registered: entries.length };
  });
  const capabilityRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.runtimeToken || !authenticated(request)) return reply.code(401).send({ error: "runtime token required" });
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.once("aborted", aborted); reply.raw.once("close", closed);
    if (request.raw.aborted) controller.abort();
    const payload = request.body as { input?: unknown; context?: Record<string, unknown> };
    try { return await executeCapability((request.params as { id: string }).id, payload?.input ?? {}, payload?.context ?? {}, controller.signal); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { request.raw.off("aborted", aborted); reply.raw.off("close", closed); }
  };
  app.post("/v1/capabilities/:id/invoke", capabilityRoute);
  app.post("/v1/internal/capabilities/:id/execute", capabilityRoute);
  app.post("/v1/internal/owner-assist/decision", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${attachmentRuntimeToken}` || !["127.0.0.1", "::1"].includes(request.ip)) return reply.code(403).send({ error: "local runtime token required" });
    const payload = request.body as { contextToken?: unknown; input?: unknown } | null;
    if (!payload || Object.keys(payload).some(key => !["contextToken", "input"].includes(key)) || typeof payload.contextToken !== "string"
      || !/^[A-Za-z0-9_-]{32}$/.test(payload.contextToken) || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) return reply.code(400).send({ error: "invalid owner assistance MCP request" });
    const result = await runLarkOwnerAssistMcpTool(payload.contextToken, payload.input as Record<string, unknown>);
    return reply.code(result.success ? 200 : 409).send(result);
  });
  app.post("/v1/internal/attachments/register", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${attachmentRuntimeToken}` || !["127.0.0.1", "::1"].includes(request.ip)) return reply.code(403).send({ error: "local runtime token required" });
    const payload = request.body as { contextToken?: unknown; input?: unknown } | null;
    if (!payload || Object.keys(payload).some(key => !["contextToken", "input"].includes(key))
      || typeof payload.contextToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(payload.contextToken)
      || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) return reply.code(400).send({ error: "invalid attachment MCP request" });
    const result = runLarkAttachmentMcpTool(payload.contextToken, payload.input as Record<string, unknown>);
    return reply.code(result.success ? 200 : 409).send(result);
  });
  app.post("/v1/internal/stickers/:tool", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    const tool = (request.params as { tool?: unknown }).tool;
    const payload = request.body as { contextToken?: unknown; input?: unknown };
    if ((tool !== "search" && tool !== "select") || typeof payload?.contextToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(payload.contextToken) || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) {
      return reply.code(400).send({ error: "invalid sticker MCP request" });
    }
    const result = runLarkStickerMcpTool(payload.contextToken, tool, payload.input as Record<string, unknown>);
    return reply.code(result.success ? 200 : 409).send(result);
  });
  app.post("/v1/internal/history-images/:tool", async (request, reply) => {
    if (!config.runtimeToken || !authenticated(request) || !["127.0.0.1", "::1"].includes(request.ip)) return reply.code(403).send({ error: "local runtime token required" });
    const tool = (request.params as { tool?: unknown }).tool;
    const payload = request.body as { contextToken?: unknown; input?: unknown } | null;
    if ((tool !== "search" && tool !== "open") || typeof payload?.contextToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(payload.contextToken)
      || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) return reply.code(400).send({ error: "invalid history image MCP request" });
    const result = await runLarkHistoryImageMcpTool(payload.contextToken, tool, payload.input as Record<string, unknown>);
    return reply.code(result.success ? 200 : 409).send(result);
  });
  app.get("/v1/events", async (request) => { const afterId = Number((request.query as { after_id?: string }).after_id) || 0; return { messages: store.db.prepare("SELECT id, message_id, chat_id, codex_status, reply_status, codex_last_heartbeat_at, codex_finished_at FROM lark_messages WHERE id>? ORDER BY id LIMIT 200").all(afterId), receipts: store.db.prepare("SELECT id, lark_message_id, turn_id, status, delivery_status, delivery_error, created_at, updated_at FROM lark_execution_receipts WHERE id>? ORDER BY id LIMIT 200").all(afterId), deliveries: store.db.prepare("SELECT id, lark_message_id, kind, status, attempts, next_attempt_at, last_error, sent_at, created_at FROM lark_delivery_outbox WHERE id>? ORDER BY id LIMIT 200").all(afterId) }; });
  const startListener = () => {
    if (store.setting("listenerEnabled", "true") !== "true") return listener;
    listener ??= { stop: stopLarkMessageWorker, running: () => larkMessageWorkerStatus().running };
    if (!listener.running() || !larkMessageWorkerStatus().approvalRunning) startLarkMessageWorker();
    return listener;
  };
  const stopListener = () => { listener?.stop(); listener = null; };
  const runtimeSettings = () => ({ groupSpontaneousReplyCooldownMs: groupSpontaneousReplyCooldownMs(), executionReceiptsEnabled: store.setting("executionReceiptsEnabled", "true") !== "false", codexModel: configuredLarkCodexModel(), reasoningEffort: configuredLarkCodexReasoningEffort(), stickerUsageMode: configuredLarkStickerUsageMode(), groupSpontaneousReplyRate: groupSpontaneousReplyRate(), listenerEnabled: store.setting("listenerEnabled", "true") === "true", repliesEnabled: store.setting("repliesEnabled", "true") === "true", interimRepliesEnabled: store.setting("interimRepliesEnabled", "true") === "true", groupMessageReactionEnabled: store.setting("groupMessageReactionEnabled", "false") === "true", groupMessageReactionEmoji: store.setting("groupMessageReactionEmoji", "THUMBSUP"), groupMessageReactionChatIds: groupMessageReactionChatIds(), groupSpontaneousRepliesEnabled: store.setting("groupSpontaneousRepliesEnabled", "false") === "true", groupSpontaneousChatIds: groupSpontaneousChatIds(), groupContextMessageLimit: Number(store.setting("groupContextMessageLimit", "50")), groupContextMaxChars: Number(store.setting("groupContextMaxChars", "6000")), acknowledgeReactionEmoji: store.setting("acknowledgeReactionEmoji", "EYESCLOSED"), trustedSenderIds: [...trustedSenderIds], approverId: approverId ?? "", listenerRunning: listener?.running() ?? false, approvalListenerRunning: larkMessageWorkerStatus().approvalRunning });
  const autoApprovalSettings = () => ({ turnAutoApprovalEnabled: store.setting("turnAutoApprovalEnabled", "false") === "true", turnAutoApprovalModel: configuredTurnAutoApprovalModel(store.db), turnAutoApprovalModelConfigurable: true, turnAutoApprovalDataSources: configuredTurnAutoApprovalDataSources(store.db) });
  const ownerMessageSettings = () => ({ ownerMessageFastPathEnabled: store.setting("ownerMessageFastPathEnabled", "false") === "true", ownerMessageFastPathOwnerId: store.setting("ownerMessageFastPathOwnerId", "") });
  const ownerAssistSettings = () => ({ ownerMentionAssistEnabled: store.setting("ownerMentionAssistEnabled", "false") === "true", ownerMentionAssistOwnerId: store.setting("ownerMentionAssistOwnerId", "") });
  const executionSettings = () => ({ workspaceRoot, trustedExecutionEnabled: configuredTrustedExecutionEnabled() });
  const allSettings = () => ({ ...runtimeSettings(), ...autoApprovalSettings(), ...ownerMessageSettings(), ...ownerAssistSettings(), ...executionSettings(), topicNativeModeEnabled: topicNativeModeEnabled() });
  app.get("/v1/settings", async () => allSettings());
  app.patch("/v1/settings", async (request, reply) => {
    let payload: RuntimeSettingsPatch;
    try { payload = parseRuntimeSettingsPatch(request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    if ((payload.ownerMentionAssistEnabled !== undefined || payload.ownerMentionAssistOwnerId !== undefined) && (!config.runtimeToken || !authenticated(request))) return reply.code(401).send({ error: "Runtime token required for owner assistance settings" });
    const nextApproverId = payload.approverId ?? approverId ?? "";
    const nextTrustedSenderIds = payload.trustedSenderIds ?? [...trustedSenderIds];
    const nextWorkspaceRoot = payload.workspaceRoot ?? workspaceRoot;
    if (payload.ownerMentionAssistEnabled === true && !/^ou_[A-Za-z0-9]+$/.test((payload.ownerMentionAssistOwnerId ?? ownerAssistSettings().ownerMentionAssistOwnerId) || nextApproverId)) return reply.code(400).send({ error: "Configure an owner open_id before enabling group assistance" });
    if (payload.ownerMentionAssistOwnerId !== undefined && payload.ownerMentionAssistOwnerId !== ownerAssistSettings().ownerMentionAssistOwnerId
      && store.db.prepare("SELECT 1 FROM lark_messages WHERE reply_trigger='owner_mention' AND codex_status IN ('queued','running') LIMIT 1").get()) return reply.code(409).send({ error: "Wait for active owner assistance turns before changing the owner" });
    if (payload.ownerMessageFastPathEnabled === true && !nextApproverId) return reply.code(400).send({ error: "An owner approver must be configured before enabling the message exemption" });
    const executionChanged = nextWorkspaceRoot !== workspaceRoot
      || (payload.trustedExecutionEnabled !== undefined && payload.trustedExecutionEnabled !== configuredTrustedExecutionEnabled())
      || nextApproverId !== (approverId ?? "")
      || JSON.stringify([...nextTrustedSenderIds].sort()) !== JSON.stringify([...trustedSenderIds].sort());
    if (executionChanged && (activeCapabilityCalls > 0 || larkCodexAppServerStatus().activeTurns > 0
      || store.db.prepare("SELECT 1 FROM lark_messages WHERE codex_status IN ('queued','running') LIMIT 1").get())) {
      return reply.code(409).send({ code: "CODEX_TURN_ACTIVE", error: "Wait for running and queued Codex tasks to finish before changing workspace or execution permissions" });
    }
    store.db.transaction(() => {
      if (nextWorkspaceRoot !== workspaceRoot) {
        const threads = store.db.prepare("SELECT codex_session_id FROM lark_codex_sessions").all() as Array<{ codex_session_id: string }>;
        for (const thread of threads) {
          const key = `codex.threadWorkspace:${thread.codex_session_id}`;
          if (!store.db.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) store.setSetting(key, workspaceRoot);
        }
      }
      if (payload.topicNativeModeEnabled !== undefined && payload.topicNativeModeEnabled !== topicNativeModeEnabled()) resetTopicNativeEnrollmentEpoch();
      for (const [key, value] of runtimeSettingEntries(payload)) store.setSetting(key, value);
      if (payload.ownerMessageFastPathEnabled === true) store.setSetting("ownerMessageFastPathOwnerId", nextApproverId);
      if (payload.executionReceiptsEnabled === false) suppressPendingLarkExecutionReceipts();
    })();
    workspaceRoot = nextWorkspaceRoot;
    conversationConfig.workspaceRoot = workspaceRoot;
    approverId = nextApproverId || undefined;
    trustedSenderIds.clear();
    nextTrustedSenderIds.forEach(id => trustedSenderIds.add(id));
    conversationConfig.larkExecutionApproverId = nextApproverId;
    conversationConfig.trustedLarkCodexSenderIds = [...trustedSenderIds];
    refreshOwnerAssistPolicies();
    if (payload.trustedSenderIds !== undefined) config.trustedSenderIds.splice(0, config.trustedSenderIds.length, ...trustedSenderIds);
    if (payload.listenerEnabled !== undefined) {
      try { if (payload.listenerEnabled) startListener(); else stopListener(); }
      catch (error) {
        request.log.error(error, "Settings saved, but listener update failed");
        return reply.code(500).send({ error: "Settings saved, but listener update failed", settings: allSettings() });
      }
    }
    return allSettings();
  });
  return { app, store, decideApprovalFromCard, expireApprovals: expirePendingApprovals, recoverOrphanedRuns: reconcileOrphanedLarkCodexRuns, startListener, stop: () => { stopListener(); setAdditionalLarkApprovalHandler(null); stopLarkCodexResponder(); removeTurnListener(); store.close(); } };
}

if (process.argv[1]?.endsWith("index.ts")) {
  const port = Number(process.env.PORT ?? 4780);
  const runtime = createRuntime({ databasePath: process.env.LARK_AGENT_DATABASE ?? "./lark-agent.sqlite", mode: process.env.LARK_AGENT_MODE === "active" ? "active" : "shadow", trustedSenderIds: (process.env.LARK_AGENT_TRUSTED_SENDERS ?? "").split(",").filter(Boolean), approverId: process.env.LARK_AGENT_APPROVER_ID, workspaceRoot: process.env.LARK_AGENT_WORKSPACE_ROOT, hostBaseUrl: process.env.LARK_AGENT_HOST_URL, hostToken: process.env.LARK_AGENT_HOST_TOKEN, runtimeToken: process.env.LARK_AGENT_RUNTIME_TOKEN, host: "127.0.0.1", port });
  await runtime.app.listen({ host: "127.0.0.1", port });
  setInterval(() => { runtime.expireApprovals(); runtime.recoverOrphanedRuns(); retryPendingLarkTextReplies(); retryPendingLarkMediaReplies(); retryPendingLarkCompletionReactions(); retryPendingLarkExecutionReceipts();
    void retryPendingLarkProgressCards();
    retryOwnerAssistNotifications();
    void retryPendingAutoApprovalNotifications().catch((error) => console.warn(`Auto-approval notification retry failed: ${error instanceof Error ? error.message : String(error)}`));
    void reconcilePendingLarkThreadArchives().catch((error) => console.warn(`Lark thread archive reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)); }, 2_000).unref();
  if (process.env.LARK_AGENT_LISTEN !== "false") runtime.startListener();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopLarkMessageWorker();
    // Drain, never replay or force-kill a possibly paid/external operation.
    while (larkCodexAppServerStatus().activeTurns > 0) await new Promise(resolve => setTimeout(resolve, 500));
    await runtime.app.close();
    runtime.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
