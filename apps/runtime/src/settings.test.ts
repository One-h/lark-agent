import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { captureConversationStyle, config, isTrustedLarkSender } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

const booleanFields = ["trustedExecutionEnabled", "listenerEnabled", "repliesEnabled", "interimRepliesEnabled", "executionReceiptsEnabled", "groupMessageReactionEnabled", "groupSpontaneousRepliesEnabled", "turnAutoApprovalEnabled", "ownerMessageFastPathEnabled", "topicNativeModeEnabled"];
const savedRows = (runtime: ReturnType<typeof createRuntime>) => runtime.store.db.prepare("SELECT * FROM settings ORDER BY key").all();
const settings = async (runtime: ReturnType<typeof createRuntime>) => (await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json();
const patch = (runtime: ReturnType<typeof createRuntime>, payload: unknown) => runtime.app.inject({ method: "PATCH", url: "/v1/settings", headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

test("settings reject every invalid writable field and mixed unknown fields before any writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-validation-"));
  const next = path.join(root, "next"); fs.mkdirSync(next);
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", workspaceRoot: root, trustedSenderIds: ["ou_old"], approverId: "ou_owner" });
  try {
    const before = await settings(runtime); const rows = savedRows(runtime);
    const invalid: Record<string, unknown[]> = {
      ...Object.fromEntries(booleanFields.map(key => [key, [null, "false", 0, 1, [], {}]])),
      workspaceRoot: [null, "", "relative", path.join(root, "missing"), 1],
      approverId: [null, 1, "x".repeat(201)],
      trustedSenderIds: [null, "ou_one", [1], ["bad"], ["ou_" + "x".repeat(198)], Array(202).fill("ou_one")],
      groupMessageReactionChatIds: [null, "oc_one", [1], ["oc_bad.id"], Array(201).fill("oc_one")],
      groupSpontaneousChatIds: [null, "oc_one", [1], ["*"], Array(201).fill("oc_one")],
      acknowledgeReactionEmoji: [null, 1, "NOTANEMOJI", "thumbsup", " THUMBSUP "],
      groupMessageReactionEmoji: [null, 1, "NOTANEMOJI"],
      codexModel: [null, 1, "", "bad model", "../model", "x".repeat(121)],
      turnAutoApprovalModel: [null, 1, "", "bad model", "x".repeat(121)],
      turnAutoApprovalDataSources: [null, "analytics_demo", [1], ["*"], ["bad source"], ["x".repeat(65)], Array(101).fill("analytics_demo")],
      reasoningEffort: [null, 1, "minimal", "LOW"],
      stickerUsageMode: [null, 1, "sometimes"],
      groupSpontaneousReplyRate: [null, "0", -0.1, 1.1],
      groupSpontaneousReplyCooldownMs: [null, "0", -1, 0.5, 604_800_001],
      groupContextMessageLimit: [null, "1", 0, 1.5, 201],
      groupContextMaxChars: [null, "500", 499, 500.5, 30_001]
    };
    assert.equal(Object.keys(invalid).length, 26);
    for (const [key, values] of Object.entries(invalid)) {
      for (const value of values) {
        const result = await patch(runtime, { workspaceRoot: next, repliesEnabled: false, [key]: value });
        assert.equal(result.statusCode, 400, `${key}=${JSON.stringify(value)}: ${result.body}`);
        assert.deepEqual(savedRows(runtime), rows, key);
        assert.deepEqual(await settings(runtime), before, key);
        assert.equal(config.workspaceRoot, root);
      }
    }
    for (const payload of [null, [], ["repliesEnabled"], true, 0, "settings", { repliesEnabled: false, workspaceRoot: next, unknownSetting: true }, { listenerRunning: false }, { codexReasoningEffort: "low" }]) {
      const result = await patch(runtime, payload);
      assert.equal(result.statusCode, 400, result.body);
      assert.deepEqual(savedRows(runtime), rows);
    }
    const invalidOwner = await patch(runtime, { approverId: "", ownerMessageFastPathEnabled: true, repliesEnabled: false });
    assert.equal(invalidOwner.statusCode, 400);
    assert.deepEqual(savedRows(runtime), rows);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings roll back all fields, workspace snapshots and receipt suppression on SQLite failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-transaction-"));
  const next = path.join(root, "next"); fs.mkdirSync(next);
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, workspaceRoot: root, trustedSenderIds: ["ou_old"], approverId: "ou_owner" };
  const runtime = createRuntime(options);
  try {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES ('oc_one::trusted','oc_one','trusted','thread-old',?,?)").run(now, now);
    runtime.store.db.prepare("INSERT INTO lark_execution_receipts (lark_message_id,turn_id,status,entries_json,next_attempt_at,created_at,updated_at) VALUES (1,'turn-one','completed','[]',?,?,?)").run(now, now, now);
    const before = await settings(runtime); const rows = savedRows(runtime);
    const payload = { workspaceRoot: next, trustedExecutionEnabled: true, trustedSenderIds: ["ou_new"], approverId: "ou_new", repliesEnabled: false, ownerMessageFastPathEnabled: true, executionReceiptsEnabled: false, listenerEnabled: true, turnAutoApprovalModel: "gpt-6-sol" };
    const receipt = () => runtime.store.db.prepare("SELECT * FROM lark_execution_receipts").all();
    const receiptBefore = receipt();
    for (const trigger of [
      "CREATE TRIGGER fail_setting BEFORE INSERT ON settings WHEN NEW.key='turnAutoApprovalModel' BEGIN SELECT RAISE(ABORT, 'setting failure'); END",
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON lark_execution_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"
    ]) {
      runtime.store.db.exec(trigger);
      const failed = await patch(runtime, payload);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(savedRows(runtime), rows);
      assert.deepEqual(receipt(), receiptBefore);
      assert.deepEqual(await settings(runtime), before);
      assert.deepEqual(options.trustedSenderIds, ["ou_old"]);
      assert.equal(config.workspaceRoot, root);
      assert.equal(config.larkExecutionApproverId, "ou_owner");
      assert.equal(isTrustedLarkSender("ou_new"), false);
      runtime.store.db.exec("DROP TRIGGER IF EXISTS fail_setting; DROP TRIGGER IF EXISTS fail_receipt");
    }
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings persist all 24 fields, normalized sets, false and zero with identical PATCH and recreated GET", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-readback-"));
  const next = path.join(root, "next"); fs.mkdirSync(next);
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, workspaceRoot: root, trustedSenderIds: ["ou_old"], approverId: "ou_env" };
  let runtime = createRuntime(options);
  try {
    const now = new Date().toISOString();
    for (const thread of ["old", "known"]) runtime.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES (?,?,'trusted',?,?,?)").run(`oc_${thread}::trusted`, `oc_${thread}`, thread, now, now);
    runtime.store.setSetting("codex.threadWorkspace:known", "/previous-workspace");
    const payload = {
      workspaceRoot: next + "/../next", trustedExecutionEnabled: true, trustedSenderIds: [" ou_new ", "ou_new"], approverId: " ou_new ",
      listenerEnabled: false, repliesEnabled: true, interimRepliesEnabled: true, executionReceiptsEnabled: true, topicNativeModeEnabled: true,
      groupMessageReactionEnabled: true, groupMessageReactionEmoji: "GeneralDoNotDisturb", groupMessageReactionChatIds: [" oc_one ", "oc_one", "oc_two"],
      acknowledgeReactionEmoji: "Status_PrivateMessage", groupSpontaneousRepliesEnabled: true, groupSpontaneousChatIds: [" oc_two ", "oc_two"],
      groupSpontaneousReplyRate: 1, groupSpontaneousReplyCooldownMs: 604_800_000, groupContextMessageLimit: 200, groupContextMaxChars: 30_000,
      codexModel: " gpt-6-sol ", reasoningEffort: "ultra", stickerUsageMode: "always", turnAutoApprovalEnabled: true, turnAutoApprovalModel: " gpt-6-sol ", turnAutoApprovalDataSources: [" Analytics_Demo ", "analytics_demo", "orders_demo"], ownerMessageFastPathEnabled: true
    };
    assert.equal(Object.keys(payload).length, 26);
    const result = await patch(runtime, payload);
    assert.equal(result.statusCode, 200, result.body);
    const expected = { ...payload, workspaceRoot: next, trustedSenderIds: ["ou_new"], approverId: "ou_new", groupMessageReactionChatIds: ["oc_one", "oc_two"], groupSpontaneousChatIds: ["oc_two"], codexModel: "gpt-6-sol", turnAutoApprovalModel: "gpt-6-sol", turnAutoApprovalDataSources: ["analytics_demo", "orders_demo"] };
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.json()[key], value, key);
    assert.equal(result.json().ownerMessageFastPathOwnerId, "ou_new");
    assert.deepEqual(await settings(runtime), result.json());
    assert.equal(runtime.store.setting("codexReasoningEffort", ""), "ultra");
    assert.equal(runtime.store.setting("codex.threadWorkspace:old", ""), root);
    assert.equal(runtime.store.setting("codex.threadWorkspace:known", ""), "/previous-workspace");
    assert.equal(isTrustedLarkSender("ou_new"), true);
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.deepEqual(await settings(runtime), result.json());
    const zero = await patch(runtime, {
      ...Object.fromEntries(booleanFields.map(key => [key, false])), trustedSenderIds: [], approverId: "", groupMessageReactionChatIds: [], groupSpontaneousChatIds: [],
      groupSpontaneousReplyRate: 0, groupSpontaneousReplyCooldownMs: 0, groupContextMessageLimit: 1, groupContextMaxChars: 500,
      acknowledgeReactionEmoji: "2022", reasoningEffort: "low", stickerUsageMode: "off"
    });
    assert.equal(zero.statusCode, 200, zero.body);
    for (const key of booleanFields) assert.equal(zero.json()[key], false, key);
    for (const key of ["groupSpontaneousReplyRate", "groupSpontaneousReplyCooldownMs"]) assert.equal(zero.json()[key], 0, key);
    for (const key of ["trustedSenderIds", "groupMessageReactionChatIds", "groupSpontaneousChatIds"]) assert.deepEqual(zero.json()[key], [], key);
    assert.equal(zero.json().approverId, "");
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.deepEqual(await settings(runtime), zero.json());
    assert.equal(isTrustedLarkSender("ou_env"), false);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings and prompts reject unknown fields without altering conversation settings or persona snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-unknown-"));
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  try {
    for (const url of ["/v1/chats/oc_one/settings", "/v1/prompts"]) {
      const method = url.endsWith("/prompts") ? "PUT" : "PATCH";
      const before = (await runtime.app.inject({ method: "GET", url })).json();
      const valid = method === "PUT" ? { larkAssistant: "changed" } : { stickerUsageMode: "always", spontaneousMode: "on", spontaneousReplyRate: 0, spontaneousReplyCooldownMs: 0 };
      for (const payload of [{ ...valid, unexpected: true }, [], null, { unexpected: true }]) {
        const result = await runtime.app.inject({ method, url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
        assert.equal(result.statusCode, 400, result.body);
        assert.deepEqual((await runtime.app.inject({ method: "GET", url })).json(), before);
      }
    }
    for (const larkAssistant of [null, 0, true, "x".repeat(50_001)]) {
      assert.equal((await runtime.app.inject({ method: "PUT", url: "/v1/prompts", payload: { larkAssistant } })).statusCode, 400);
    }
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("persona PUT and preview accept only mode, name and instructions without changing captured snapshots on rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-persona-"));
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  const url = "/v1/chats/oc_strict/persona";
  const persona = { mode: "custom", name: "Original persona", instructions: "Original instructions" };
  try {
    const saved = await runtime.app.inject({ method: "PUT", url, payload: persona });
    assert.equal(saved.statusCode, 200, saved.body);
    const snapshot = captureConversationStyle("oc_strict");
    for (const [method, target] of [["PUT", url], ["POST", url + "/preview"]] as const) {
      for (const payload of [
        { ...persona, name: "Rejected", version: 1 }, { ...persona, updatedAt: "2026-10-22T00:00:00Z" },
        { ...persona, typo: true }, { ...persona, globalPromptHash: "unexpected" }, [], null
      ]) {
        const rejected = await runtime.app.inject({ method, url: target, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
        assert.equal(rejected.statusCode, 400, rejected.body);
        assert.equal(rejected.json().code, "INVALID_PERSONA");
        assert.deepEqual((await runtime.app.inject({ method: "GET", url })).json(), saved.json());
        assert.deepEqual(captureConversationStyle("oc_strict"), snapshot);
      }
    }
    const preview = await runtime.app.inject({ method: "POST", url: url + "/preview", payload: { ...persona, name: "Preview persona" } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(preview.json().effectiveInstructions, /Preview persona/);
    assert.deepEqual(captureConversationStyle("oc_strict"), snapshot);
    const updated = await runtime.app.inject({ method: "PUT", url, payload: { ...persona, name: "Updated persona" } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().persona.version, saved.json().persona.version + 1);
    assert.equal(snapshot.persona.name, "Original persona");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("settings apply listener side effects only after commit and report saved settings on a start failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-listener-"));
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  const originalSpawn = childProcess.spawn; const originalSpawnSync = childProcess.spawnSync;
  const previousListenerRuntime = process.env.LARK_MESSAGE_LISTENER_RUNTIME;
  let starts = 0; let stops = 0; let attempts = 0; let failStart = false; let failOnAttempt = 0;
  // Intercept both process discovery and listener creation; never inspect or signal live consumers.
  childProcess.spawnSync = (() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof childProcess.spawnSync;
  childProcess.spawn = (() => {
    attempts++;
    if (failStart || attempts === failOnAttempt) throw new Error("simulated listener start failure");
    starts++;
    return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { stops++; return true; } });
  }) as unknown as typeof childProcess.spawn;
  process.env.LARK_MESSAGE_LISTENER_RUNTIME = "true";
  syncBuiltinESMExports();
  try {
    await patch(runtime, { listenerEnabled: false });
    assert.equal((await patch(runtime, { listenerEnabled: true, groupContextMessageLimit: 0 })).statusCode, 400);
    assert.equal(starts, 0);
    runtime.store.db.exec("CREATE TRIGGER fail_listener_patch BEFORE INSERT ON settings WHEN NEW.key='codexModel' BEGIN SELECT RAISE(ABORT, 'setting failure'); END");
    assert.equal((await patch(runtime, { listenerEnabled: true, codexModel: "gpt-6-sol" })).statusCode, 500);
    assert.equal(starts, 0);
    assert.equal((await settings(runtime)).listenerEnabled, false);
    runtime.store.db.exec("DROP TRIGGER fail_listener_patch");
    failStart = true;
    const failedStart = await patch(runtime, { listenerEnabled: true, repliesEnabled: false });
    assert.equal(failedStart.statusCode, 500);
    assert.match(failedStart.json().error, /Settings saved/);
    assert.equal(failedStart.json().settings.listenerEnabled, true);
    assert.equal(failedStart.json().settings.listenerRunning, false);
    assert.equal((await settings(runtime)).repliesEnabled, false);
    failStart = false;
    const started = await patch(runtime, { listenerEnabled: true });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.json().listenerRunning, true);
    assert.equal(started.json().approvalListenerRunning, true);
    assert.equal(starts, 2);
    await patch(runtime, { listenerEnabled: true });
    assert.equal(starts, 2);
    runtime.store.db.exec("CREATE TRIGGER fail_listener_patch BEFORE INSERT ON settings WHEN NEW.key='codexModel' BEGIN SELECT RAISE(ABORT, 'setting failure'); END");
    assert.equal((await patch(runtime, { listenerEnabled: false, codexModel: "gpt-6-sol" })).statusCode, 500);
    assert.equal(stops, 0);
    assert.equal((await settings(runtime)).listenerRunning, true);
    runtime.store.db.exec("DROP TRIGGER fail_listener_patch");
    const stopped = await patch(runtime, { listenerEnabled: false });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().listenerRunning, false);
    assert.equal(stopped.json().approvalListenerRunning, false);
    assert.equal(stops, 2);
    failOnAttempt = attempts + 2;
    const partial = await patch(runtime, { listenerEnabled: true });
    assert.equal(partial.statusCode, 500, partial.body);
    assert.equal(partial.json().settings.listenerRunning, false);
    assert.equal(partial.json().settings.approvalListenerRunning, false);
    assert.equal(starts, 3);
    const repaired = await patch(runtime, { listenerEnabled: true });
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.equal(repaired.json().approvalListenerRunning, true);
    assert.equal(starts, 4);
    await patch(runtime, { listenerEnabled: false });
    assert.equal(stops, 4);
  } finally {
    await runtime.app.close(); runtime.stop();
    childProcess.spawn = originalSpawn; childProcess.spawnSync = originalSpawnSync; syncBuiltinESMExports();
    if (previousListenerRuntime === undefined) delete process.env.LARK_MESSAGE_LISTENER_RUNTIME; else process.env.LARK_MESSAGE_LISTENER_RUNTIME = previousListenerRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("message details and artifacts expose recorded execution configs only, never current settings or list file reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-settings-artifacts-"));
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  try {
    const now = new Date().toISOString();
    const task = path.join(root, "task"); fs.mkdirSync(task);
    for (const id of [1, 2]) runtime.store.db.prepare("INSERT INTO lark_messages (id,content,codex_task_dir,raw_json,received_at,created_at) VALUES (?,'fixture',?,'{}',?,?)").run(id, id === 1 ? task : null, now, now);
    const urls = ["/v1/messages/1", "/v1/messages/1/artifacts", "/v1/messages/2", "/v1/messages/2/artifacts"];
    for (const url of urls) assert.deepEqual((await runtime.app.inject({ method: "GET", url })).json().executionConfigs, []);
    const recorded = { schemaVersion: 1, recordedAt: now, threadId: "historical-thread", turnId: "historical-turn", action: "turn/start", model: "historical-model", reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "read-only", workspaceRoot: "/historical-root", trustScope: "untrusted", persona: { mode: "default", name: "", version: 0, updatedAt: null }, globalPromptHash: "historical-hash", source: "accepted-request" };
    const file = path.join(task, "execution-configs.jsonl");
    fs.writeFileSync(file, JSON.stringify(recorded) + "\n");
    await patch(runtime, { codexModel: "current-model", reasoningEffort: "low", workspaceRoot: root });
    for (const url of urls.slice(0, 2)) assert.deepEqual((await runtime.app.inject({ method: "GET", url })).json().executionConfigs, [recorded]);
    for (const url of urls.slice(2)) assert.deepEqual((await runtime.app.inject({ method: "GET", url })).json().executionConfigs, []);
    fs.rmSync(file); fs.mkdirSync(file);
    const list = await runtime.app.inject({ method: "GET", url: "/v1/messages" });
    assert.equal(list.statusCode, 200, list.body);
    assert(list.json().every((row: Record<string, unknown>) => !Object.hasOwn(row, "executionConfigs")));
    for (const url of ["/v1/messages/999", "/v1/messages/999/artifacts"]) assert.equal((await runtime.app.inject({ method: "GET", url })).statusCode, 404);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
