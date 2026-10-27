import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { PersonalInbox, registerPersonalInboxRoutes } from "./personalInbox.js";
import { automaticReplyAllowed } from "./personalInboxReview.js";
import { normalizePersonalMessage, type PersonalInboxTransport, type PersonalMessage } from "./personalInboxTransport.js";

const message: PersonalMessage = { messageId: "om_test", chatId: "oc_personal", chatType: "p2p", chatName: "同事",
  senderId: "ou_colleague", senderName: "同事", content: "你好", sourceTime: "2026-10-26 20:00", messageType: "text" };
async function fixture(run: (context: { inbox: PersonalInbox; store: SqliteAgentStore; transport: PersonalInboxTransport; sent: string[]; advance: () => void }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-personal-inbox-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  let at = new Date("2026-10-27T03:00:00Z");
  const sent: string[] = [];
  const transport: PersonalInboxTransport = {
    identity: async () => ({ ownerId: "ou_owner", botId: "ou_bot", canSend: true }),
    collect: async () => [], ownerReplied: async () => false,
    send: async (_message, text, key) => { sent.push(text + key); return "om_sent"; }, notify: async () => {}
  };
  const inbox = new PersonalInbox(store, { ownerId: () => "ou_owner", model: () => "fixture", transport, now: () => at });
  try { await run({ inbox, store, transport, sent, advance: () => { at = new Date(at.getTime() + 60_000); } }); }
  finally { await inbox.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("personal inbox excludes owner, bot and @all; only direct owner mentions qualify", () => {
  const row = { message_id: "om_test", chat_id: "oc_test", sender: { id: "ou_colleague", sender_type: "user" }, content: "hello", msg_type: "text" };
  assert.equal(normalizePersonalMessage(row, "group", "ou_owner"), null);
  assert.equal(normalizePersonalMessage({ ...row, mentions: [{ id: "all" }] }, "group", "ou_owner"), null);
  assert.ok(normalizePersonalMessage({ ...row, mentions: [{ id: "ou_owner" }] }, "group", "ou_owner"));
  assert.equal(normalizePersonalMessage({ ...row, sender: { id: "ou_owner", sender_type: "user" } }, "p2p", "ou_owner"), null);
  assert.equal(normalizePersonalMessage({ ...row, sender: { id: "ou_bot", sender_type: "bot" } }, "p2p", "ou_owner"), null);
});

test("automatic authority is a narrow deterministic rule, not a model claim", () => {
  assert.equal(automaticReplyAllowed(message), true);
  assert.equal(automaticReplyAllowed({ ...message, content: "你好，请批准合同" }), false);
  assert.equal(automaticReplyAllowed({ ...message, messageType: "file" }), false);
});

test("activation pins the user, starts at now, deduplicates repeated polling and sends only once", async () => fixture(async ({ inbox, transport, sent, advance }) => {
  await inbox.configure({ enabled: true }); await inbox.tick();
  assert.equal(inbox.status().activatedAt, "2026-10-27T03:00:00.000Z");
  transport.collect = async start => { assert.ok(start >= inbox.status().activatedAt); return [message, message]; };
  advance(); await inbox.tick(); await inbox.tick();
  assert.equal(inbox.rows().length, 1); assert.equal(sent.length, 1);
  assert.match(sent[0], /小龙的助手龙小祝代为回复/); assert.equal(inbox.rows()[0].status, "sent");
}));

test("a failed or truncated poll never advances its recovery cursor", async () => fixture(async ({ inbox, transport, advance }) => {
  await inbox.configure({ enabled: true }); await inbox.tick(); const before = inbox.status().lastSyncAt;
  advance(); transport.collect = async () => { throw new Error("partial search"); }; await inbox.tick();
  assert.equal(inbox.status().lastSyncAt, before); assert.equal(inbox.status().lastError, "partial search");
}));

test("missing user-send scope retains draft and resumes after authorization without duplicate send", async () => fixture(async ({ inbox, transport, sent, advance }) => {
  transport.identity = async () => ({ ownerId: "ou_owner", botId: "ou_bot", canSend: false });
  await inbox.configure({ enabled: true }); await inbox.tick(); inbox.ingest([message]); advance(); await inbox.tick();
  assert.equal(inbox.rows()[0].status, "awaiting_auth"); assert.equal(sent.length, 0);
  transport.identity = async () => ({ ownerId: "ou_owner", botId: "ou_bot", canSend: true });
  await inbox.tick(); await inbox.tick(); assert.equal(sent.length, 1); assert.equal(inbox.rows()[0].status, "sent");
}));

test("owner replies suppress automated and manually approved replies", async () => fixture(async ({ inbox, transport, sent }) => {
  await inbox.configure({ enabled: true }); await inbox.tick(); inbox.ingest([message]);
  transport.ownerReplied = async () => true; await inbox.tick();
  assert.equal(inbox.rows()[0].status, "owner_replied"); assert.equal(sent.length, 0);
}));

test("sensitive messages ask owner and stale decisions cannot send", async () => fixture(async ({ inbox, sent }) => {
  await inbox.configure({ enabled: true }); await inbox.tick(); inbox.ingest([{ ...message, content: "合同和付款请审批" }]); await inbox.tick();
  const row = inbox.rows()[0]; assert.equal(row.status, "needs_owner"); assert.equal(sent.length, 0);
  await assert.rejects(inbox.decide(row.id, { action: "send", text: "同意", version: row.version - 1 }), /已更新/);
  await inbox.decide(row.id, { action: "send", text: "我需要核对后再回复你。", version: row.version });
  assert.equal(sent.length, 1);
}));

test("ambiguous network result is never automatically retried", async () => fixture(async ({ inbox, transport, sent }) => {
  await inbox.configure({ enabled: true }); await inbox.tick(); inbox.ingest([message]);
  transport.send = async () => { sent.push("attempt"); throw new Error("response lost"); };
  await inbox.tick(); await inbox.tick();
  assert.equal(inbox.rows()[0].status, "send_unknown"); assert.equal(sent.length, 1);
}));

test("switching user identity stops collection and does not change pinned owner", async () => fixture(async ({ inbox, transport }) => {
  await inbox.configure({ enabled: true }); await inbox.tick();
  transport.identity = async () => ({ ownerId: "ou_other", botId: "ou_bot", canSend: true }); await inbox.tick();
  assert.match(inbox.status().lastError ?? "", /账号发生变化/); assert.equal(inbox.status().ownerId, "ou_owner");
}));

test("API requires authentication and returns no private inbox to an unauthenticated caller", async () => fixture(async ({ inbox }) => {
  const app = Fastify(); registerPersonalInboxRoutes(app, inbox, request => request.headers.authorization === "Bearer test");
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/personal-inbox" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/v1/personal-inbox", headers: { authorization: "Bearer test" } })).statusCode, 200);
  } finally { await app.close(); }
}));
