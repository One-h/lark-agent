import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { parseLarkEvent, parseLarkSentMessage } from "@lark-agent/adapter-lark-cli";
import { buildLarkCodexThreadParams, buildLarkCodexTurnParams, recordExecutionReceipt, recordOutboundLarkMessage, retryPendingLarkExecutionReceipts, retryPendingLarkTextReplies } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";
import { shouldStartSpontaneousLarkReply } from "@lark-agent/conversation-runtime";

test("spontaneous group allowlist is fail-closed, persisted and applied immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-allowlist-"));
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, trustedSenderIds: [] };
  let runtime = createRuntime(options);
  const event = { chat_id: "oc_allowed", chat_type: "group", sender_type: "user", message_type: "text", content: "hello" };
  try {
    assert.deepEqual((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().groupSpontaneousChatIds, []);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().stickerUsageMode, "natural");
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1), false);
    const saved = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousRepliesEnabled: true, groupSpontaneousChatIds: [" oc_allowed ", "oc_allowed"] } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().groupSpontaneousChatIds, ["oc_allowed"]);
    assert.equal(saved.json().groupSpontaneousReplyRate, 0.08);
    assert.equal(saved.json().groupSpontaneousReplyCooldownMs, 600_000);
    for (const rate of [0, 0.35, 1]) {
      const updated = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyRate: rate } });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().groupSpontaneousReplyRate, rate);
      assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.1), rate > 0.1);
    }
    for (const rate of [-0.1, 1.1, "0.5", null]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyRate: rate, groupSpontaneousRepliesEnabled: false } })).statusCode, 400);
    }
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyRate: 0.35 } });
    for (const cooldown of [0, 60_000, 604_800_000]) {
      const updated = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyCooldownMs: cooldown } });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().groupSpontaneousReplyCooldownMs, cooldown);
    }
    for (const cooldown of [-1, 604_800_001, 1.5, "60000", null]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyCooldownMs: cooldown } })).statusCode, 400);
    }
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousReplyCooldownMs: 120_000 } });
    for (const stickerUsageMode of ["off", "explicit", "natural", "always"]) {
      const updated = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { stickerUsageMode } });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().stickerUsageMode, stickerUsageMode);
    }
    for (const stickerUsageMode of ["sometimes", "", null, 1]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { stickerUsageMode } })).statusCode, 400);
    }
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.35), false);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1), true);
    assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_id: "oc_other" }, false, false, 0, true, 1), false);
    assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_id: undefined }, false, false, 0, true, 1), false);
    assert.equal(shouldStartSpontaneousLarkReply(event, true, false, 0, true, 1), false);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, true, 0, true, 1), false);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 1, true, 0.08), false);
    for (const invalid of [["*"], "oc_allowed", [1], ["oc_allowed.evil"]]) {
      const rejected = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousChatIds: invalid, groupSpontaneousRepliesEnabled: false } });
      assert.equal(rejected.statusCode, 400);
    }
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().groupSpontaneousRepliesEnabled, true);
    await runtime.app.close();
    runtime.stop();
    runtime = createRuntime(options);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().groupSpontaneousReplyRate, 0.35);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().groupSpontaneousReplyCooldownMs, 120_000);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().stickerUsageMode, "always");
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.34), true);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1), true);
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupSpontaneousChatIds: [] } });
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1), false);
    runtime.store.setSetting("groupSpontaneousChatIds", "invalid JSON");
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1), false);
  } finally {
    await runtime.app.close();
    runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex model setting persists and is applied to new threads, resumed threads and turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-model-setting-"));
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, trustedSenderIds: [], model: "gpt-5.6-terra" };
  let runtime = createRuntime(options);
  try {
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().codexModel, "gpt-5.6-terra");
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().reasoningEffort, "low");
    const updated = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { codexModel: "gpt-5.5-codex" } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().codexModel, "gpt-5.5-codex");
    assert.equal(buildLarkCodexThreadParams(false, "new").model, "gpt-5.5-codex");
    assert.equal(buildLarkCodexThreadParams(false, "resume").model, "gpt-5.5-codex");
    const turn = buildLarkCodexTurnParams({ input: [{ type: "text", text: "hi" }], messageId: "om_one", trustedSender: false }, "thread-one");
    assert.equal(turn.model, "gpt-5.5-codex");
    const effort = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { reasoningEffort: "medium" } });
    assert.equal(effort.statusCode, 200);
    assert.equal(effort.json().reasoningEffort, "medium");
    assert.deepEqual(buildLarkCodexThreadParams(false, "new").config, { model_reasoning_effort: "medium" });
    assert.deepEqual(buildLarkCodexThreadParams(false, "resume").config, { model_reasoning_effort: "medium" });
    assert.equal(buildLarkCodexTurnParams({ input: [], messageId: "om_two", trustedSender: false }, "thread-one").effort, "medium");
    for (const invalid of ["", "minimal", "MEDIUM", null, 1]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { reasoningEffort: invalid } })).statusCode, 400);
    }
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { codexModel: " gpt-5.5-codex " } })).statusCode, 200);
    for (const invalid of ["", "gpt model", "../model", "x".repeat(121), null, 1]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { codexModel: invalid } })).statusCode, 400);
    }
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().codexModel, "gpt-5.5-codex");
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().reasoningEffort, "medium");
    await runtime.app.close(); runtime.stop();
    runtime = createRuntime(options);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().codexModel, "gpt-5.5-codex");
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().reasoningEffort, "medium");
    assert.equal(buildLarkCodexThreadParams(true, "new").model, "gpt-5.5-codex");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("sticker MCP bridge is authenticated and rejects expired or malformed contexts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-mcp-route-"));
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [], runtimeToken: "secret" });
  try {
    const url = "/v1/internal/stickers/search";
    const payload = { contextToken: "a".repeat(32), input: { query: "得意" } };
    assert.equal((await runtime.app.inject({ method: "POST", url, payload })).statusCode, 401);
    assert.equal((await runtime.app.inject({ method: "POST", url, headers: { authorization: "Bearer wrong" }, payload })).statusCode, 401);
    assert.equal((await runtime.app.inject({ method: "POST", url, headers: { authorization: "Bearer secret" }, payload: { contextToken: "bad", input: { query: "得意" } } })).statusCode, 400);
    const expired = await runtime.app.inject({ method: "POST", url, headers: { authorization: "Bearer secret" }, payload });
    assert.equal(expired.statusCode, 409);
    assert.match(expired.body, /context expired/i);
    assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/internal/stickers/delete", headers: { authorization: "Bearer secret" }, payload })).statusCode, 400);
    const historyUrl = "/v1/internal/history-images/search";
    assert.equal((await runtime.app.inject({ method: "POST", url: historyUrl, payload })).statusCode, 403);
    assert.equal((await runtime.app.inject({ method: "POST", url: historyUrl, headers: { authorization: "Bearer secret" }, payload: { contextToken: "bad", input: {} } })).statusCode, 400);
    const historyExpired = await runtime.app.inject({ method: "POST", url: historyUrl, headers: { authorization: "Bearer secret" }, payload: { contextToken: "a".repeat(32), input: {} } });
    assert.equal(historyExpired.statusCode, 409);
    assert.match(historyExpired.body, /context expired/i);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("pending thread archives survive a runtime reopen and remain visible in health", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-archive-queue-"));
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, trustedSenderIds: [] };
  let runtime = createRuntime(options);
  try {
    runtime.store.db.prepare("INSERT INTO lark_codex_archive_queue (thread_id,session_key,activity_version,token,due_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("thread-one", "oc_test::trusted", 1, "token-one", "2026-09-28T00:00:00.000Z", new Date().toISOString());
    await runtime.app.close(); runtime.stop();
    runtime = createRuntime(options);
    const health = (await runtime.app.inject({ method: "GET", url: "/v1/health" })).json();
    assert.equal(health.archivePending, 1);
    assert.equal(health.archiveFailed, 0);
    assert.equal((runtime.store.db.prepare("SELECT token FROM lark_codex_archive_queue WHERE thread_id='thread-one'").get() as { token: string }).token, "token-one");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("execution receipt switch suppresses pending and future cards without deleting local audit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-receipt-setting-"));
  const options = { databasePath: path.join(root, "runtime.sqlite"), mode: "shadow" as const, trustedSenderIds: [] };
  let runtime = createRuntime(options);
  const now = new Date().toISOString();
  const addReceipt = (messageId: number, turnId: string) => {
    runtime.store.db.prepare("INSERT INTO lark_messages (id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,raw_json,received_at,created_at) VALUES (?,?,'oc_test','p2p','ou_test','text','test',1,'{}',?,?)").run(messageId, `om_${messageId}`, now, now);
    runtime.store.db.prepare("INSERT INTO lark_observed_operations (lark_message_id,turn_id,item_id,kind,operation,status,evidence_json,created_at) VALUES (?,?,?,'command','git push','executed','[]',?)").run(messageId, turnId, `item_${messageId}`, now);
    recordExecutionReceipt(messageId, turnId);
  };
  try {
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().executionReceiptsEnabled, true);
    addReceipt(1, "turn_one");
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=1").get() as { delivery_status: string }).delivery_status, "pending");
    const disabled = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { executionReceiptsEnabled: false } });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().executionReceiptsEnabled, false);
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=1").get() as { delivery_status: string }).delivery_status, "suppressed");
    addReceipt(2, "turn_two");
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=2").get() as { delivery_status: string }).delivery_status, "suppressed");
    assert.equal(retryPendingLarkExecutionReceipts(), 0);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { executionReceiptsEnabled: "false" } })).statusCode, 400);
    await runtime.app.close(); runtime.stop();
    runtime = createRuntime(options);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().executionReceiptsEnabled, false);
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { executionReceiptsEnabled: true } });
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=2").get() as { delivery_status: string }).delivery_status, "suppressed");
    recordExecutionReceipt(2, "turn_two");
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=2").get() as { delivery_status: string }).delivery_status, "suppressed");
    addReceipt(3, "turn_three");
    assert.equal((runtime.store.db.prepare("SELECT delivery_status FROM lark_execution_receipts WHERE lark_message_id=3").get() as { delivery_status: string }).delivery_status, "pending");
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS n FROM lark_execution_receipts").get() as { n: number }).n, 3);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("standalone runtime deduplicates inbound messages and isolates trust scopes", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: ["ou_owner"] });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    const message = { event_id: "evt-1", chat_id: "oc_1", chat_type: "p2p", sender_id: "ou_owner", sender_type: "user", message_type: "text", content: "hi" };
    assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: message })).json().duplicate, false);
    assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: message })).json().duplicate, true);
    await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { ...message, event_id: "evt-2", sender_id: "ou_other" } });
    const rows = (await runtime.app.inject({ method: "GET", url: "/v1/messages" })).json() as Array<{ event_id: string; trust_scope: string }>;
    assert.equal(rows.find((row) => row.event_id === "evt-1")?.trust_scope, "trusted");
    assert.equal(rows.find((row) => row.event_id === "evt-2")?.trust_scope, "untrusted");
    const count = runtime.store.db.prepare("SELECT count(*) AS count FROM lark_messages").get() as { count: number };
    assert.equal(count.count, 2);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("group message reactions are opt-in, configurable and idempotent", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const reactions: Array<{ messageId: string; emojiType: string }> = [];
  const runtime = createRuntime({
    databasePath: file,
    mode: "active",
    trustedSenderIds: [],
    reactionSender: (messageId, emojiType) => {
      reactions.push({ messageId, emojiType });
      return { ok: true };
    }
  });
  const message = { event_id: "evt-reaction-1", message_id: "om_reaction_1", chat_id: "oc_group", chat_type: "group", sender_id: "ou_user", sender_type: "user", message_type: "text", content: "hello" };
  try {
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().groupMessageReactionEnabled, false);
    await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: message });
    assert.deepEqual(reactions, []);

    const enabled = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupMessageReactionEnabled: true, groupMessageReactionEmoji: "LAUGH" } });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().groupMessageReactionEmoji, "LAUGH");
    const next = { ...message, event_id: "evt-reaction-2", message_id: "om_reaction_2" };
    await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: next });
    assert.deepEqual(reactions, []);
    const allowlisted = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupMessageReactionChatIds: [" oc_group ", "oc_group"] } });
    assert.deepEqual(allowlisted.json().groupMessageReactionChatIds, ["oc_group"]);
    const allowed = { ...message, event_id: "evt-reaction-3", message_id: "om_reaction_3" };
    await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: allowed });
    await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: allowed });
    assert.deepEqual(reactions, [{ messageId: "om_reaction_3", emojiType: "LAUGH" }]);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupMessageReactionChatIds: ["*"] } })).statusCode, 400);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupMessageReactionEmoji: "NOT_REAL" } })).statusCode, 400);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { groupMessageReactionEnabled: "true" } })).statusCode, 400);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("message schema defaults legacy inserts to inbound and preserves event time", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const legacyDb = new Database(file);
  legacyDb.exec(`
    CREATE TABLE lark_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, message_id TEXT, chat_id TEXT, chat_type TEXT,
      sender_id TEXT, message_type TEXT, content TEXT, reply_to_message_id TEXT, reply_to_message_type TEXT,
      reply_to_content TEXT, reply_to_raw_json TEXT, mentioned INTEGER NOT NULL DEFAULT 0,
      reply_trigger TEXT NOT NULL DEFAULT 'none', reply_status TEXT NOT NULL DEFAULT 'skipped', reply_error TEXT,
      reply_delivery_key TEXT, reply_delivery_text TEXT, reply_delivery_attempts INTEGER NOT NULL DEFAULT 0,
      reply_next_attempt_at TEXT, reply_sent_at TEXT, codex_status TEXT NOT NULL DEFAULT 'skipped', codex_reply TEXT,
      codex_error TEXT, codex_session_id TEXT, codex_turn_id TEXT, codex_last_heartbeat_at TEXT,
      codex_runner_generation TEXT, codex_task_dir TEXT, codex_started_at TEXT, codex_finished_at TEXT,
      raw_json TEXT NOT NULL, received_at TEXT NOT NULL, created_at TEXT NOT NULL
    )
  `);
  const legacyAt = "2026-09-02T00:00:00.000Z";
  legacyDb.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("evt-legacy", "om_legacy", "oc_legacy", "group", "ou_legacy", "text", "legacy", JSON.stringify({ root_id: "om_root", thread_id: "omt_thread" }), legacyAt, legacyAt);
  legacyDb.close();
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const legacy = runtime.store.db.prepare("SELECT direction, sender_type, message_at, root_message_id, thread_id FROM lark_messages WHERE event_id='evt-legacy'").get() as { direction: string; sender_type: string; message_at: string; root_message_id: string; thread_id: string };
    assert.deepEqual(legacy, { direction: "inbound", sender_type: "user", message_at: legacyAt, root_message_id: "om_root", thread_id: "omt_thread" });
    const indexes = runtime.store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lark_messages'").all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === "idx_lark_messages_p2p_sender_time"));
    assert.ok(indexes.some((index) => index.name === "idx_lark_messages_p2p_recipient_time"));
    assert.ok(indexes.some((index) => index.name === "idx_lark_messages_group_topic"));
    const senderColumns = runtime.store.db.prepare("PRAGMA index_info(idx_lark_messages_p2p_sender_time)").all() as Array<{ name: string }>;
    const recipientColumns = runtime.store.db.prepare("PRAGMA index_info(idx_lark_messages_p2p_recipient_time)").all() as Array<{ name: string }>;
    assert.deepEqual(senderColumns.map((column) => column.name), ["chat_type", "sender_id", "message_at", "id"]);
    assert.deepEqual(recipientColumns.map((column) => column.name), ["chat_type", "recipient_id", "message_at", "id"]);

    const response = await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-time", chat_id: "oc_time", chat_type: "group", sender_id: "ou_time", sender_type: "user", message_type: "text", content: "timed", root_id: "om_topic_root", thread_id: "omt_topic", create_time: "1788400000000" } });
    assert.equal(response.statusCode, 200);
    const row = runtime.store.db.prepare("SELECT direction, sender_type, message_at, root_message_id, thread_id FROM lark_messages WHERE event_id='evt-time'").get() as { direction: string; sender_type: string; message_at: string; root_message_id: string; thread_id: string };
    assert.deepEqual(row, { direction: "inbound", sender_type: "user", message_at: new Date(1788400000000).toISOString(), root_message_id: "om_topic_root", thread_id: "omt_topic" });
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("queued text replies create one idempotent outbound message row", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const sentAt = "2026-09-03T01:02:03.000Z";
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: [],
    textReplySender: () => ({ ok: true, messageId: "om_reply_out", chatId: "oc_reply", messageAt: sentAt, messageType: "text" })
  });
  try {
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-reply", chat_id: "oc_reply", chat_type: "p2p", sender_id: "ou_reply", sender_type: "user", message_type: "text", content: "question" } })).json() as { id: number };
    runtime.store.db.prepare("UPDATE lark_messages SET message_id='om_reply_in', reply_status='pending', reply_delivery_key='reply-key', reply_delivery_text='answer', reply_next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", inbound.id);
    assert.equal(retryPendingLarkTextReplies(), 1);
    assert.equal(retryPendingLarkTextReplies(), 0);
    const rows = runtime.store.db.prepare("SELECT message_id, chat_id, direction, sender_type, sender_id, recipient_id, content, reply_to_message_id, message_at, outbound_source, reply_status, codex_status FROM lark_messages WHERE message_id='om_reply_out'").all();
    assert.deepEqual(rows, [{ message_id: "om_reply_out", chat_id: "oc_reply", direction: "outbound", sender_type: "bot", sender_id: null, recipient_id: "ou_reply", content: "answer", reply_to_message_id: "om_reply_in", message_at: sentAt, outbound_source: "reply", reply_status: "skipped", codex_status: "skipped" }]);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("reply delivery does not retry after a platform success when outbound recording fails", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  let sends = 0;
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: [],
    textReplySender: () => {
      sends += 1;
      return { ok: true, messageId: "om_record_failure", chatId: "oc_reply", messageAt: "2026-09-03T01:02:03.000Z", messageType: "text" };
    }
  });
  try {
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-record-failure", chat_id: "oc_reply", chat_type: "p2p", sender_id: "ou_reply", sender_type: "user", message_type: "text", content: "question" } })).json() as { id: number };
    runtime.store.db.prepare("UPDATE lark_messages SET message_id='om_record_failure_in', reply_status='pending', reply_delivery_key='reply-key', reply_delivery_text='answer', reply_next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", inbound.id);
    runtime.store.db.exec("CREATE TRIGGER reject_outbound_record BEFORE INSERT ON lark_messages WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'simulated outbound record failure'); END");

    assert.equal(retryPendingLarkTextReplies(), 1);
    assert.equal(retryPendingLarkTextReplies(), 0);
    assert.equal(sends, 1);
    const state = runtime.store.db.prepare("SELECT reply_status, reply_error, reply_delivery_attempts FROM lark_messages WHERE id=?").get(inbound.id);
    assert.deepEqual(state, { reply_status: "sent", reply_error: null, reply_delivery_attempts: 0 });
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("reply delivery preserves success without a platform message id and retries platform failures", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  let shouldFail = false;
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: [],
    textReplySender: () => shouldFail
      ? { ok: false, error: "simulated send failure" }
      : { ok: true, messageId: null, chatId: null, messageAt: null, messageType: "text" }
  });
  try {
    const first = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-no-id", chat_id: "oc_reply", chat_type: "p2p", sender_id: "ou_reply", sender_type: "user", message_type: "text", content: "first" } })).json() as { id: number };
    runtime.store.db.prepare("UPDATE lark_messages SET message_id='om_no_id_in', reply_status='pending', reply_delivery_key='reply-key-1', reply_delivery_text='answer', reply_next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first.id);
    assert.equal(retryPendingLarkTextReplies(), 1);
    assert.equal((runtime.store.db.prepare("SELECT reply_status FROM lark_messages WHERE id=?").get(first.id) as { reply_status: string }).reply_status, "sent");

    shouldFail = true;
    const second = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-send-failure", chat_id: "oc_reply", chat_type: "p2p", sender_id: "ou_reply", sender_type: "user", message_type: "text", content: "second" } })).json() as { id: number };
    runtime.store.db.prepare("UPDATE lark_messages SET message_id='om_send_failure_in', reply_status='pending', reply_delivery_key='reply-key-2', reply_delivery_text='answer', reply_next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", second.id);
    assert.equal(retryPendingLarkTextReplies(), 1);
    const failed = runtime.store.db.prepare("SELECT reply_status, reply_error, reply_delivery_attempts FROM lark_messages WHERE id=?").get(second.id);
    assert.deepEqual(failed, { reply_status: "pending", reply_error: "simulated send failure", reply_delivery_attempts: 1 });
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("proactive sends are persisted once and exposed through message DTOs", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const approvalIds: number[] = [];
  const runtime = createRuntime({ runtimeToken: "test-token",
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: ["ou_owner"],
    approverId: "ou_approver",
    approvalCardSender: (_approver, input) => { approvalIds.push(input.approvalId); return { ok: true, messageId: null }; },
    proactiveMessageSender: () => ({ ok: true, messageId: "om_proactive", chatId: "oc_contact", messageAt: "2026-09-03T04:05:06.000Z", messageType: "text" })
  });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,email,department,p2p_chat_id,updated_at) VALUES (?,?,?,?,?,?,?)").run("ou_contact", "Alice", "[]", null, null, "oc_contact", now);
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-proactive", chat_id: "oc_owner", chat_type: "p2p", sender_id: "ou_owner", sender_type: "user", message_type: "text", content: "send" } })).json() as { id: number };
    const pending = runtime.app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: "/v1/internal/capabilities/lark.message.send/execute", payload: { input: { recipient: "Alice", text: "hello" }, context: { larkMessageId: inbound.id, chatId: "oc_owner", trustScope: "trusted", turnId: "turn-proactive" } } });
    for (let index = 0; approvalIds.length === 0 && index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(approvalIds.length, 1);
    await runtime.app.inject({ method: "POST", url: `/v1/approvals/${approvalIds[0]}/approve` });
    assert.equal((await pending).statusCode, 200);

    recordOutboundLarkMessage({ messageId: "om_proactive", chatId: "oc_contact", chatType: "p2p", recipientId: "ou_contact", content: "hello", replyToMessageId: null, messageAt: "2026-09-03T04:05:06.000Z", messageType: "text", source: "proactive" });
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS count FROM lark_messages WHERE message_id='om_proactive'").get() as { count: number }).count, 1);

    const list = (await runtime.app.inject({ method: "GET", url: "/v1/messages?q=Alice&sender_id=ou_contact" })).json() as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0].direction, "outbound");
    assert.equal(list[0].senderType, "bot");
    assert.equal(list[0].recipientId, "ou_contact");
    assert.equal(list[0].recipientName, "Alice");
    assert.equal(list[0].messageAt, "2026-09-03T04:05:06.000Z");
    assert.equal(list[0].outboundSource, "proactive");
    const detail = (await runtime.app.inject({ method: "GET", url: `/v1/messages/${list[0].id}` })).json();
    assert.equal(detail.recipientName, "Alice");
    assert.equal(detail.outboundSource, "proactive");
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("proactive delivery remains successful when outbound recording fails", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const approvalIds: number[] = [];
  let sends = 0;
  const runtime = createRuntime({ runtimeToken: "test-token",
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: ["ou_owner"],
    approverId: "ou_approver",
    approvalCardSender: (_approver, input) => { approvalIds.push(input.approvalId); return { ok: true, messageId: null }; },
    proactiveMessageSender: () => {
      sends += 1;
      return { ok: true, messageId: "om_proactive_record_failure", chatId: "oc_contact", messageAt: "2026-09-03T04:05:06.000Z", messageType: "text" };
    }
  });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,email,department,p2p_chat_id,updated_at) VALUES (?,?,?,?,?,?,?)").run("ou_contact", "Alice", "[]", null, null, "oc_contact", now);
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-proactive-record-failure", chat_id: "oc_owner", chat_type: "p2p", sender_id: "ou_owner", sender_type: "user", message_type: "text", content: "send" } })).json() as { id: number };
    runtime.store.db.exec("CREATE TRIGGER reject_outbound_record BEFORE INSERT ON lark_messages WHEN NEW.direction='outbound' BEGIN SELECT RAISE(FAIL, 'simulated outbound record failure'); END");
    const pending = runtime.app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: "/v1/internal/capabilities/lark.message.send/execute", payload: { input: { recipient: "Alice", text: "hello" }, context: { larkMessageId: inbound.id, chatId: "oc_owner", trustScope: "trusted", turnId: "turn-proactive-record-failure" } } });
    for (let index = 0; approvalIds.length === 0 && index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.app.inject({ method: "POST", url: `/v1/approvals/${approvalIds[0]}/approve` });
    const response = await pending;

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, true);
    assert.equal(sends, 1);
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS count FROM lark_messages WHERE direction='outbound'").get() as { count: number }).count, 0);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("Lark send response parsing accepts nested JSON and CLI notices", () => {
  assert.deepEqual(parseLarkSentMessage(`notice\n{"data":{"message":{"message_id":"om_nested","chat_id":"oc_nested","create_time":"1788400000000","msg_type":"text"}}}`), {
    ok: true,
    messageId: "om_nested",
    chatId: "oc_nested",
    messageAt: new Date(1788400000000).toISOString(),
    messageType: "text"
  });
});

test("authenticated host outbound route sends once and records the message", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  let sends = 0;
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: [],
    runtimeToken: "runtime-secret",
    proactiveMessageSender: () => {
      sends += 1;
      return { ok: true, messageId: "om_host_outbound", chatId: "oc_contact", messageAt: "2026-09-03T04:05:06.000Z", messageType: "text" };
    }
  });
  try {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,p2p_chat_id,updated_at) VALUES (?,?,?,?,?)")
      .run("ou_contact", "Alice", "[]", "oc_contact", now);
    const payload = { recipient: "Alice", text: "待办提醒", idempotencyKey: "todo-reminder-1" };
    assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/internal/outbound", payload })).statusCode, 401);
    const sent = await runtime.app.inject({ method: "POST", url: "/v1/internal/outbound", headers: { authorization: "Bearer runtime-secret" }, payload });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().messageId, "om_host_outbound");
    assert.equal(sends, 1);
    assert.deepEqual(runtime.store.db.prepare("SELECT direction, recipient_id, content, outbound_source FROM lark_messages WHERE message_id='om_host_outbound'").get(), {
      direction: "outbound",
      recipient_id: "ou_contact",
      content: "待办提醒",
      outbound_source: "proactive"
    });
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("authenticated host outbound route replies to a group source and records the reply", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  let replyText = "";
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: [],
    runtimeToken: "runtime-secret",
    textReplySender: (_messageId, text) => {
      replyText = text;
      return { ok: true, messageId: "om_host_reply", chatId: "oc_group", messageAt: "2026-09-03T04:05:06.000Z", messageType: "text" };
    }
  });
  try {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,updated_at) VALUES (?,?,?,?)")
      .run("ou_requester", "请求人", "[]", now);
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt_host_reply", message_id: "om_host_source", chat_id: "oc_group", chat_type: "group", sender_id: "ou_requester", sender_type: "user", message_type: "text", content: "创建待办" } })).json() as { id: number };
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/internal/outbound",
      headers: { authorization: "Bearer runtime-secret" },
      payload: { replyToLarkMessageId: inbound.id, text: "待办已完成", idempotencyKey: "todo-complete-1" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().messageId, "om_host_reply");
    assert.match(replyText, /^<at user_id="ou_requester">请求人<\/at> 待办已完成$/);
    assert.deepEqual(runtime.store.db.prepare("SELECT direction, recipient_id, content, reply_to_message_id, outbound_source FROM lark_messages WHERE message_id='om_host_reply'").get(), {
      direction: "outbound",
      recipient_id: "ou_requester",
      content: replyText,
      reply_to_message_id: "om_host_source",
      outbound_source: "reply"
    });
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("runtime stores host capability registrations", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const runtime = createRuntime({ runtimeToken: "test-token", databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const response = await runtime.app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: "/v1/capabilities/register", payload: { capabilities: [{ id: "host.demo", title: "Demo", description: "demo", inputSchema: { type: "object" }, risk: "read" }] } });
    assert.deepEqual(response.json(), { registered: 1 });
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS count FROM capabilities").get() as { count: number }).count, 2);
    assert.ok(runtime.store.db.prepare("SELECT 1 FROM capabilities WHERE id='lark.message.send'").get());
  } finally { await runtime.app.close(); runtime.store.close(); }
});

test("runtime settings persist trusted senders and approver in SQLite", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const first = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: ["ou_initial"], approverId: "ou_initial" });
  try {
    const patched = await first.app.inject({ method: "PATCH", url: "/v1/settings", payload: { trustedSenderIds: ["ou_saved"], approverId: "ou_approver", interimRepliesEnabled: false } });
    assert.equal(patched.statusCode, 200);
  } finally { await first.app.close(); first.stop(); }
  const second = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: ["ou_environment"], approverId: "ou_environment" });
  try {
    const settings = (await second.app.inject({ method: "GET", url: "/v1/settings" })).json();
    assert.deepEqual(settings.trustedSenderIds, ["ou_saved"]);
    assert.equal(settings.approverId, "ou_approver");
    assert.equal(settings.interimRepliesEnabled, false);
  } finally { await second.app.close(); second.stop(); }
});

test("message search and filters query the full migrated history", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const now = new Date().toISOString();
    const insert = runtime.store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,codex_status,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 220; index += 1) insert.run(`evt-${index}`, `om-${index}`, "oc_history", "group", "ou_history", "text", index === 0 ? "deep-history-marker" : `message-${index}`, 0, index === 0 ? "failed" : "skipped", "{}", now, now);
    const search = (await runtime.app.inject({ method: "GET", url: "/v1/messages?q=deep-history-marker&status=failed" })).json();
    assert.equal(search.length, 1);
    assert.equal(search[0].content, "deep-history-marker");
    const filters = (await runtime.app.inject({ method: "GET", url: "/v1/messages/filters" })).json();
    assert.equal(filters.senders[0].message_count, 220);
    assert.equal(filters.chats[0].message_count, 220);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("P2P conversations aggregate contacts and exclude group messages", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const now = "2026-09-03T00:00:00.000Z";
    const contact = runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,email,department,updated_at) VALUES (?,?,?,?,?,?)");
    contact.run("ou_alice", "Alice", "[]", null, null, now);
    contact.run("ou_bob", "Bob", "[]", null, null, now);
    contact.run("ou_group", "Group sender", "[]", null, null, now);
    const insert = runtime.store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,sender_type,recipient_id,direction,message_type,content,message_at,outbound_source,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("evt-a1", "om-a1", "oc-a", "p2p", "ou_alice", "user", null, "inbound", "text", "old Alice", "2026-09-03T01:00:00.000Z", null, "{}", "2026-09-03T01:00:00.000Z", now);
    insert.run(null, "om-a2", "oc-a", "p2p", null, "bot", "ou_alice", "outbound", "text", "latest Alice", "2026-09-03T04:00:00.000Z", "proactive", "{}", "2026-09-03T04:00:00.000Z", now);
    insert.run("evt-b1", "om-b1", "oc-b", "p2p", "ou_bob", "user", null, "inbound", "text", "Bob message", null, null, "{}", "2026-09-03T02:00:00.000Z", now);
    insert.run("evt-g1", "om-g1", "oc-g", "group", "ou_group", "user", null, "inbound", "text", "newest but grouped", "2026-09-03T05:00:00.000Z", null, "{}", "2026-09-03T05:00:00.000Z", now);

    assert.deepEqual((await runtime.app.inject({ method: "GET", url: "/v1/conversations" })).json(), []);
    const all = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?limit=1" })).json();
    assert.deepEqual(all.items, [{ contactId: "ou_alice", contactName: "Alice", chatType: "p2p", chatId: "oc-a", codexSessionIds: [], lastMessageAt: "2026-09-03T04:00:00.000Z", lastMessagePreview: "latest Alice", messageCount: 2, inboundCount: 1, outboundCount: 1 }]);
    assert.deepEqual(all.pagination, { total: 2, limit: 1, offset: 0, hasMore: true });
    const secondPage = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?limit=1&offset=1" })).json();
    assert.equal(secondPage.items[0].contactId, "ou_bob");
    assert.equal(secondPage.items[0].lastMessageAt, "2026-09-03T02:00:00.000Z");

    const search = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?keyword=ALI&limit=999" })).json();
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].contactId, "ou_alice");
    assert.deepEqual(search.pagination, { total: 1, limit: 100, offset: 0, hasMore: false });
    const invalidLimit = await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?limit=nope" });
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal(invalidLimit.json().code, "INVALID_LIMIT");
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("group conversations include all senders and paginate without mixing private messages", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-groups-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const now = "2026-09-03T04:00:00.000Z";
    const insert = runtime.store.db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_id,recipient_id,direction,content,message_at,received_at,created_at,raw_json,codex_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,'{}',?)");
    insert.run("om_first", "oc_group", "group", "ou_alice", null, "inbound", "first", now, now, now, "sessionA");
    insert.run("om_second", "oc_group", "group", "ou_bob", null, "inbound", "second", now, now, now, null);
    insert.run("om_third", "oc_group", "group", null, "ou_bob", "outbound", "reply", now, now, now, null);
    insert.run("om_private", "oc_private", "p2p", "ou_alice", null, "inbound", "private", now, now, now, null);
    insert.run("om_other", "oc_other", "group", "ou_alice", null, "inbound", "other", now, now, now, null);
    runtime.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("oc_group::trusted", "oc_group", "trusted", "sessionA", now, now);
    const all = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?chat_type=group&limit=1" })).json();
    assert.equal(all.pagination.total, 2);
    assert.equal(all.pagination.hasMore, true);
    const groups = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?chat_type=group&keyword=oc_group" })).json();
    assert.equal(groups.items.length, 1);
    assert.equal(groups.items[0].chatId, "oc_group");
    assert.equal(groups.items[0].chatType, "group");
    assert.equal(groups.items[0].messageCount, 3);
    assert.equal(groups.items[0].inboundCount, 2);
    assert.equal(groups.items[0].outboundCount, 1);
    assert.deepEqual(groups.items[0].codexSessionIds, ["sessionA"]);
    runtime.store.setSetting("lark.chat.name:oc_group", "产品讨论群");
    const named = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?chat_type=group&keyword=" + encodeURIComponent("产品") })).json();
    assert.equal(named.items[0].contactName, "产品讨论群");
    assert.equal(named.pagination.total, 1);
    const first = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations/oc_group/messages?limit=2" })).json();
    assert.deepEqual(first.items.map((row: {message_id: string}) => row.message_id), ["om_third", "om_second"]);
    assert.equal(first.items[0].recipientId, "ou_bob");
    const second = (await runtime.app.inject({ method: "GET", url: `/v1/contact-conversations/oc_group/messages?limit=2&cursor=${first.pagination.nextCursor}` })).json();
    assert.deepEqual(second.items.map((row: {message_id: string}) => row.message_id), ["om_first"]);
    assert.equal(second.items[0].codex_session_id, "sessionA");
    assert.equal(second.pagination.hasMore, false);
    const plan = runtime.store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM lark_messages WHERE chat_type='group' AND chat_id=? ORDER BY message_at DESC,id DESC LIMIT 51").all("oc_group") as Array<{detail: string}>;
    assert.ok(plan.some((row) => row.detail.includes("idx_lark_messages_group_time")));
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations?chat_type=unknown" })).statusCode, 400);
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("resetting one Codex scope preserves messages and other scopes", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-session-reset-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [], runtimeToken: "test-token" });
  try {
    const db = runtime.store.db;
    const now = new Date().toISOString();
    const chatId = "oc_reset";
    const trustedKey = `${chatId}::main-v2::trusted`;
    const untrustedKey = `${chatId}::main-v2::untrusted`;
    const insertSession = db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?)");
    insertSession.run(trustedKey, chatId, "trusted", "old-trusted", now, now);
    insertSession.run(untrustedKey, chatId, "untrusted", "old-untrusted", now, now);
    const insertCursor = db.prepare("INSERT INTO lark_group_context_cursors (chat_id,trust_scope,last_message_id,updated_at) VALUES (?,?,?,?)");
    insertCursor.run(`${chatId}::main-v2`, "trusted", 42, now);
    insertCursor.run(`${chatId}::main-v2`, "untrusted", 43, now);
    db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_id,direction,content,message_at,received_at,created_at,raw_json,codex_session_id) VALUES (?,?,?,?,?,?,?,?,?,'{}',?)")
      .run("om-reset", chatId, "group", "ou_sender", "inbound", "historical message", now, now, now, "old-trusted");
    const url = `/v1/contact-conversations/${chatId}/sessions`;
    assert.equal((await runtime.app.inject({ method: "GET", url })).statusCode, 401);
    const headers = { authorization: "Bearer test-token" };
    const before = (await runtime.app.inject({ method: "GET", url, headers })).json();
    assert.equal(before.active.length, 2);
    const reset = await runtime.app.inject({ method: "POST", url: `${url}/reset`, headers, payload: { sessionKey: trustedKey, expectedSessionId: "old-trusted" } });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().oldSessionId, "old-trusted");
    assert.equal((await runtime.app.inject({ method: "POST", url: `${url}/reset`, headers, payload: { sessionKey: trustedKey, expectedSessionId: "old-trusted" } })).statusCode, 409);
    assert.equal((db.prepare("SELECT count(*) AS count FROM lark_messages WHERE chat_id=? AND codex_session_id=?").get(chatId, "old-trusted") as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT count(*) AS count FROM lark_group_context_cursors WHERE chat_id=? AND trust_scope='trusted'").get(`${chatId}::main-v2`) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT last_message_id AS id FROM lark_group_context_cursors WHERE chat_id=? AND trust_scope='untrusted'").get(`${chatId}::main-v2`) as { id: number }).id, 43);
    const after = (await runtime.app.inject({ method: "GET", url, headers })).json();
    assert.deepEqual(after.active.map((item: { codexSessionId: string }) => item.codexSessionId), ["old-untrusted"]);
    assert.deepEqual(after.previous.map((item: { codexSessionId: string }) => item.codexSessionId), ["old-trusted"]);
    const list = (await runtime.app.inject({ method: "GET", url: `/v1/contact-conversations?chat_type=group&keyword=${chatId}` })).json();
    assert.deepEqual(new Set(list.items[0].codexSessionIds), new Set(["old-trusted", "old-untrusted"]));
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("contact message timeline uses stable descending cursors and validates contact IDs", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const runtime = createRuntime({ databasePath: file, mode: "shadow", trustedSenderIds: [] });
  try {
    const now = "2026-09-03T00:00:00.000Z";
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,aliases,email,department,updated_at) VALUES (?,?,?,?,?,?)").run("ou_alice", "Alice", "[]", null, null, now);
    const insert = runtime.store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,sender_type,recipient_id,direction,message_type,content,message_at,outbound_source,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("evt-1", "om-1", "oc-a", "p2p", "ou_alice", "user", null, "inbound", "text", "first", "2026-09-03T01:00:00.000Z", null, "{}", "2026-09-03T01:00:00.000Z", now);
    insert.run(null, "om-2", "oc-a", "p2p", null, "bot", "ou_alice", "outbound", "text", "second", "2026-09-03T02:00:00.000Z", "reply", "{}", "2026-09-03T02:00:00.000Z", now);
    insert.run("evt-3", "om-3", "oc-a", "p2p", "ou_alice", "user", null, "inbound", "text", "third", "2026-09-03T02:00:00.000Z", null, "{}", "2026-09-03T02:00:00.000Z", now);
    insert.run("evt-group", "om-group", "oc-g", "group", "ou_alice", "user", null, "inbound", "text", "group", "2026-09-03T03:00:00.000Z", null, "{}", "2026-09-03T03:00:00.000Z", now);
    insert.run("evt-other", "om-other", "oc-o", "p2p", "ou_other", "user", null, "inbound", "text", "other", "2026-09-03T04:00:00.000Z", null, "{}", "2026-09-03T04:00:00.000Z", now);
    runtime.store.db.exec(`
      WITH RECURSIVE sequence(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000)
      INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,sender_type,direction,message_type,content,message_at,raw_json,received_at,created_at)
      SELECT 'evt-noise-' || value, 'om-noise-' || value, 'oc-noise', 'p2p', 'ou_noise', 'user', 'inbound', 'text', 'noise', printf('2026-08-01T00:%02d:%02d.000Z', (value / 60) % 60, value % 60), '{}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z' FROM sequence;
      ANALYZE lark_messages;
    `);
    const queryPlan = runtime.store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM lark_messages WHERE chat_type='p2p' AND (sender_id=? OR recipient_id=?) AND (message_at < ? OR (message_at = ? AND id < ?)) ORDER BY message_at DESC, id DESC LIMIT ?").all("ou_alice", "ou_alice", "2026-09-03T02:00:00.000Z", "2026-09-03T02:00:00.000Z", 3, 3) as Array<{ detail: string }>;
    assert.ok(queryPlan.some((step) => step.detail.includes("MULTI-INDEX OR")));
    assert.ok(queryPlan.some((step) => step.detail.includes("idx_lark_messages_p2p_sender_time")));
    assert.ok(queryPlan.some((step) => step.detail.includes("idx_lark_messages_p2p_recipient_time")));
    const firstPage = (await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations/ou_alice/messages?limit=2" })).json();
    assert.deepEqual(firstPage.items.map((item: { message_id: string }) => item.message_id), ["om-3", "om-2"]);
    assert.equal(firstPage.items[1].senderType, "bot");
    assert.equal(firstPage.items[1].recipientName, "Alice");
    assert.equal(firstPage.items[1].messageAt, "2026-09-03T02:00:00.000Z");
    assert.equal(firstPage.pagination.hasMore, true);
    assert.equal(typeof firstPage.pagination.nextCursor, "string");
    assert.deepEqual([...firstPage.items].reverse().map((item: { message_id: string }) => item.message_id), ["om-2", "om-3"]);

    const secondPage = (await runtime.app.inject({ method: "GET", url: `/v1/contact-conversations/ou_alice/messages?limit=2&cursor=${encodeURIComponent(firstPage.pagination.nextCursor)}` })).json();
    assert.deepEqual(secondPage.items.map((item: { message_id: string }) => item.message_id), ["om-1"]);
    assert.deepEqual(secondPage.pagination, { limit: 2, hasMore: false, nextCursor: null });
    const invalidCursor = await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations/ou_alice/messages?cursor=bad" });
    assert.equal(invalidCursor.statusCode, 400);
    assert.equal(invalidCursor.json().code, "INVALID_CURSOR");
    const invalidContact = await runtime.app.inject({ method: "GET", url: "/v1/contact-conversations/%25bad/messages" });
    assert.equal(invalidContact.statusCode, 400);
    assert.equal(invalidContact.json().code, "INVALID_CONTACT_ID");
  } finally { await runtime.app.close(); runtime.stop(); }
});

test("Lark messages invoke host capabilities with verified trust and approval", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-")), "agent.sqlite");
  const host = Fastify({ logger: false });
  let calls = 0;
  let hostPayload: Record<string, unknown> | null = null;
  host.post("/api/lark-agent/capabilities/host.deploy", async (request) => {
    hostPayload = request.body as Record<string, unknown>;
    return { calls: ++calls };
  });
  await host.listen({ host: "127.0.0.1", port: 0 });
  const hostAddress = host.server.address();
  assert.ok(hostAddress && typeof hostAddress !== "string");
  const cards: number[] = [];
  const runtime = createRuntime({
    databasePath: file,
    mode: "shadow",
    trustedSenderIds: ["ou_owner"],
    approverId: "ou_approver",
    hostBaseUrl: `http://127.0.0.1:${hostAddress.port}`,
    runtimeToken: "test-token",
    approvalCardSender: (_approver, input) => { cards.push(input.approvalId); return { ok: true, messageId: null }; }
  });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    await runtime.app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: "/v1/capabilities/register", payload: { capabilities: [{ id: "host.deploy", title: "部署", description: "Deploy", inputSchema: { type: "object" }, risk: "external-write" }] } });
    const now = new Date().toISOString();
    const inserted = runtime.store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,codex_status,codex_turn_id,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("evt-migrated", "om_migrated", "oc_migrated", "p2p", "ou_owner", "text", "部署", 1, "running", "turn-migrated", "{}", now, now);
    const larkMessageId = Number(inserted.lastInsertRowid);
    const pending = runtime.app.inject({ method: "POST", url: "/v1/internal/capabilities/host.deploy/execute", headers: { authorization: "Bearer test-token" }, payload: { input: { app: "demo" }, context: { larkMessageId, chatId: "oc_migrated", trustScope: "trusted" } } });
    for (let index = 0; cards.length === 0 && index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cards.length, 1);
    assert.equal(runtime.store.approval(cards[0])?.lark_message_id, larkMessageId);
    assert.deepEqual((await runtime.app.inject({ method: "POST", url: `/v1/approvals/${cards[0]}/approve` })).json(), { ok: true });
    assert.equal((await pending).statusCode, 200);
    assert.equal(calls, 1);
    assert.deepEqual(hostPayload, {
      input: { app: "demo" },
      context: {
        larkMessageId,
        chatId: "oc_migrated",
        trustScope: "trusted",
        senderId: "ou_owner",
        chatType: "p2p"
      }
    });
    const cached = await runtime.app.inject({ method: "POST", url: "/v1/internal/capabilities/host.deploy/execute", headers: { authorization: "Bearer test-token" }, payload: { input: { app: "demo" }, context: { larkMessageId, chatId: "oc_migrated", trustScope: "trusted", turnId: "turn-migrated" } } });
    assert.equal(cached.statusCode, 200);
    assert.equal(calls, 1);
    const rejected = await runtime.app.inject({ method: "POST", url: "/v1/internal/capabilities/host.deploy/execute", headers: { authorization: "Bearer test-token" }, payload: { input: {}, context: { larkMessageId, chatId: "oc_other", trustScope: "trusted" } } });
    assert.equal(rejected.statusCode, 409);
  } finally { await runtime.app.close(); runtime.stop(); await host.close(); }
});

test("group replies require an exact mention of this bot", () => {
  const event = { message: { message_id: "om_group", chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "hello" }), mentions: [{ id: { open_id: "ou_other" } }] }, sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } } };
  assert.equal(parseLarkEvent(event, "ou_bot")?.mentioned, false);
  event.message.mentions = [{ id: { open_id: "ou_bot" } }];
  assert.equal(parseLarkEvent(event, "ou_bot")?.mentioned, true);
});
