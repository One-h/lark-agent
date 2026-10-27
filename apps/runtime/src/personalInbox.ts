import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { automaticReplyAllowed, reviewPersonalMessage, type InboxDecision } from "./personalInboxReview.js";
import { createPersonalInboxTransport, LarkInboxError, type PersonalInboxTransport, type PersonalMessage } from "./personalInboxTransport.js";

export type InboxRow = PersonalMessage & {
  id: number; status: string; draft: string; summary: string; question: string; error: string | null;
  version: number; notified: number; approved: number; receivedAt: string; updatedAt: string; sentMessageId: string | null;
};
const signature = "（小龙的助手龙小祝代为回复）";
const signatureText = (text: string) => text.endsWith(signature) ? text : `${text}\n${signature}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "个人收件箱处理失败。";

export class PersonalInbox {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closing = false;
  private readonly sending = new Set<number>();
  private lastError: string | null = null;
  private canSend = false;
  constructor(readonly store: SqliteAgentStore, private readonly options: {
    ownerId: () => string; model: () => string; transport?: PersonalInboxTransport;
    review?: (message: PersonalMessage, model: string) => Promise<InboxDecision>;
    now?: () => Date; routeMessage?: (message: PersonalMessage) => boolean;
  }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS personal_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, messageId TEXT NOT NULL UNIQUE, chatId TEXT NOT NULL,
      chatType TEXT NOT NULL, chatName TEXT NOT NULL, senderId TEXT NOT NULL, senderName TEXT NOT NULL,
      content TEXT NOT NULL, sourceTime TEXT NOT NULL, messageType TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', draft TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '', error TEXT, version INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
      receivedAt TEXT NOT NULL, updatedAt TEXT NOT NULL, sentMessageId TEXT
    ); CREATE INDEX IF NOT EXISTS personal_inbox_status ON personal_inbox(status, id);`);
    store.db.prepare("UPDATE personal_inbox SET status='needs_owner', error='服务重启中断了分析，请人工确认。', version=version+1 WHERE status='reviewing'").run();
    store.db.prepare("UPDATE personal_inbox SET status='send_unknown', error='发送过程中服务重启；请先在飞书核对，禁止自动重发。', version=version+1 WHERE status='sending'").run();
  }
  private get transport() { return this.options.transport ?? createPersonalInboxTransport(); }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private setting(key: string, fallback = "") { return this.store.setting(`personalInbox.${key}`, fallback); }
  private set(key: string, value: string) { this.store.setSetting(`personalInbox.${key}`, value); }
  enabled() { return this.setting("enabled") === "true"; }
  status() { return { enabled: this.enabled(), autoReply: this.setting("autoReply", "true") === "true", busy: this.busy,
    activatedAt: this.setting("activatedAt"), lastSyncAt: this.setting("cursor"), lastError: this.lastError,
    canSend: this.canSend, intervalSeconds: 60, ownerId: this.setting("ownerId"),
    counts: this.store.db.prepare("SELECT status, count(*) AS count FROM personal_inbox GROUP BY status").all() }; }
  rows() { return this.store.db.prepare("SELECT * FROM personal_inbox ORDER BY id DESC LIMIT 200").all() as InboxRow[]; }
  row(id: number) { return this.store.db.prepare("SELECT * FROM personal_inbox WHERE id=?").get(id) as InboxRow | undefined; }
  private update(id: number, patch: Partial<InboxRow>) {
    const entries = Object.entries({ ...patch, updatedAt: this.now() });
    this.store.db.prepare(`UPDATE personal_inbox SET ${entries.map(([key]) => `${key}=?`).join(",")}, version=version+1 WHERE id=?`)
      .run(...entries.map(([, value]) => value), id);
  }
  async configure(body: Record<string, unknown>) {
    if (Object.keys(body).some(key => !["enabled", "autoReply"].includes(key))
      || Object.values(body).some(value => typeof value !== "boolean")) throw new Error("仅接受 enabled 和 autoReply 布尔设置。");
    if (body.enabled === true) {
      const identity = await this.transport.identity();
      const pinned = this.setting("ownerId") || this.options.ownerId();
      if (!pinned || identity.ownerId !== pinned) throw new Error("当前用户授权与固定审批人不一致，不能开启个人收件箱。");
      this.set("ownerId", pinned); this.canSend = identity.canSend;
      if (!this.setting("activatedAt")) { const now = this.now(); this.set("activatedAt", now); this.set("cursor", now); }
    }
    for (const [key, value] of Object.entries(body)) this.set(key, String(value));
    if (this.enabled()) await this.tick();
    return this.status();
  }
  start() { this.timer ??= setInterval(() => { void this.tick(); }, 60_000); this.timer.unref(); if (this.enabled()) void this.tick(); }
  async stop() {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    while (this.busy || this.sending.size) await new Promise(resolve => setTimeout(resolve, 100));
  }
  ingest(messages: PersonalMessage[]) {
    const at = this.now();
    const insert = this.store.db.prepare(`INSERT OR IGNORE INTO personal_inbox
      (messageId,chatId,chatType,chatName,senderId,senderName,content,sourceTime,messageType,receivedAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    this.store.db.transaction(() => {
      for (const m of messages) {
        if (this.options.routeMessage?.(m)) continue;
        // The same DM to our own bot already has a separate listener and responder.
        if (this.store.db.prepare("SELECT 1 FROM lark_messages WHERE message_id=?").get(m.messageId)) continue;
        insert.run(m.messageId,m.chatId,m.chatType,m.chatName,m.senderId,m.senderName,m.content,m.sourceTime,m.messageType,at,at);
      }
    })();
  }
  async tick() {
    if (this.busy || this.closing || !this.enabled()) return;
    this.busy = true;
    try {
      const identity = await this.transport.identity();
      if (identity.ownerId !== this.setting("ownerId")) throw new Error("个人账号发生变化，采集已停止。");
      this.canSend = identity.canSend;
      const cutoff = Date.parse(this.setting("activatedAt"));
      const cursor = Date.parse(this.setting("cursor"));
      const end = new Date(Date.parse(this.now()) - 10_000).toISOString();
      if (Date.parse(end) > cutoff) {
        const start = new Date(Math.max(cutoff, cursor - 300_000)).toISOString();
        const messages = await this.transport.collect(start, end, identity.ownerId);
        this.ingest(messages);
        this.set("cursor", end); // Never advance after a partial/failed search.
      }
      const rows = this.store.db.prepare("SELECT * FROM personal_inbox WHERE status IN ('pending','ready','awaiting_auth') ORDER BY id LIMIT 10").all() as InboxRow[];
      for (const row of rows) {
        if (this.closing || !this.enabled()) break;
        if (row.status !== "pending") { if (this.canSend) await this.deliver(row.id); continue; }
        try {
          if (await this.transport.ownerReplied(row, identity.ownerId)) { this.update(row.id, { status: "owner_replied", summary: "你已亲自回复，助手不再重复发送。" }); continue; }
          this.update(row.id, { status: "reviewing" });
          const decision = await (this.options.review ?? reviewPersonalMessage)(row, this.options.model());
          const routine = decision.action === "routine" && automaticReplyAllowed(row) && this.setting("autoReply", "true") === "true";
          this.update(row.id, { status: decision.action === "ignore" ? "dismissed" : routine ? "ready" : "needs_owner",
            draft: decision.reply, summary: decision.summary, question: decision.question || (routine ? "" : "你希望怎么回复这条消息？") });
          if (routine) await this.deliver(row.id);
        } catch (error) { this.update(row.id, { status: "needs_owner", error: errorMessage(error), question: "这条消息需要你确认如何处理。" }); }
      }
      const notify = this.store.db.prepare("SELECT * FROM personal_inbox WHERE status IN ('needs_owner','awaiting_auth','send_unknown') AND notified=0 ORDER BY id LIMIT 5").all() as InboxRow[];
      for (const row of notify) {
        try {
          await this.transport.notify(identity.ownerId,
            `个人收件箱 #${row.id} · ${row.chatType === "group" ? "群里@你" : "私聊"}\n来自：${row.senderName}${row.chatName ? ` · ${row.chatName}` : ""}\n消息：${row.content.slice(0, 600)}\n${row.question || row.error || "以本人身份回复尚待授权。"}\n${row.draft ? `建议回复：${row.draft.slice(0, 500)}\n` : ""}请在 Forge 个人收件箱确认或修改后发送：http://127.0.0.1:4732/personal-inbox`,
            `inbox-notice-${row.id}`);
          this.update(row.id, { notified: 1 });
        } catch { /* Keep notification pending, with a stable idempotency key. */ }
      }
      this.lastError = null;
    } catch (error) { this.lastError = errorMessage(error); }
    finally { this.busy = false; }
  }
  async decide(id: number, body: { action?: unknown; text?: unknown; version?: unknown }) {
    const row = this.row(id);
    if (!row || row.version !== body.version) throw new Error("消息已更新，请刷新后再确认。");
    if (!["needs_owner", "awaiting_auth", "ready"].includes(row.status)) throw new Error("当前状态不能发送或修改。");
    if (this.sending.has(id)) throw new Error("消息正在发送。");
    if (body.action === "dismiss") { this.update(id, { status: "dismissed" }); return this.row(id); }
    if (body.action !== "send" || typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000) throw new Error("请提供不超过 2000 字的回复。");
    this.update(id, { status: "ready", draft: body.text.trim(), approved: 1, error: null });
    await this.deliver(id);
    return this.row(id);
  }
  async deliver(id: number) {
    if (this.sending.has(id) || this.closing || !this.enabled()) return;
    this.sending.add(id);
    try {
      const row = this.row(id);
      if (!row || !["ready", "awaiting_auth"].includes(row.status)) return;
      if (!row.approved && (!automaticReplyAllowed(row) || this.setting("autoReply", "true") !== "true")) return;
      const identity = await this.transport.identity();
      if (identity.ownerId !== this.setting("ownerId")) throw new Error("当前登录账号不一致，未发送。");
      this.canSend = identity.canSend;
      if (!identity.canSend) { this.update(id, { status: "awaiting_auth", error: "需补上 im:message.send_as_user 用户授权。" }); return; }
      if (await this.transport.ownerReplied(row, identity.ownerId)) { this.update(id, { status: "owner_replied", error: null }); return; }
      this.update(id, { status: "sending", error: null });
      const key = `inbox-${createHash("sha256").update(row.messageId).digest("hex").slice(0, 32)}`;
      try {
        const sentMessageId = await this.transport.send(row, signatureText(row.draft), key);
        this.update(id, { status: "sent", sentMessageId, error: null });
      } catch (error) {
        this.update(id, { status: error instanceof LarkInboxError && error.subtype === "missing_scope" ? "awaiting_auth" : "send_unknown", error: errorMessage(error) });
      }
    } finally { this.sending.delete(id); }
  }
}

export function registerPersonalInboxRoutes(app: FastifyInstance, inbox: PersonalInbox, authenticated: (request: FastifyRequest) => boolean) {
  app.route({ method: ["GET", "PATCH"], url: "/v1/personal-inbox", handler: async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      if (request.method === "PATCH") await inbox.configure((request.body ?? {}) as Record<string, unknown>);
      return { status: inbox.status(), messages: inbox.rows() };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  } });
  app.post("/v1/personal-inbox/sync", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    void inbox.tick(); return { accepted: true };
  });
  app.post("/v1/personal-inbox/:id/decision", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: "invalid id" });
    try { return await inbox.decide(id, (request.body ?? {}) as Record<string, unknown>); }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  app.addHook("onClose", () => inbox.stop());
}
