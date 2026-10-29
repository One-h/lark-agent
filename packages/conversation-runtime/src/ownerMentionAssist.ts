import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { jsonFromCliOutput, larkReplyIdempotencyKey, sendLarkTextMessage } from "@lark-agent/adapter-lark-cli";
import { appSettingValue, config, db, getAppSettings, nowIso, setAppSettingValue, type LarkMessageRow } from "./context.js";

export type OwnerMentionAssistMode = "global" | "on" | "off";
export type OwnerAssistRow = { lark_message_id: number; owner_id: string; decision: string; status: string; reason: string;
  draft: string; question: string; owner_context_cursor: number; decision_turn_id: string | null; ready_turn_id: string | null; membership_checked_at: number;
  manual_approved: number; version: number; notified: number; notice_generation: number; notify_attempts: number; notify_after: string };
type MembershipProbe = (chatId: string, ownerId: string) => Promise<boolean | null>;
type PrivateSender = typeof sendLarkTextMessage;
const exec = promisify(execFile);
let membershipProbe: MembershipProbe = probeMembership;
let privateSender: PrivateSender = sendLarkTextMessage;
let minimumDelayMs = 15_000;
let reviewAvailable = true;
const notificationTasks = new WeakMap<Database.Database, Promise<void>>();
const manualReviews = new WeakMap<Database.Database, number>();
export function activeOwnerAssistRequests(): number { return (notificationTasks.has(db) ? 1 : 0) + (manualReviews.get(db) ?? 0); }
export async function drainOwnerAssistNotifications(): Promise<void> { await notificationTasks.get(db); }
const contextListeners = new WeakMap<Database.Database, Set<(id: number) => void>>();
export function onOwnerAssistContextChanged(listener: (id: number) => void) {
  const database = db;
  let listeners = contextListeners.get(database);
  if (!listeners) { listeners = new Set(); contextListeners.set(database, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function contextChanged(id: number) {
  for (const listener of contextListeners.get(db) ?? []) {
    try { listener(id); } catch { console.warn("owner_assist_context_cleanup_failed"); }
  }
}

export function refreshOwnerAssistPolicies(chatId?: string): void {
  const rows = db.prepare(`SELECT m.id FROM lark_messages m JOIN lark_owner_mention_assists a ON a.lark_message_id=m.id
    WHERE m.reply_trigger='owner_mention' AND (m.codex_status IN ('queued','running') OR a.status IN ('pending','handling','ready','reconsidering'))${chatId ? " AND m.chat_id=?" : ""}`)
    .all(...(chatId ? [chatId] : [])) as Array<{ id: number }>;
  for (const item of rows) {
    const row = ownerAssistRow(item.id), source = sourceRow(item.id);
    if (row && source && !currentPolicy(source,row)) {
      if (row.manual_approved || !["queued","running"].includes(source.codex_status)) {
        deferOwnerAssistDelivery(item.id,"协同设置曾关闭或变化，旧投递不会自动恢复；请核对实际投递结果后重新确认草稿。");
      } else if (row.decision === "handle") {
        update(item.id,{status:"reconsidering",ready_turn_id:null,decision_turn_id:null,question:"协同设置曾关闭或变化，旧判定已失效，请重新判断是否仍需继续。"});
      }
    }
    if (!ownerAssistMayExecute(item.id)) contextChanged(item.id);
  }
}

export function configureOwnerMentionAssist(options: { membershipProbe?: MembershipProbe; privateSender?: PrivateSender; delayMs?: number; reviewAvailable?: boolean } = {}) {
  membershipProbe = options.membershipProbe ?? probeMembership;
  privateSender = options.privateSender ?? sendLarkTextMessage;
  minimumDelayMs = options.delayMs ?? 15_000;
  reviewAvailable = options.reviewAvailable ?? true;
}

async function checkMembership(chatId: string, ownerId: string): Promise<boolean | null> {
  try { return await membershipProbe(chatId,ownerId); } catch { return null; }
}

async function probeMembership(chatId: string, ownerId: string): Promise<boolean | null> {
  try {
    const { stdout } = await exec("lark-cli", ["im", "+chat-members-list", "--as", "bot", "--chat-id", chatId,
      "--member-types", "user", "--member-id-type", "open_id", "--page-all", "--page-limit", "2", "--page-size", "100", "--format", "json"],
    { encoding: "utf8", timeout: 12_000, maxBuffer: 1024 * 1024 });
    const result = jsonFromCliOutput(stdout) as { ok?: boolean; data?: { users?: Array<{ member_id?: string }>; has_more?: boolean; truncations?: unknown[] } };
    if (result?.ok !== true || !Array.isArray(result.data?.users)) return null;
    // The bot-authenticated members API requires the caller itself to belong to this chat.
    if (result.data.users.some(user => user.member_id === ownerId)) return true;
    return result.data.has_more || result.data.truncations?.length ? null : false;
  } catch { return null; }
}

export function ownerMentionAssistSettings(chatId: string) {
  const stored = appSettingValue(`conversation.ownerMentionAssist:${chatId}`);
  const mode: OwnerMentionAssistMode = stored === "on" || stored === "off" ? stored : "global";
  const globalEnabled = appSettingValue("ownerMentionAssistEnabled") === "true";
  const candidate = appSettingValue("ownerMentionAssistOwnerId")?.trim() || config.larkExecutionApproverId;
  const ownerId = /^ou_[A-Za-z0-9]+$/.test(candidate) ? candidate : "";
  return { mode, globalEnabled, ownerId, effectiveEnabled: Boolean(reviewAvailable && ownerId && (mode === "on" || mode === "global" && globalEnabled)) };
}

export function setOwnerMentionAssistMode(chatId: string, mode: OwnerMentionAssistMode) {
  if (!["global", "on", "off"].includes(mode)) throw new Error("无效的群聊协同代答模式");
  setAppSettingValue(`conversation.ownerMentionAssist:${chatId}`, mode);
}

export function ownerAssistRow(id: number): OwnerAssistRow | undefined {
  return db.prepare("SELECT * FROM lark_owner_mention_assists WHERE lark_message_id=?").get(id) as OwnerAssistRow | undefined;
}
const sourceRow = (id: number) => db.prepare("SELECT * FROM lark_messages WHERE id=?").get(id) as LarkMessageRow | undefined;
function update(id: number, patch: Record<string, unknown>) {
  const entries = Object.entries({ ...patch, updated_at: nowIso() });
  db.prepare(`UPDATE lark_owner_mention_assists SET ${entries.map(([key]) => `${key}=?`).join(",")},version=version+1 WHERE lark_message_id=?`)
    .run(...entries.map(([, value]) => value), id);
}

export function ensureOwnerMentionAssist(source: LarkMessageRow): void {
  if (source.reply_trigger !== "owner_mention" || !source.chat_id) return;
  const at = nowIso();
  db.prepare(`INSERT OR IGNORE INTO lark_owner_mention_assists(lark_message_id,owner_id,owner_context_cursor,notify_after,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run(source.id, ownerMentionAssistSettings(source.chat_id).ownerId, source.id, at, at, at);
}

function currentPolicy(source: LarkMessageRow, row: OwnerAssistRow): boolean {
  const policy = source.chat_id ? ownerMentionAssistSettings(source.chat_id) : null;
  return Boolean(source.chat_type === "group" && config.runtimeMode === "active" && !config.groupPrivacyEnforced && policy?.effectiveEnabled && policy.ownerId === row.owner_id);
}

function ownerMessages(source: LarkMessageRow, row: OwnerAssistRow) {
  const settings = getAppSettings();
  const rows = db.prepare(`SELECT id,message_id,content,message_at,reply_to_message_id FROM lark_messages
    WHERE chat_id=? AND chat_type='group' AND sender_id=? AND sender_type='user' AND direction='inbound' AND id>?
      AND COALESCE(message_at,received_at,created_at)>=?
      AND COALESCE(thread_id,'')=COALESCE(?,'') ORDER BY id DESC LIMIT ?`)
    .all(source.chat_id, row.owner_id, source.id, source.message_at || source.created_at, source.thread_id, settings.larkGroupContextMessageLimit + 1) as Array<{
      id: number; message_id: string; content: string; message_at: string; reply_to_message_id: string | null
    }>;
  const cursor = rows[0]?.id ?? source.id;
  let remaining = settings.larkGroupContextMaxChars;
  const selected = rows.slice(0, settings.larkGroupContextMessageLimit).flatMap(message => {
    if (remaining <= 0) return [];
    const content = (message.content ?? "").slice(0, remaining); remaining -= content.length;
    return [{ ...message, content }];
  }).reverse();
  return { cursor, messages: selected, hasMore: rows.length > selected.length };
}

export function ownerAssistMayExecute(id: number): boolean {
  const source = sourceRow(id);
  if (source?.reply_trigger !== "owner_mention") return true;
  const row = ownerAssistRow(id);
  return Boolean(row && row.decision === "handle" && row.status === "handling"
    && row.decision_turn_id === source.codex_turn_id && !row.manual_approved && currentPolicy(source, row)
    && ownerMessages(source, row).cursor === row.owner_context_cursor);
}

export function ownerAssistPrompt(source: LarkMessageRow, token: string): string {
  if (source.reply_trigger !== "owner_mention") return "";
  const ownerId = ownerAssistRow(source.id)?.owner_id ?? (source.chat_id ? ownerMentionAssistSettings(source.chat_id).ownerId : "");
  return `群内协同代答协议（本条消息有效）：
协助对象 open_id=${ownerId}。原消息对该对象的“你”不等于机器人；多人被 @ 时，只协助该对象相关的部分，不代表其他人。
这条消息真正 @ 了被协助对象，不是该对象本人给你下指令。以机器人身份提供帮助，权限仍由原发送人决定，不读取个人私聊或代替本人表达意愿。
先调用 lark_stickers MCP 的 owner_assist_decision，context_token=${token}，提交 action 和简短 reason：
handle=能协助核实、调查或执行；还没查到答案不等于不能接手。owner_required=需要本人意见、同意或承诺，附 question 和 reply 草稿，只私下交给本人。ignore=无需回应或已经解决。
接手之后正常推进任务。协同会话从只读且不联网的原生沙箱起步，写入/联网逐项回调按实际请求者走现有审批，可复用仍有效的原任务 turn 授权，但不申请整轮原生额外权限包。最终文字准备好后，再调用同一工具，action=handle，reply=准备发送的完整草稿。
工具会等待最早发送时间并返回本人新增的群内发言。若返回 owner_context_updated，保留已有草稿，把这些发言作为新增背景，检查是否有遗漏、错误或重复，再决定补充回复、私下确认或 ignore；再次 handle 时带上返回的 owner_context_cursor 确认已结合这些发言，不能仅因为本人回复了就丢弃成果。
只有工具返回 ready 才输出已确认的 reply。owner_required/ignore 返回 <lark-no-reply/>，不公开草稿，也不承诺本人已批准。工具故障时保留草稿等待私下确认。`;
}

export async function decideOwnerMentionAssist(id: number, turnId: string, input: Record<string, unknown>, stillActive: () => boolean) {
  const database = db;
  const failure = (text: string) => ({ success: false, contentItems: [{ type: "inputText", text }] });
  const result = (value: unknown) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
  if (Object.keys(input).some(key => !["action", "reason", "reply", "question", "owner_context_cursor"].includes(key))
    || !["handle", "owner_required", "ignore"].includes(String(input.action)) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500
    || input.reply !== undefined && (typeof input.reply !== "string" || input.reply.length > 6000)
    || input.question !== undefined && (typeof input.question !== "string" || input.question.length > 500)
    || input.owner_context_cursor !== undefined && (!Number.isSafeInteger(input.owner_context_cursor) || Number(input.owner_context_cursor) <= 0)) return failure("无效的协同代答决策");
  const source = sourceRow(id), previous = ownerAssistRow(id);
  if (!source || !previous || !stillActive() || !currentPolicy(source, previous)) return failure("协同代答上下文已失效或功能未开启");
  if (["owner_required", "ignore"].includes(previous.decision) || previous.manual_approved) return result({ state: previous.decision, stop: true });
  const action = String(input.action), draft = typeof input.reply === "string" ? input.reply.trim() : previous.draft;
  if (action !== "handle") {
    update(id, { decision: action, status: action === "ignore" ? "ignored" : "needs_owner", reason: input.reason.trim(), draft,
      question: typeof input.question === "string" ? input.question : "这条消息需要你本人决定如何回复。", decision_turn_id: turnId, ready_turn_id: null });
    contextChanged(id);
    retryOwnerAssistNotifications();
    return result({ state: action, stop: true, publicReply: false });
  }
  if (previous.status === "reconsidering" && ownerMessages(source, previous).cursor === previous.owner_context_cursor
    && input.owner_context_cursor !== previous.owner_context_cursor) {
    const context = ownerMessages(source, previous);
    return result({ state: "owner_context_updated", owner_context_cursor: context.cursor, ownerResponses: context.messages,
      preparedDraftRetained: true, contextReason: previous.question, instruction: "请结合本人发言或协同设置变化重新判断，再在 handle 中带回 owner_context_cursor。" });
  }
  if (input.reply === undefined) {
    const context = ownerMessages(source, previous);
    if (context.cursor !== previous.owner_context_cursor) {
      update(id, { decision: "handle", status: "reconsidering", owner_context_cursor: context.cursor, ready_turn_id: null });
      contextChanged(id);
      return result({ state: "owner_context_updated", owner_context_cursor: context.cursor, ownerResponses: context.messages.filter(message => message.id > previous.owner_context_cursor), preparedDraftRetained: true });
    }
    const membership = await checkMembership(source.chat_id!, previous.owner_id);
    if (db !== database || !database.open || !stillActive() || !currentPolicy(source, previous)) return failure("对应 turn 或配置已失效");
    if (membership !== true) {
      update(id, { decision: "owner_required", status: "needs_owner", reason: "无法确认你与机器人仍在该群，未自动接手", question: "请检查群成员读取权限及成员关系。" });
      retryOwnerAssistNotifications(); return result({ state: "owner_required", stop: true });
    }
    const latest = ownerMessages(source, previous);
    if (latest.cursor !== previous.owner_context_cursor) {
      update(id,{decision:"handle",status:"reconsidering",owner_context_cursor:latest.cursor,ready_turn_id:null});
      contextChanged(id);
      return result({state:"owner_context_updated",owner_context_cursor:latest.cursor,ownerResponses:latest.messages.filter(message=>message.id>previous.owner_context_cursor),preparedDraftRetained:true});
    }
    update(id, { decision: "handle", status: "handling", reason: input.reason.trim(), decision_turn_id: turnId, ready_turn_id: null });
    return result({ state: "handle", finalDecisionRequired: true });
  }
  if (!draft) return failure("准备公开回复时必须提供完整 reply 草稿");
  update(id, { draft, reason: input.reason.trim(), ready_turn_id: null });
  const wait = Math.max(0, Date.parse(source.created_at) + minimumDelayMs - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  if (db !== database || !database.open || !stillActive()) return failure("对应 turn 已结束，草稿已保留");
  const current = ownerAssistRow(id)!;
  if (!currentPolicy(source, current)) return failure("协同代答配置已变化，草稿未公开");
  const context = ownerMessages(source, current);
  if (context.cursor !== current.owner_context_cursor) {
    update(id, { decision: "handle", status: "reconsidering", owner_context_cursor: context.cursor });
    contextChanged(id);
    return result({ state: "owner_context_updated", owner_context_cursor: context.cursor, ownerResponses: context.messages.filter(message => message.id > current.owner_context_cursor), hasMore: context.hasMore, preparedDraftRetained: true,
      instruction: "结合本人新增发言判断是否还有值得补充的内容，重新提交决策；不要机械取消草稿。" });
  }
  const membership = await checkMembership(source.chat_id!, current.owner_id);
  if (db !== database || !database.open || !stillActive()) return failure("对应 turn 已结束");
  if (!currentPolicy(source, current)) return failure("协同代答配置已变化");
  const latest = ownerMessages(source, current);
  if (latest.cursor !== context.cursor) {
    update(id, { decision: "handle", status: "reconsidering", owner_context_cursor: latest.cursor });
    contextChanged(id);
    return result({ state: "owner_context_updated", owner_context_cursor: latest.cursor, ownerResponses: latest.messages.filter(message => message.id > current.owner_context_cursor), preparedDraftRetained: true });
  }
  if (membership !== true) {
    update(id, { decision: "owner_required", status: "needs_owner", question: "发送前无法确认双方群成员关系，请确认。" });
    contextChanged(id);
    retryOwnerAssistNotifications(); return result({ state: "owner_required", stop: true });
  }
  update(id, { decision: "handle", status: "ready", draft, owner_context_cursor: latest.cursor, decision_turn_id: turnId, ready_turn_id: turnId, membership_checked_at: Date.now() });
  return result({ state: "ready", reply: draft });
}

export function ownerAssistPublicAllowed(id: number): boolean {
  const source = sourceRow(id);
  if (source?.reply_trigger !== "owner_mention") return true;
  const row = ownerAssistRow(id);
  if (!row || !currentPolicy(source, row)) return false;
  if (row.status === "sent") return true;
  return row.status === "ready" && Boolean(row.manual_approved || row.decision === "handle" && row.ready_turn_id === source.codex_turn_id)
    && Date.now() - row.membership_checked_at < 30_000 && ownerMessages(source, row).cursor === row.owner_context_cursor;
}

export function finishOwnerMentionAssist(id: number, turnId: string, draft: string | null, failed: boolean): string | null {
  const source = sourceRow(id), row = ownerAssistRow(id);
  if (source?.reply_trigger !== "owner_mention") return draft;
  if (!row) return null;
  if (row.manual_approved || row.decision === "ignore") return null;
  if (!failed && row.ready_turn_id === turnId && ownerAssistPublicAllowed(id)) return row.draft;
  if (row.status !== "needs_owner") update(id, { status: "needs_owner", ready_turn_id: null,
    draft: row.draft || (draft && !draft.includes("<lark-no-reply/>") ? draft : ""),
    question: failed ? "机器人处理未完成，请确认后续安排。" : "本人发言或会话状态已有变化，已保留草稿，请确认是否仍需补充。" });
  retryOwnerAssistNotifications();
  return null;
}

export function markOwnerAssistSent(id: number) {
  const row = ownerAssistRow(id);
  if (row && row.status !== "sent") update(id, { status: "sent" });
}

export function deferOwnerAssistDelivery(id: number, reason: string): void {
  const row = ownerAssistRow(id);
  if (!row || row.status === "needs_owner") return;
  update(id, { status: "needs_owner", question: reason, manual_approved: 0, ready_turn_id: null,
    notified: 0, notify_attempts: 0, notice_generation: row.notice_generation + 1, notify_after: nowIso() });
}

export function retryOwnerAssistNotifications(): Promise<void> {
  if (!db?.open || config.runtimeMode !== "active") return Promise.resolve();
  const existing = notificationTasks.get(db);
  if (existing) return existing;
  if (!db.prepare("SELECT 1 FROM lark_owner_mention_assists WHERE status='needs_owner' AND notified=0 AND notify_attempts<5 AND notify_after<=? LIMIT 1").get(nowIso())) return Promise.resolve();
  const database = db;
  const task = Promise.resolve().then(() => sendOwnerAssistNotifications(database))
    .catch(() => { console.warn("owner_assist_notification_retry_failed"); }).finally(() => notificationTasks.delete(database));
  notificationTasks.set(database,task);
  return task;
}

async function sendOwnerAssistNotifications(database: Database.Database): Promise<void> {
  if (database !== db || !database.open) return;
  const rows = db.prepare("SELECT * FROM lark_owner_mention_assists WHERE status='needs_owner' AND notified=0 AND notify_attempts<5 AND notify_after<=? ORDER BY lark_message_id LIMIT 5").all(nowIso()) as OwnerAssistRow[];
  for (const row of rows) {
    if (database !== db || !database.open) return;
    const source = sourceRow(row.lark_message_id);
    if (!source?.chat_id || ownerMentionAssistSettings(source.chat_id).ownerId !== row.owner_id || !ownerMentionAssistSettings(source.chat_id).effectiveEnabled) {
      db.prepare("UPDATE lark_owner_mention_assists SET notify_after=? WHERE lark_message_id=?").run(new Date(Date.now() + 600_000).toISOString(), row.lark_message_id);
      continue;
    }
    const membership = await checkMembership(source.chat_id,row.owner_id);
    if (database !== db || !database.open) return;
    const current = ownerAssistRow(row.lark_message_id);
    const policy = ownerMentionAssistSettings(source.chat_id);
    if (!current || current.status !== "needs_owner" || current.notice_generation !== row.notice_generation || !policy.effectiveEnabled || policy.ownerId !== row.owner_id) continue;
    if (membership === false) {
      db.prepare("UPDATE lark_owner_mention_assists SET notify_attempts=5,question='本人或机器人已不在群内，未转发群消息；草稿仍保留在控制台。' WHERE lark_message_id=? AND notice_generation=?")
        .run(row.lark_message_id,row.notice_generation);
      continue;
    }
    const text = membership === true
      ? `群聊协同待确认 #${row.lark_message_id}\n请求：${(source.content ?? "").slice(0, 600)}\n${row.reason}\n${row.question}\n${row.draft ? `草稿：${row.draft.slice(0, 1200)}\n` : ""}请在个人收件箱确认机器人回复：http://127.0.0.1:4732/personal-inbox`
      : `群聊协同 #${row.lark_message_id} 无法确认群成员读取权限。未转发群消息或草稿，请在控制台检查设置：http://127.0.0.1:4732/personal-inbox`;
    let sent: { ok: boolean; messageId?: string | null };
    try { sent = privateSender(row.owner_id, text, larkReplyIdempotencyKey(membership === true ? "ownerassist" : "ownerassist-config", `${row.lark_message_id}:${row.notice_generation}`)); }
    catch { sent = { ok: false }; }
    if (database !== db || !database.open) return;
    const delivered = sent.ok && Boolean(sent.messageId);
    db.prepare(`UPDATE lark_owner_mention_assists SET notified=?,notify_attempts=?,notify_after=?,updated_at=?
      WHERE lark_message_id=? AND status='needs_owner' AND notice_generation=?`).run(delivered ? 1 : 0, delivered ? row.notify_attempts : row.notify_attempts + 1,
      new Date(Date.now() + Math.min(600_000, 15_000 * 2 ** row.notify_attempts)).toISOString(), nowIso(), row.lark_message_id, row.notice_generation);
  }
}

export function reconcileOwnerMentionAssists(): void {
  db.prepare(`UPDATE lark_owner_mention_assists SET status='needs_owner',decision='owner_required',ready_turn_id=NULL,manual_approved=0,
    notified=0,notify_attempts=0,notice_generation=notice_generation+1,notify_after=?,
    question='服务已重启，原任务不会重跑，请确认已保留的草稿与实际投递结果。',version=version+1
    WHERE status IN ('pending','handling','reconsidering','ready')`).run(nowIso());
}

export function listOwnerMentionAssists() {
  return (db.prepare(`SELECT a.*,m.id,m.content,m.chat_id,m.chat_type,m.sender_id,m.message_id,m.thread_id,m.codex_status FROM lark_owner_mention_assists a
    JOIN lark_messages m ON m.id=a.lark_message_id ORDER BY a.lark_message_id DESC LIMIT 200`).all() as Array<OwnerAssistRow & LarkMessageRow>)
    .map(row => ({ ...row, ownerResponses: ownerMessages(row, row).messages, enabled: currentPolicy(row, row) && !["queued","running"].includes(row.codex_status) }));
}

async function reviewOwnerAssistInternal(id: number, input: Record<string, unknown>, publish: (source: LarkMessageRow, text: string, key: string) => void) {
  const database = db;
  if (Object.keys(input).some(key => !["action", "text", "version"].includes(key)) || !["send", "dismiss"].includes(String(input.action))) throw new Error("无效的草稿处理请求");
  const row = ownerAssistRow(id), source = sourceRow(id);
  if (!row || !source || row.version !== input.version || row.status !== "needs_owner") throw new Error("草稿已更新，请刷新后确认");
  if (input.action === "dismiss") { update(id, { status: "dismissed", notified: 1 }); return; }
  if (["queued", "running"].includes(source.codex_status)) throw new Error("请等本轮模型处理结束后确认草稿；确认回复不会批准原任务执行");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 6000) throw new Error("请提供 1–6000 字的机器人回复");
  if (!currentPolicy(source, row) || await checkMembership(source.chat_id!, row.owner_id) !== true) throw new Error("群开关或成员关系不允许发送");
  if (database !== db || !database.open) throw new Error("确认期间运行时上下文已变化，未发送草稿");
  if (ownerAssistRow(id)?.version !== row.version || !currentPolicy(source, row)) throw new Error("确认期间上下文或配置已变化，请刷新");
  update(id, { draft: input.text.trim(), status: "ready", manual_approved: 1, notified: 1,
    owner_context_cursor: ownerMessages(source, row).cursor, membership_checked_at: Date.now() });
  publish(source, input.text.trim(), larkReplyIdempotencyKey("ownerreview", `${id}:${row.version}`));
}

export async function reviewOwnerMentionAssist(id: number, input: Record<string, unknown>, publish: (source: LarkMessageRow, text: string, key: string) => void) {
  const database = db;
  manualReviews.set(database,(manualReviews.get(database) ?? 0)+1);
  try { return await reviewOwnerAssistInternal(id,input,publish); }
  finally { manualReviews.set(database,(manualReviews.get(database) ?? 1)-1); }
}

export function observeOwnerAssistContext(message: LarkMessageRow): void {
  if (message.chat_type !== "group" || message.sender_type !== "user") return;
  const rows = db.prepare(`SELECT a.lark_message_id,m.codex_status FROM lark_owner_mention_assists a JOIN lark_messages m ON m.id=a.lark_message_id
    WHERE a.owner_id=? AND a.status IN ('pending','handling','ready','reconsidering','needs_owner') AND m.chat_id=? AND m.id<?
      AND COALESCE(m.thread_id,'')=COALESCE(?,'') AND COALESCE(m.message_at,m.received_at,m.created_at)<=?`)
    .all(message.sender_id,message.chat_id,message.id,message.thread_id,message.message_at || message.created_at) as Array<{lark_message_id:number;codex_status:string}>;
  for (const row of rows) {
    if (!["queued","running"].includes(row.codex_status)) deferOwnerAssistDelivery(row.lark_message_id,"本人已补充新信息，请确认保留的草稿是否还需要发送。");
    db.prepare(`UPDATE lark_owner_mention_assists SET version=version+1,
      status=CASE WHEN decision='handle' AND status IN ('handling','ready','reconsidering') THEN 'reconsidering' ELSE status END,ready_turn_id=NULL
      WHERE lark_message_id=?`).run(row.lark_message_id);
    contextChanged(row.lark_message_id);
  }
}
