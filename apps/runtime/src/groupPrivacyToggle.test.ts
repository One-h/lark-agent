import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { config } from "@lark-agent/conversation-runtime";
import { GroupPrivacy } from "./groupPrivacy.js";
import { createRuntime } from "./index.js";

test("privacy defaults off for new and upgraded stores, persists explicit choices and retains old records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-privacy-toggle-"));
  const database = path.join(root, "test.sqlite");
  let store = new SqliteAgentStore(database);
  let notifications = 0;
  const options = { ownerId: () => "ou_owner", model: () => "fixture", cli: async () => { notifications++; return {}; } };
  let privacy = new GroupPrivacy(store, options);
  const event = { chat_type: "group", sender_type: "user", sender_id: "ou_peer", message_id: "om_new", chat_id: "oc_group", content: "help", privacy_trigger: true };
  try {
    assert.equal(privacy.snapshot().policy.enabled, false);
    assert.equal(privacy.ingestEvent(event), false);
    assert.equal(privacy.snapshot().messages.length, 0);
    privacy.configure({ enabled: true });
    const id = privacy.propose({ outreachId: "fixture", chatId: "oc_group", identity: "bot", text: "old draft" });
    privacy.configure({ enabled: false });
    await privacy.tick();
    assert.equal(notifications, 0);
    assert.equal(privacy.snapshot().messages.length, 1);
    await assert.rejects(privacy.decide(id, { action: "publish", text: "old draft", version: 1 }), /已关闭/);
    await privacy.stop(); store.close();
    store = new SqliteAgentStore(database); privacy = new GroupPrivacy(store, options);
    assert.equal(privacy.enabled(), false);
    assert.equal(privacy.snapshot().messages.length, 1);
    // A pre-switch installation has records and roots but no explicit enabled key.
    store.db.prepare("DELETE FROM settings WHERE key='groupPrivacy.enabled'").run();
    assert.equal(privacy.enabled(), false);
    privacy.configure({ enabled: true });
    await privacy.stop(); store.close();
    store = new SqliteAgentStore(database); privacy = new GroupPrivacy(store, options);
    assert.equal(privacy.enabled(), true);
    assert.equal(privacy.ingestEvent(event), true);
  } finally { await privacy.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("privacy settings reject invalid or busy changes atomically and keep their scope", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lark-privacy-settings-"));
  const root = fs.realpathSync(temporary);
  const store = new SqliteAgentStore(path.join(temporary, "test.sqlite"));
  let canChange = false;
  let actual = false;
  const privacy = new GroupPrivacy(store, { ownerId: () => "ou_owner", model: () => "fixture", canChangeEnabled: () => canChange, enabledChanged: enabled => { actual = enabled; } });
  try {
    for (const body of [{ enabled: "false" }, { enabled: 0 }, { enabled: null }, { enabled: true, extra: true }, { enabled: true, companyRoots: null }]) {
      assert.throws(() => privacy.configure(body));
      assert.equal(privacy.enabled(), false);
    }
    assert.throws(() => privacy.configure({ enabled: true, companyRoots: [root] }), /等待/);
    assert.deepEqual(privacy.roots(), []);
    assert.equal(actual, false);
    canChange = true;
    privacy.configure({ enabled: true, companyRoots: [root] });
    assert.equal(actual, true);
    privacy.configure({ enabled: false });
    assert.deepEqual(privacy.roots(), [root]);
    assert.equal(actual, false);
  } finally { await privacy.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("switch cannot change while isolated analysis is in flight", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-privacy-busy-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const privacy = new GroupPrivacy(store, { ownerId: () => "", model: () => "fixture", plan: async () => { await barrier; return { category: "public", draft: "draft", reason: "review" }; } });
  let pending: Promise<void> | undefined;
  try {
    privacy.configure({ enabled: true });
    privacy.ingestEvent({ chat_type: "group", sender_type: "user", sender_id: "ou_peer", message_id: "om_busy", chat_id: "oc_group", content: "help", privacy_trigger: true });
    pending = privacy.tick();
    assert.throws(() => privacy.configure({ enabled: false }), /等待/);
    assert.equal(privacy.enabled(), true);
    release(); await pending;
    privacy.configure({ enabled: false });
  } finally { release(); await pending; await privacy.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("authenticated toggle updates actual group guards, rejects busy changes and preserves execution approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-privacy-runtime-"));
  const options = { databasePath: path.join(root, "test.sqlite"), workspaceRoot: root, runtimeToken: "fixture-token", mode: "shadow" as const, trustedSenderIds: [],
    textReplySender: () => ({ ok: true as const, messageId: "om_reply", chatId: "oc_group", messageAt: null, messageType: "text" }) };
  let runtime = createRuntime(options);
  const headers = { authorization: "Bearer fixture-token" };
  const patch = (enabled: boolean) => runtime.app.inject({ method: "PATCH", url: "/v1/group-privacy", headers, payload: { enabled } });
  try {
    assert.equal(config.groupPrivacyEnforced, false);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/group-privacy", payload: { enabled: true } })).statusCode, 401);
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,content,raw_json,received_at,created_at,codex_status) VALUES (1,'om_source','oc_group','group','ou_peer','help','{}',?,?,'skipped')").run(now, now);
    const outbound = () => runtime.app.inject({ method: "POST", url: "/v1/internal/outbound", headers, payload: { replyToLarkMessageId: 1, text: "reply" } });
    assert.equal((await outbound()).statusCode, 200);
    assert.equal((await patch(true)).json().policy.enabled, true);
    assert.equal(config.groupPrivacyEnforced, true);
    assert.equal((await outbound()).statusCode, 400);
    for (const state of ["running", "queued"]) {
      runtime.store.db.prepare("UPDATE lark_messages SET codex_status=? WHERE id=1").run(state);
      assert.equal((await patch(false)).statusCode, 409);
      assert.equal(config.groupPrivacyEnforced, true);
    }
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='skipped' WHERE id=1").run();
    assert.equal((await patch(false)).statusCode, 200);
    assert.equal(config.groupPrivacyEnforced, false);
    const settings = (await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json();
    assert.equal(settings.trustedExecutionEnabled, false);
    assert.equal(settings.turnAutoApprovalEnabled, false);
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal(config.groupPrivacyEnforced, false);
    await patch(true);
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal(config.groupPrivacyEnforced, true);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
