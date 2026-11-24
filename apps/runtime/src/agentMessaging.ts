import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { DesktopReplyBridge, SourceNotLoadedError, type AgentReplyBridge } from "./agentReplyBridge.js";
import { inboxCli, type PersonalMessage } from "./personalInboxTransport.js";

type Outreach = { id: string; requestKey: string; sourceThreadId: string; sourceLabel: string; sourceCwd: string;
  identity: string; recipientId: string; chatId: string; messageId: string | null; text: string; status: string; error: string | null; createdAt: string };
type RoutedReply = { id: number; messageId: string; chatId: string; senderId: string; payload: string; candidates: string;
  outreachId: string | null; status: string; error: string | null; version: number; notified: number; createdAt: string; deliveredTurnId: string | null };
type TurnSource = { threadId: string; chatId: string; senderId: string };
type GroupTarget = { chatId: string; recipientId: string };
const groupQuestionLifetimeMs = 24 * 60 * 60 * 1000;
const groupQuestionCutoff = () => new Date(Date.now() - groupQuestionLifetimeMs).toISOString();

export function groupQuestionTarget(raw: string | undefined): GroupTarget | undefined {
  const [chatId, recipientId, extra] = (raw ?? "").trim().split(",");
  if (extra !== undefined || !/^oc_[A-Za-z0-9]+$/.test(chatId ?? "") || !/^ou_[A-Za-z0-9]+$/.test(recipientId ?? "")) return;
  return { chatId, recipientId };
}

export type AgentMessage = PersonalMessage & { replyTo?: string; rootId?: string };
export class AgentMessaging {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closing = false;
  private readonly sending = new Set<string>();
  constructor(readonly store: SqliteAgentStore, private readonly options: {
    ownerId: () => string; bridge?: AgentReplyBridge; cli?: typeof inboxCli;
    groupReviewRequired?: () => boolean;
    queueGroup?: (input: {outreachId:string;chatId:string;identity:"bot"|"user";text:string})=>number;
  }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_outreach (
      id TEXT PRIMARY KEY, requestKey TEXT NOT NULL UNIQUE, sourceThreadId TEXT NOT NULL, sourceLabel TEXT NOT NULL,
      sourceCwd TEXT NOT NULL, identity TEXT NOT NULL, recipientId TEXT NOT NULL, chatId TEXT NOT NULL,
      messageId TEXT UNIQUE, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS agent_outreach_chat ON agent_outreach(chatId,status);
    CREATE TABLE IF NOT EXISTS agent_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, messageId TEXT NOT NULL UNIQUE, chatId TEXT NOT NULL, senderId TEXT NOT NULL,
      payload TEXT NOT NULL, candidates TEXT NOT NULL, outreachId TEXT, status TEXT NOT NULL, error TEXT,
      version INTEGER NOT NULL DEFAULT 1, notified INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, deliveredTurnId TEXT
    ); CREATE INDEX IF NOT EXISTS agent_replies_outreach_turn ON agent_replies(outreachId) WHERE status='turn_reply';
    CREATE TABLE IF NOT EXISTS agent_group_questions (
      outreachId TEXT PRIMARY KEY REFERENCES agent_outreach(id), sourceChatId TEXT NOT NULL, sourceSenderId TEXT NOT NULL
    );`);
    store.db.prepare("UPDATE agent_outreach SET status='send_unknown',error='服务重启，请在飞书核对发送结果。' WHERE status='sending'").run();
    store.db.prepare("UPDATE agent_replies SET status='delivery_unknown',error='投递时服务重启，请核对原会话。',version=version+1 WHERE status IN ('delivering','claimed')").run();
  }
  private get cli() { return this.options.cli ?? inboxCli; }
  private get bridge() { return this.options.bridge ?? new DesktopReplyBridge(); }
  snapshot() { return { outreaches: this.store.db.prepare("SELECT * FROM agent_outreach ORDER BY createdAt DESC LIMIT 200").all(),
    replies: this.store.db.prepare("SELECT * FROM agent_replies ORDER BY id DESC LIMIT 200").all() }; }
  private outreach(id: string) { return this.store.db.prepare("SELECT * FROM agent_outreach WHERE id=?").get(id) as Outreach | undefined; }
  private reply(id: number) { return this.store.db.prepare("SELECT * FROM agent_replies WHERE id=?").get(id) as RoutedReply | undefined; }
  private update(id: number, status: string, error: string | null = null, turnId: string | null = null) {
    const previous = this.reply(id);
    if (previous?.status === status && previous.error === error && previous.deliveredTurnId === turnId) return;
    this.store.db.prepare("UPDATE agent_replies SET status=?,error=?,deliveredTurnId=?,version=version+1 WHERE id=?").run(status,error,turnId,id);
  }
  async send(body: Record<string, unknown>) { return this.submit(body); }
  async askGroup(input: { source: TurnSource; sourceCwd: string; target: GroupTarget; requestKey: string; text: string; assertActive: () => void }) {
    const row = await this.submit({ sourceThreadId: input.source.threadId, sourceCwd: input.sourceCwd,
      sourceLabel: "飞书跨群协作", requestKey: input.requestKey, ...input.target, identity: "bot", text: input.text }, input);
    return { requestId: row!.id, status: row!.status, messageId: row!.messageId };
  }
  private async submit(body: Record<string, unknown>, turn?: { source: TurnSource; assertActive: () => void }) {
    const str = (key: string) => typeof body[key] === "string" ? (body[key] as string).trim() : "";
    const sourceThreadId = str("sourceThreadId"), sourceCwd = str("sourceCwd"), sourceLabel = str("sourceLabel"), requestKey = str("requestKey");
    const recipientId = str("recipientId"), chatId = str("chatId"), identity = str("identity") || "bot", text = str("text");
    if (!/^[0-9a-f-]{36}$/i.test(sourceThreadId) || !path.isAbsolute(sourceCwd) || !sourceLabel || sourceLabel.length > 160
      || !/^[A-Za-z0-9_-]{8,80}$/.test(requestKey) || !/^ou_[A-Za-z0-9]+$/.test(recipientId)
      || (chatId && !/^oc_[A-Za-z0-9]+$/.test(chatId)) || !["bot","user"].includes(identity) || !text || text.length > 4000) throw new Error("请提供来源会话、绝对工作目录、任务名称、唯一 requestKey、同事 open_id 和消息正文。");
    const existing = this.store.db.prepare("SELECT * FROM agent_outreach WHERE requestKey=?").get(requestKey) as Outreach | undefined;
    if (existing) {
      if ([existing.sourceThreadId,existing.sourceCwd,existing.sourceLabel,existing.recipientId,existing.identity,existing.text].join("\0") !== [sourceThreadId,sourceCwd,sourceLabel,recipientId,identity,text].join("\0")
        || (chatId && chatId !== existing.chatId)) throw new Error("requestKey 已绑定其他消息，不能复用。");
      const origin = this.store.db.prepare("SELECT sourceChatId,sourceSenderId FROM agent_group_questions WHERE outreachId=?").get(existing.id) as { sourceChatId: string; sourceSenderId: string } | undefined;
      if (turn ? origin?.sourceChatId !== turn.source.chatId || origin?.sourceSenderId !== turn.source.senderId : origin !== undefined)
        throw new Error("requestKey 已绑定其他来源。");
      return existing;
    }
    if (this.sending.has(requestKey)) throw new Error("相同消息正在发送，请稍后查询。");
    this.sending.add(requestKey);
    try {
      if (turn) turn.assertActive();
      else {
        const source = await this.bridge.inspect(sourceThreadId);
        if (source.archived || path.resolve(source.cwd) !== path.resolve(sourceCwd)) throw new Error("来源会话工作目录不匹配或已归档。");
      }
      if (identity === "user") {
        const auth = await this.cli(["auth","status","--json","--verify"]), user = auth.identities?.user;
        if (!user?.verified || user.openId !== this.options.ownerId() || !String(user.scope).split(/\s+/).includes("im:message.send_as_user")) throw new Error("本人身份尚缺 im:message.send_as_user 用户授权。");
      }
      let group=false;
      if(chatId){
        const {data}=await this.cli(["im","chats","get","--as",identity,"--chat-id",chatId]);
        if(!["group","p2p"].includes(data?.chat_mode))throw new Error("无法确认目标会话类型，未发送。");
        group=data.chat_mode==="group";
        if(group&&!turn&&(this.options.groupReviewRequired?.()??true)&&!this.options.queueGroup)throw new Error("群消息必须进入隐私审批，未发送。");
      }
      if (turn) {
        turn.assertActive();
        if (!group || (this.options.groupReviewRequired?.() ?? true)) throw new Error("目标不是群聊，或群隐私模式已启用。未发送。");
      }
      const id = randomUUID(), at = new Date().toISOString();
      this.store.db.transaction(() => {
        this.store.db.prepare("INSERT INTO agent_outreach (id,requestKey,sourceThreadId,sourceLabel,sourceCwd,identity,recipientId,chatId,text,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,'sending',?)")
          .run(id,requestKey,sourceThreadId,sourceLabel,path.resolve(sourceCwd),identity,recipientId,chatId,text,at);
        if (turn) this.store.db.prepare("INSERT INTO agent_group_questions(outreachId,sourceChatId,sourceSenderId) VALUES(?,?,?)")
          .run(id,turn.source.chatId,turn.source.senderId);
      })();
      if(group&&(this.options.groupReviewRequired?.()??true)){
        this.store.db.prepare("UPDATE agent_outreach SET status='awaiting_approval' WHERE id=?").run(id);
        this.options.queueGroup!({outreachId:id,chatId,identity:identity as "bot"|"user",text});
        return this.outreach(id);
      }
      try {
        const content = turn
          ? ["--msg-type", "post", "--content", JSON.stringify({ zh_cn: { title: "", content: [[
            { tag: "at", user_id: recipientId }, { tag: "text", text: ` ${text}\n请引用这条消息回复，便于交回原任务。` }
          ]] } })]
          : ["--text", `${text}\n（小龙的助手龙小祝 · ${sourceLabel}；请回复此条消息，便于交回对应任务）`];
        const args = ["im","+messages-send","--as",identity,chatId ? "--chat-id" : "--user-id",chatId || recipientId,
          ...content,"--idempotency-key",`agent-${createHash("sha256").update(requestKey).digest("hex").slice(0,32)}`];
        const { data } = await this.cli(args);
        if (!data?.message_id || !data?.chat_id || turn && (data.chat_id !== chatId || !/^om_[A-Za-z0-9]+$/.test(data.message_id)))
          throw new Error("飞书未返回完整回执，请核对发送结果。");
        this.store.db.prepare("UPDATE agent_outreach SET status='open',messageId=?,chatId=? WHERE id=?").run(data.message_id,data.chat_id,id);
      } catch { this.store.db.prepare("UPDATE agent_outreach SET status='send_unknown',error='发送结果不确定，请先在飞书核对；不会自动重发。' WHERE id=?").run(id); }
      return this.outreach(id);
    } finally { this.sending.delete(requestKey); }
  }
  async readGroupReply(requestId: string, source: TurnSource, target: GroupTarget, waitSeconds: number,
    signal: AbortSignal, assertActive: () => void) {
    const deadline = Date.now() + waitSeconds * 1000;
    const lookup = this.store.db.prepare(`SELECT o.status,o.messageId,o.createdAt,r.payload
      FROM agent_group_questions q JOIN agent_outreach o ON o.id=q.outreachId
      LEFT JOIN agent_replies r ON r.outreachId=o.id AND r.status='turn_reply'
      WHERE q.outreachId=? AND q.sourceChatId=? AND q.sourceSenderId=? AND o.sourceThreadId=?
        AND o.chatId=? AND o.recipientId=?`);
    for (;;) {
      assertActive();
      const row = lookup.get(requestId, source.chatId, source.senderId, source.threadId, target.chatId, target.recipientId) as { status: string; messageId: string | null; createdAt: string; payload: string | null } | undefined;
      if (!row) throw new Error("原会话中没有可领取的这条跨群提问。");
      if (row.createdAt < groupQuestionCutoff()) return { requestId, status: "expired" };
      if (row.payload) {
        const message = JSON.parse(row.payload) as AgentMessage;
        let text = message.content;
        try {
          const body = JSON.parse(text) as { text?: unknown } | null;
          if (typeof body?.text === "string") text = body.text;
        } catch { /* Listener already supplied plain text. */ }
        return { requestId, status: "replied", messageId: row.messageId, reply: {
          trust: "third-party-message-data", text, messageId: message.messageId, sourceTime: message.sourceTime,
        } };
      }
      if (row.status !== "open" || Date.now() >= deadline) return { requestId, status: row.status, messageId: row.messageId };
      await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
  }
  matchGroupReply(input: { chatId: string; senderId: string; replyTo: string }): string | undefined {
    const ids = this.store.db.prepare(`SELECT o.id FROM agent_outreach o JOIN agent_group_questions q ON q.outreachId=o.id
      WHERE o.messageId=? AND o.chatId=? AND o.recipientId=? AND o.identity='bot' AND o.status='open' AND o.createdAt>=? LIMIT 2`)
      .pluck().all(input.replyTo,input.chatId,input.senderId,groupQuestionCutoff()) as string[];
    return ids.length === 1 ? ids[0] : undefined;
  }
  private captureGroupReply(message: AgentMessage, expected?: string): boolean {
    if (message.chatType !== "group" || message.messageType !== "text" || !message.replyTo || !message.content.trim()
      || !/^om_[A-Za-z0-9]+$/.test(message.messageId) || !/^ou_[A-Za-z0-9]+$/.test(message.senderId)) return false;
    return this.store.db.transaction(() => {
      const recorded = this.store.db.prepare("SELECT outreachId FROM agent_replies WHERE messageId=? AND status='turn_reply'")
        .pluck().get(message.messageId) as string | undefined;
      if (recorded) return !expected || recorded === expected;
      const request = this.matchGroupReply({ ...message, replyTo: message.replyTo! });
      if (!request || expected && request !== expected) return false;
      const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO agent_replies
        (messageId,chatId,senderId,payload,candidates,outreachId,status,createdAt) VALUES(?,?,?,?,?,?,'turn_reply',?)`)
        .run(message.messageId,message.chatId,message.senderId,JSON.stringify(message),"[]",request,new Date().toISOString());
      if (!inserted.changes) return false;
      this.close(request);
      return true;
    })();
  }
  private match(message: AgentMessage, candidates: Outreach[]) {
    const refs = [message.replyTo,message.rootId].filter(Boolean);
    let exact = candidates.filter(item => refs.includes(item.messageId ?? ""));
    if (!exact.length && refs.length) {
      const parent = this.store.db.prepare("SELECT outreachId FROM agent_replies WHERE messageId IN (?,?) AND chatId=? AND outreachId IS NOT NULL AND status!='dismissed'")
        .all(refs[0] ?? "",refs[1] ?? "",message.chatId) as { outreachId: string }[];
      exact = candidates.filter(item => parent.some(row => row.outreachId === item.id));
    }
    if (new Set(exact.map(item => item.sourceThreadId)).size === 1) return exact[0];
    // An explicit but unrelated/conflicting quote must never fall back to guessing.
    if (refs.length || message.chatType !== "p2p" || !candidates.length || new Set(candidates.map(item => item.sourceThreadId)).size !== 1) return null;
    const numeric = /^\d+$/.test(message.sourceTime) ? Number(message.sourceTime) : NaN;
    const received = Number.isFinite(numeric) ? (numeric > 10_000_000_000 ? numeric : numeric * 1000) : Date.parse(message.sourceTime);
    // Compact CLI timestamps have minute precision. Old history or an expired
    // request is still a human decision, even with a single candidate.
    return candidates.find(item => received + 60_000 >= Date.parse(item.createdAt) && received - Date.parse(item.createdAt) < 86_400_000) ?? null;
  }
  approvedGroupReceipt(outreachId:string,messageId:string,chatId:string){
    this.store.db.prepare("UPDATE agent_outreach SET status='open',messageId=?,chatId=? WHERE id=? AND status='awaiting_approval'").run(messageId,chatId,outreachId);
  }
  ingest(message: AgentMessage, identity: "bot" | "user") {
    if (!/^om_[A-Za-z0-9]+$/.test(message.messageId) || !/^ou_[A-Za-z0-9]+$/.test(message.senderId) || (identity === "user" && message.senderId === this.options.ownerId())) return false;
    if (this.store.db.prepare("SELECT 1 FROM agent_replies WHERE messageId=? AND status!='turn_reply'").get(message.messageId)) return true;
    const candidates = this.store.db.prepare("SELECT * FROM agent_outreach o WHERE chatId=? AND identity=? AND status='open' AND recipientId=? AND NOT EXISTS (SELECT 1 FROM agent_group_questions q WHERE q.outreachId=o.id) ORDER BY createdAt DESC")
      .all(message.chatId,identity,message.senderId) as Outreach[];
    if (!candidates.length) return false;
    const matched = this.match(message, candidates);
    this.store.db.prepare("INSERT OR IGNORE INTO agent_replies (messageId,chatId,senderId,payload,candidates,outreachId,status,createdAt) VALUES (?,?,?,?,?,?,?,?)")
      .run(message.messageId,message.chatId,message.senderId,JSON.stringify(message),JSON.stringify(candidates.map(item=>item.id)),matched?.id ?? null,matched ? "queued" : "needs_owner",new Date().toISOString());
    return true;
  }
  private eventMessage(event: Readonly<Record<string, unknown>>): AgentMessage | undefined {
    if (event.sender_type !== "user") return;
    return { messageId: String(event.message_id ?? event.id ?? ""), chatId: String(event.chat_id ?? ""),
      chatType: event.chat_type === "group" ? "group" : "p2p", senderId: String(event.sender_id ?? ""), senderName: String(event.sender_name ?? event.sender_id ?? ""),
      content: String(event.content ?? "").slice(0,20000), sourceTime: String(event.create_time ?? ""), messageType: String(event.message_type ?? "unknown"),
      chatName: String(event.chat_name ?? ""), replyTo: typeof event.reply_to === "string" ? event.reply_to : undefined,
      rootId: typeof event.root_id === "string" ? event.root_id : undefined };
  }
  commitGroupReply(event: Readonly<Record<string, unknown>>, expected: string): boolean {
    const message = this.eventMessage(event);
    return !!message && this.captureGroupReply(message, expected);
  }
  ingestEvent(event: Record<string, unknown>, listenerVerified = false) {
    const message = this.eventMessage(event);
    if (!message) return false;
    if (listenerVerified && this.captureGroupReply(message)) return true;
    return this.ingest(message, "bot");
  }
  async tick() {
    if (this.busy || this.closing) return; this.busy = true;
    try {
      // Re-evaluate only the candidates recorded when the message arrived: later
      // requests cannot capture old replies. This also recovers rows held by the
      // previous overly strict unquoted-message policy.
      const held = this.store.db.prepare("SELECT * FROM agent_replies WHERE status='needs_owner' AND outreachId IS NULL ORDER BY id LIMIT 100").all() as RoutedReply[];
      for (const row of held) {
        const ids = JSON.parse(row.candidates) as string[];
        const candidates = ids.map(id => this.outreach(id)).filter((item): item is Outreach => Boolean(item && item.status === "open"));
        // Closing one of several sources must not turn an ambiguous reply into
        // an automatic assignment.
        if (candidates.length !== ids.length) continue;
        const match = this.match(JSON.parse(row.payload), candidates);
        if (match) this.store.db.prepare("UPDATE agent_replies SET outreachId=?,status='queued',error=NULL,version=version+1 WHERE id=? AND status='needs_owner' AND outreachId IS NULL").run(match.id,row.id);
      }
      const rows = this.store.db.prepare("SELECT * FROM agent_replies WHERE status IN ('queued','waiting_source') ORDER BY id LIMIT 20").all() as RoutedReply[];
      for (const row of rows) {
        const target = this.outreach(row.outreachId ?? ""); if (!target) continue;
        try {
          const source = await this.bridge.inspect(target.sourceThreadId);
          if (!["queued","waiting_source"].includes(this.reply(row.id)?.status ?? "")) continue;
          if (source.archived || path.resolve(source.cwd) !== target.sourceCwd) { this.update(row.id,"needs_owner","来源会话已归档或工作目录变化，请人工确认。"); continue; }
          if (!["idle","active"].includes(source.status.type)) { this.update(row.id,"waiting_source",new SourceNotLoadedError().message); continue; }
          if (!["queued","waiting_source"].includes(this.reply(row.id)?.status ?? "")) continue;
          // Set before external mutation. A lost response is never automatically redelivered.
          this.update(row.id,"delivering");
          const turnId = await this.bridge.deliver(target.sourceThreadId, { deliveryId: row.id, task: target.sourceLabel, outreachId: target.id, message: JSON.parse(row.payload) });
          this.update(row.id,"delivered",null,turnId);
        } catch (error) {
          const state = this.reply(row.id)?.status;
          if (!["queued","waiting_source","delivering"].includes(state ?? "")) continue;
          this.update(row.id,error instanceof SourceNotLoadedError || state !== "delivering" ? "waiting_source" : "delivery_unknown",
            error instanceof Error ? error.message : "投递失败。");
        }
      }
      const notices = this.store.db.prepare("SELECT * FROM agent_replies WHERE status IN ('needs_owner','delivery_unknown') AND notified=0 LIMIT 5").all() as RoutedReply[];
      for (const row of notices) {
        try { const message = JSON.parse(row.payload) as AgentMessage;
          await this.cli(["im","+messages-send","--as","bot","--user-id",this.options.ownerId(),"--text",`小龙，收到 ${message.senderName} 的回复：${message.content.slice(0,500)}\n${row.status === "needs_owner" ? "请确认交给哪个 Agent 任务。" : "请核对原会话是否已收到，避免重复投递。"}\nForge：http://127.0.0.1:4732/agent-messaging`,"--idempotency-key",`agent-routing-${row.id}`]);
          this.store.db.prepare("UPDATE agent_replies SET notified=1 WHERE id=?").run(row.id);
        } catch { /* Owner can also resolve from Forge. */ }
      }
    } finally { this.busy = false; }
  }
  decide(id: number, body: Record<string, unknown>) {
    const row = this.reply(id);
    if (!row || row.version !== body.version || !["needs_owner","waiting_source","delivery_unknown"].includes(row.status)) throw new Error("消息状态已变化，请刷新。");
    if (body.action === "dismiss") { this.update(id,"dismissed"); return this.reply(id); }
    const candidate = this.outreach(String(body.outreachId ?? ""));
    if (!candidate || !JSON.parse(row.candidates).includes(candidate.id) || candidate.status !== "open") throw new Error("请选择此消息的有效候选任务。");
    this.store.db.prepare("UPDATE agent_replies SET outreachId=?,status='queued',error=NULL,version=version+1 WHERE id=?").run(candidate.id,id);
    return this.reply(id);
  }
  receive(threadId: string) {
    return this.store.db.prepare("SELECT r.* FROM agent_replies r JOIN agent_outreach o ON o.id=r.outreachId WHERE o.sourceThreadId=? AND r.status IN ('queued','waiting_source') ORDER BY r.id")
      .all(threadId) as RoutedReply[];
  }
  claim(threadId: string) {
    return this.store.db.transaction(() => { const rows = this.receive(threadId);
      for (const row of rows) this.update(row.id,"claimed"); return rows.map(row => this.reply(row.id)!); })();
  }
  acknowledge(threadId: string, ids: unknown) {
    if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id))) throw new Error("无效回执。");
    this.store.db.transaction(() => { for (const id of ids) this.store.db.prepare("UPDATE agent_replies SET status='delivered',error=NULL,version=version+1 WHERE id=? AND status='claimed' AND outreachId IN (SELECT id FROM agent_outreach WHERE sourceThreadId=?)").run(id,threadId); })();
  }
  close(id: string) { this.store.db.prepare("UPDATE agent_outreach SET status='closed' WHERE id=? AND status='open'").run(id); }
  start() { this.timer ??= setInterval(()=>void this.tick(),5000); this.timer.unref(); }
  async stop() { this.closing=true; if(this.timer)clearInterval(this.timer); while(this.busy || this.sending.size)await new Promise(resolve=>setTimeout(resolve,100)); }
}
export function registerAgentMessagingRoutes(app: FastifyInstance, router: AgentMessaging, authenticated: (request: FastifyRequest) => boolean) {
  app.addHook("onClose",()=>router.stop());
  for (const [method,url] of [["GET","/v1/agent-messaging"],["POST","/v1/agent-messaging/send"],["POST","/v1/agent-messaging/:id/decision"],["POST","/v1/agent-messaging/outreach/:id/close"],["GET","/v1/agent-messaging/receive/:threadId"],["POST","/v1/agent-messaging/receive/:threadId/ack"],["POST","/v1/agent-messaging/receive/:threadId/claim"]] as const) {
    app.route({method,url,handler:async(request,reply)=>{
      if(!authenticated(request))return reply.code(401).send({error:"unauthorized"});
      const params=request.params as {id?:string;threadId?:string},body=(request.body??{}) as Record<string,unknown>;
      try {
        if(url.endsWith("/send"))return await router.send(body);
        if(url.endsWith("/decision"))return router.decide(Number(params.id),body);
        if(url.endsWith("/close")){router.close(params.id!);return {ok:true};}
        if(url.endsWith("/claim"))return {replies:router.claim(params.threadId!)};
        if(url.endsWith("/ack")){router.acknowledge(params.threadId!,body.ids);return {ok:true};}
        if(params.threadId)return {replies:router.receive(params.threadId)};
        return router.snapshot();
      }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"请求失败。"});}
    }});
  }
}
