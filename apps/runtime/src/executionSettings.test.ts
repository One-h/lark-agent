import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { buildLarkCodexPrompt, buildLarkCodexThreadParams, buildLarkCodexTurnParams, config, isTrustedLarkSender } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("execution settings persist, share the actual trust gate, and use the saved workspace after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-execution-settings-"));
  const oldWorkspace = path.join(root, "old"); const nextWorkspace = path.join(root, "next");
  fs.mkdirSync(oldWorkspace); fs.mkdirSync(nextWorkspace);
  const options = {databasePath: path.join(root, "test.sqlite"), mode: "shadow" as const, trustedSenderIds: ["ou_trusted"], approverId: "ou_owner", workspaceRoot: oldWorkspace};
  let runtime = createRuntime(options);
  const patch = (payload: Record<string, unknown>) => runtime.app.inject({method: "PATCH", url: "/v1/settings", payload});
  try {
    assert.equal((await runtime.app.inject({method: "GET", url: "/v1/settings"})).json().trustedExecutionEnabled, false);
    assert.equal(isTrustedLarkSender("ou_trusted"), false);
    assert.equal(isTrustedLarkSender("ou_owner"), false);
    const enabled = await patch({trustedExecutionEnabled: true, workspaceRoot: nextWorkspace + "/../next"});
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().workspaceRoot, nextWorkspace);
    assert.equal(enabled.json().trustedExecutionEnabled, true);
    assert.equal(config.workspaceRoot, nextWorkspace);
    assert.equal(buildLarkCodexThreadParams(true).cwd, nextWorkspace);
    assert.equal(buildLarkCodexTurnParams({input: [], messageId: "om", trustedSender: true}, "thread").cwd, nextWorkspace);
    assert.equal(isTrustedLarkSender("ou_trusted"), true);
    assert.equal(isTrustedLarkSender("ou_owner"), true);
    assert.equal(isTrustedLarkSender("ou_other"), false);
    const prompt = buildLarkCodexPrompt({content: "排查", chat_type: "p2p", sender_id: "ou_trusted", reply_to_message_id: null, reply_to_message_type: null, reply_to_content: null});
    assert(prompt.includes(path.join(nextWorkspace, "AGENTS.md")));
    for (const invalid of [null, "true", 1]) {
      assert.equal((await patch({trustedExecutionEnabled: invalid, workspaceRoot: oldWorkspace})).statusCode, 400);
      assert.equal(config.workspaceRoot, nextWorkspace);
    }
    fs.writeFileSync(path.join(root, "not-a-directory"), "fixture");
    for (const invalid of ["relative", "", path.join(root, "missing"), path.join(root, "not-a-directory"), null]) {
      assert.equal((await patch({workspaceRoot: invalid, trustedExecutionEnabled: false})).statusCode, 400);
      assert.equal(isTrustedLarkSender("ou_trusted"), true);
    }
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal(config.workspaceRoot, nextWorkspace);
    assert.equal(isTrustedLarkSender("ou_owner"), true);
    assert.equal((await patch({trustedExecutionEnabled: false})).json().trustedExecutionEnabled, false);
    assert.equal(isTrustedLarkSender("ou_trusted"), false);
    assert.equal(isTrustedLarkSender("ou_owner"), false);
    assert.equal(buildLarkCodexThreadParams(isTrustedLarkSender("ou_trusted")).sandbox, "read-only");
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal(isTrustedLarkSender("ou_trusted"), false);
    assert.equal((await runtime.app.inject({method: "GET", url: "/v1/settings"})).json().workspaceRoot, nextWorkspace);
    await patch({approverId: ""});
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal((await runtime.app.inject({method: "GET", url: "/v1/settings"})).json().approverId, "");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, {recursive: true, force: true}); }
});

test("running or queued work prevents partial directory or trust changes without deleting history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-busy-"));
  const next = path.join(root, "next"); fs.mkdirSync(next);
  const runtime = createRuntime({databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: ["ou_trusted"], workspaceRoot: root});
  try {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages(id,content,codex_status,raw_json,received_at,created_at) VALUES (1,'保留历史','running','{}',?,?)").run(now, now);
    for (const status of ["running", "queued"]) {
      runtime.store.db.prepare("UPDATE lark_messages SET codex_status=? WHERE id=1").run(status);
      const denied = await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {workspaceRoot: next, trustedExecutionEnabled: true}});
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(config.workspaceRoot, root);
      assert.equal(isTrustedLarkSender("ou_trusted"), false);
      for (const payload of [{trustedSenderIds: []}, {approverId: "ou_new"}]) {
        assert.equal((await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload})).statusCode, 409);
        assert.deepEqual((await runtime.app.inject({method: "GET", url: "/v1/settings"})).json().trustedSenderIds, ["ou_trusted"]);
      }
      const same = await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {workspaceRoot: root, trustedExecutionEnabled: false}});
      assert.equal(same.statusCode, 200);
    }
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    assert.equal((await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {workspaceRoot: next}})).statusCode, 200);
    assert.equal((runtime.store.db.prepare("SELECT content FROM lark_messages WHERE id=1").get() as {content: string}).content, "保留历史");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, {recursive: true, force: true}); }
});

test("permission changes wait for an in-flight host call even without a native running message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-host-settings-busy-"));
  const host = Fastify(); let release: (() => void) | undefined; let entered = false;
  host.post("/api/lark-agent/capabilities/local.write", async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return {ok: true}; });
  await host.listen({host: "127.0.0.1", port: 0});
  const address = host.server.address(); assert(address && typeof address !== "string");
  const runtime = createRuntime({ runtimeToken: "test-token",databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: ["ou_trusted"], workspaceRoot: root,
    turnActivityProbe: async () => true, hostBaseUrl: `http://127.0.0.1:${address.port}`});
  let pending: Promise<unknown> | undefined;
  try {
    await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedExecutionEnabled: true}});
    runtime.store.registerCapabilities([{id: "local.write", title: "写入", description: "fixture", inputSchema: {}, risk: "local-write"}]);
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages(id,chat_id,sender_id,content,codex_status,codex_turn_id,raw_json,received_at,created_at) VALUES (1,'oc','ou_trusted','fixture','running','fixture-turn','{}',?,?)").run(now, now);
    pending = Promise.resolve(runtime.app.inject({ headers: { authorization: "Bearer test-token" },method: "POST", url: "/v1/internal/capabilities/local.write/execute", payload: {input: {}, context: {larkMessageId: 1, chatId: "oc", trustScope: "trusted", turnId: "fixture-turn"}}}));
    for (let i = 0; !entered && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(entered, true);
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    assert.equal((await runtime.app.inject({method:"PATCH",url:"/v1/group-privacy",headers:{authorization:"Bearer test-token"},payload:{enabled:true}})).statusCode,409);
    for (const payload of [{trustedExecutionEnabled: false}, {trustedSenderIds: []}, {approverId: "ou_new"}]) {
      assert.equal((await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload})).statusCode, 409);
    }
    release!(); await pending;
    assert.equal((await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedSenderIds: []}})).statusCode, 200);
  } finally { release?.(); await pending; await runtime.app.close(); runtime.stop(); await host.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test("disabling trusted execution also gates host local-write capabilities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-host-trust-setting-"));
  const host = Fastify(); let calls = 0; let cards = 0;
  host.post("/api/lark-agent/capabilities/local.write", async () => ({calls: ++calls}));
  await host.listen({host: "127.0.0.1", port: 0});
  const address = host.server.address(); assert(address && typeof address !== "string");
  const runtime = createRuntime({ runtimeToken: "test-token",databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: ["ou_trusted"], approverId: "ou_owner",
    turnActivityProbe: async () => true, hostBaseUrl: `http://127.0.0.1:${address.port}`, approvalCardSender: () => { cards++; return {ok: false, error: "fixture rejected"}; }});
  try {
    const now = new Date().toISOString();
    runtime.store.registerCapabilities([{id: "local.write", title: "写入", description: "fixture", inputSchema: {}, risk: "local-write"}]);
    runtime.store.db.prepare("INSERT INTO lark_messages(id,chat_id,sender_id,content,raw_json,received_at,created_at) VALUES (1,'oc_test','ou_trusted','fixture','{}',?,?)").run(now, now);
    await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedExecutionEnabled: true}});
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='running',codex_turn_id='before' WHERE id=1").run();
    const invoke = (trustScope: string, turnId: string) => runtime.app.inject({ headers: { authorization: "Bearer test-token" },method: "POST", url: "/v1/internal/capabilities/local.write/execute", payload: {input: {}, context: {larkMessageId: 1, chatId: "oc_test", trustScope, turnId}}});
    assert.equal((await invoke("trusted", "before")).statusCode, 200);
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedExecutionEnabled: false}});
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='running',codex_turn_id='after' WHERE id=1").run();
    assert.notEqual((await invoke("trusted", "forged")).statusCode, 200);
    assert.notEqual((await invoke("untrusted", "after")).statusCode, 200);
    assert.equal(cards, 1);
    assert.equal(calls, 1);
    const rows = (await runtime.app.inject({method: "GET", url: "/v1/messages"})).json();
    assert.equal(rows[0].trust_scope, "untrusted");
  } finally { await runtime.app.close(); runtime.stop(); await host.close(); fs.rmSync(root, {recursive: true, force: true}); }
});
