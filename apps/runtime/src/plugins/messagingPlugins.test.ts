import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { applyLarkRoute } from "../../../../packages/conversation-runtime/src/runtimeHooks.js";
import { AgentMessaging } from "../agentMessaging.js";
import { PersonalInbox } from "../personalInbox.js";
import { disableGroupQuestionPlugin, groupAskCapability, groupReplyCapability, mountGroupQuestionPlugin,
  mountOutreachPlugin, mountPersonalInboxPlugin } from "./messagingPlugins.js";

async function withStore(run: (store: SqliteAgentStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "lark-messaging-plugins-"));
  const store = new SqliteAgentStore(join(root, "test.sqlite"));
  try { await run(store, root); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("messaging mounts preserve route authorization and only start in active mode", async t => {
  const outreachStart = t.mock.method(AgentMessaging.prototype, "start");
  const inboxStart = t.mock.method(PersonalInbox.prototype, "start");
  const outreachStop = t.mock.method(AgentMessaging.prototype, "stop");
  const inboxStop = t.mock.method(PersonalInbox.prototype, "stop");
  await withStore(async store => {
    const authorized = (request: FastifyRequest) => request.headers.authorization === "Bearer fixture";
    const ownerId = () => "ou_Owner";
    for (const active of [false, true]) {
      const app = Fastify();
      const outreach = mountOutreachPlugin({ app, store, options: { ownerId }, authorized, active });
      const inbox = mountPersonalInboxPlugin({ app, store, options: { ownerId, model: () => "fixture" }, authorized, active });
      try {
        assert.equal(outreachStart.mock.callCount(), Number(active));
        assert.equal(inboxStart.mock.callCount(), Number(active));
        for (const [url, expected] of [["/v1/agent-messaging", outreach.snapshot()],
          ["/v1/personal-inbox", { status: inbox.status(), messages: inbox.rows() }]] as const) {
          assert.equal((await app.inject({ url })).statusCode, 401);
          const response = await app.inject({ url, headers: { authorization: "Bearer fixture" } });
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.json(), expected);
        }
      } finally { await app.close(); }
      assert.equal(outreachStop.mock.calls.at(-1)?.this, outreach);
      assert.equal(inboxStop.mock.calls.at(-1)?.this, inbox);
    }
  });
});

test("group-question mount claims verified text quotes; disposal leaves stored registrations and history", async () => {
  await withStore(async (store, root) => {
    const target = { chatId: "oc_Builders", recipientId: "ou_Peer" };
    const agentMessaging = new AgentMessaging(store, {
      ownerId: () => "ou_Owner", groupReviewRequired: () => false,
      cli: async args => ({ data: args[1] === "chats" ? { chat_mode: "group" }
        : { message_id: "om_Question", chat_id: target.chatId } })
    });
    const source = { threadId: "00000000-0000-4000-8000-000000000001", chatId: "oc_Source", senderId: "ou_Source" };
    const { requestId, messageId } = await agentMessaging.askGroup({ source, sourceCwd: root, target,
      requestKey: "fixture_question", text: "Status?", assertActive: () => {} });
    const event = { message_id: "om_Answer", chat_id: target.chatId, chat_type: "group", sender_id: target.recipientId,
      sender_type: "user", message_type: "text", content: "Ready", reply_to: messageId };
    store.registerCapabilities([{ id: "fixture.other", title: "Other", description: "Unrelated", inputSchema: {}, risk: "read" }]);
    const capabilities = () => store.db.prepare("SELECT id,risk FROM capabilities ORDER BY id").all();
    const registered = [{ id: "fixture.other", risk: "read" }, { id: "lark.group.ask", risk: "external-write" },
      { id: "lark.group.ask_reply", risk: "read" }];
    assert.equal(groupAskCapability, "lark.group.ask");
    assert.equal(groupReplyCapability, "lark.group.ask_reply");

    const dispose = mountGroupQuestionPlugin({ store, agentMessaging });
    try {
      assert.deepEqual(capabilities(), registered);
      assert.equal(applyLarkRoute(store.db, event, false), false);
      assert.equal(applyLarkRoute(store.db, { ...event, sender_id: "ou_Other" }, true), false);
      assert.equal(applyLarkRoute(store.db, { ...event, message_type: "image" }, true), false);
      assert.equal(applyLarkRoute(store.db, { ...event, reply_to: "om_Unrelated" }, true), false);
    } finally { dispose(); }
    assert.equal(applyLarkRoute(store.db, event, true), false);
    assert.deepEqual(capabilities(), registered);

    const disposeAgain = mountGroupQuestionPlugin({ store, agentMessaging });
    try {
      dispose(); // A stale disposer cannot remove the new registration.
      assert.equal(applyLarkRoute(store.db, event, true), true);
      disableGroupQuestionPlugin(store);
      assert.deepEqual(capabilities(), [{ id: "fixture.other", risk: "read" }]);
      const reply = await agentMessaging.readGroupReply(requestId, source, target, 0, new AbortController().signal, () => {});
      assert.equal(reply.status, "replied");
      assert.equal(reply.reply?.text, "Ready");
    } finally { disposeAgain(); }
  });
});
