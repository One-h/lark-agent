import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationPersona, getConversationExecutionSettings, type ExecutionEngine } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("managed group creation validates, persists, configures and deduplicates without ingesting a message", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lark-managed-chat-"));
  const engines: ExecutionEngine[] = [{
    descriptor: { id: "example", label: "Fixture", models: ["fixture-model"] },
    supportsPolicy: () => true,
    open: async () => { throw new Error("Group creation does not start an execution engine"); }
  }, {
    descriptor: { id: "default-only", label: "Default-only fixture", models: [] },
    supportsPolicy: () => true,
    open: async () => { throw new Error("Group creation does not start an execution engine"); }
  }];
  const calls: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const runtime = createRuntime({ databasePath: path.join(root, "fixture.sqlite"), mode: "shadow",
    trustedSenderIds: ["ou_owner"], approverId: "ou_owner", runtimeToken: "fixture-token", executionEngines: engines,
    managedChatCreator: async ({ ownerId, name, requestId }) => {
      assert.equal(ownerId, "ou_owner");
      calls.push(requestId);
      if (name === "Network timeout") throw new Error("PRIVATE_CLI_DIAGNOSTIC");
      if (name === "Unconfirmed owner") return { chatId: "oc_partial", ownerConfirmed: false };
      started();
      await wait;
      return { chatId: name === "Default group" ? "oc_defaults" : name === "Engine default group" ? "oc_enginedefaults" : "oc_created", ownerConfirmed: true };
    } });
  const url = "/v1/managed-chats";
  const headers = { authorization: "Bearer fixture-token" };
  const create = (payload: Record<string, unknown>) => runtime.app.inject({ method: "POST", url, headers, payload });
  const list = () => runtime.app.inject({ url, headers });
  try {
    const requestId = randomUUID();
    const input = { requestId, name: "  Example group  ",
      persona: { mode: "custom", name: "Fixture persona", instructions: "Respond concisely." },
      execution: { engineId: "example", model: "fixture-model" } };
    assert.equal((await runtime.app.inject({ url })).statusCode, 401);
    assert.equal((await runtime.app.inject({ method: "POST", url, payload: input })).statusCode, 401);
    assert.equal((await runtime.app.inject({ url, headers, remoteAddress: "192.0.2.1" })).statusCode, 401);
    assert.equal((await create({ ...input, ownerId: "ou_other" })).statusCode, 400);
    assert.equal((await create({ ...input, persona: { ...input.persona, instructions: "" } })).statusCode, 400);
    assert.equal((await create({ ...input, execution: { ...input.execution, model: "missing" } })).statusCode, 400);
    assert.equal((await create({ ...input, execution: { engineId: "missing", model: null } })).statusCode, 400);
    assert.equal((await create({ ...input, execution: { engineId: "default-only" } })).statusCode, 400);
    assert.equal((await create({ ...input, execution: { engineId: "default-only", model: "not-in-catalog" } })).statusCode, 400);
    assert.equal(calls.length, 0);
    assert.deepEqual((await list()).json().items, []);
    const pending = create(input);
    await dispatched;
    try {
      assert.equal((await list()).json().items[0].status, "creating");
      assert.equal((await create(input)).statusCode, 409);
      assert.equal((await create({ ...input, name: "Different group" })).statusCode, 409);
      assert.deepEqual(calls, [requestId]);
    } finally { release(); }
    const created = await pending;
    assert.equal(created.statusCode, 200, created.body);
    const { item } = created.json();
    assert.equal(item.name, "Example group");
    assert.equal(item.status, "ready");
    assert.equal(item.openUrl, "https://applink.feishu.cn/client/chat/open?openChatId=oc_created");
    assert.equal(conversationPersona("oc_created").name, input.persona.name);
    assert.deepEqual(getConversationExecutionSettings("oc_created").override, input.execution);
    assert.deepEqual((await create(input)).json(), { item });
    assert.deepEqual(calls, [requestId]);
    assert.deepEqual((await list()).json().engines.find((row: { id: string }) => row.id === "example"), engines[0].descriptor);

    const defaults = await create({ requestId: randomUUID(), name: "Default group" });
    assert.equal(defaults.statusCode, 200, defaults.body);
    assert.equal(conversationPersona("oc_defaults").mode, "default");
    assert.equal(getConversationExecutionSettings("oc_defaults").override, null);
    const defaultEngine = { engineId: "default-only", model: null };
    const engineInput = { requestId: randomUUID(), name: "Engine default group", execution: defaultEngine };
    const withEngine = await create(engineInput);
    assert.equal(withEngine.statusCode, 200, withEngine.body);
    assert.deepEqual(withEngine.json().item.execution, defaultEngine);
    assert.deepEqual(getConversationExecutionSettings("oc_enginedefaults").effective, defaultEngine);
    const listed = (await list()).json();
    assert.deepEqual(listed.engines.find((row: { id: string }) => row.id === defaultEngine.engineId), engines[1].descriptor);
    assert.deepEqual(listed.items.find((row: { requestId: string }) => row.requestId === engineInput.requestId).execution, defaultEngine);
    const uncertain = { requestId: randomUUID(), name: "Network timeout" };
    const failure = await create(uncertain);
    assert.equal(failure.statusCode, 409);
    assert.doesNotMatch(failure.body, /PRIVATE_CLI_DIAGNOSTIC/);
    assert.equal((await create(uncertain)).statusCode, 409);
    assert.equal(calls.filter(id => id === uncertain.requestId).length, 1);
    const partial = { requestId: randomUUID(), name: "Unconfirmed owner", persona: input.persona };
    assert.equal((await create(partial)).statusCode, 409);
    const partialRow = (await list()).json().items.find((row: { requestId: string }) => row.requestId === partial.requestId);
    assert.equal(partialRow.status, "attention");
    assert.equal(partialRow.chatId, "oc_partial");
    assert.equal(conversationPersona("oc_partial").mode, "default");
    assert.deepEqual(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM lark_messages").get(), { count: 0 });
    const synthetic = await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: {
      message_id: "om_synthetic", chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_owner", sender_type: "user",
      listener_verified: 1, content: "Fixture only"
    } });
    assert.equal(synthetic.statusCode, 200);
    assert.equal(runtime.store.db.prepare("SELECT listener_verified FROM lark_messages WHERE message_id='om_synthetic'").pluck().get(), 0);
  } finally {
    release();
    await runtime.app.close();
    runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
