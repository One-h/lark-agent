import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { buildLarkProgressCard, type LarkProgressContent } from "@lark-agent/adapter-lark-cli";
import { config, configureConversationRuntime, setAppSettingValue, type LarkMessageRow } from "./context.js";
import { drainLarkProgressCards, finishLarkProgressCard, queueLarkProgressUpdate, rebindLarkProgressCard, reconcileLarkProgressCards, retryPendingLarkProgressCards } from "./progressCards.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-progress-"));
  const database = path.join(root, "test.sqlite");
  let store = new SqliteAgentStore(database);
  const sent: Array<{ key: string; content: LarkProgressContent }> = [], updates: LarkProgressContent[] = [];
  let failure = false, barrier: Promise<void> | null = null, updateBarrier: Promise<void> | null = null;
  const options = { mode: "active" as const, repoRoot: root, larkStickerDirectory: root,
    progressSender: async (_id: string, content: LarkProgressContent, key: string) => {
      sent.push({ key, content: structuredClone(content) }); await barrier;
      if (failure) throw new Error("fixture transport lost receipt");
      return { ok: true as const, messageId: "om_progress", chatId: "oc_group", messageAt: null, messageType: "interactive" };
    }, progressUpdater: async (_id: string, content: LarkProgressContent) => {
      updates.push(structuredClone(content)); await updateBarrier; if (failure) throw new Error("fixture update failed"); return { ok: true as const };
    } };
  configureConversationRuntime({ ...options, database: store.db });
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,codex_turn_id,codex_status,reply_status,raw_json,received_at,created_at) VALUES (1,'om_source','oc_group','group','ou_user','user','turn-one','running','pending','{}',?,?)").run(now, now);
  const source = () => store.db.prepare("SELECT * FROM lark_messages WHERE id=1").get() as LarkMessageRow;
  const queue = (text: string, id = text) => queueLarkProgressUpdate({ progressId: "logical-one", turnId: source().codex_turn_id!, threadId: "thread-one", source: source(), eventId: id, text });
  const row = () => store.db.prepare("SELECT * FROM lark_progress_cards WHERE progress_id='logical-one'").get() as any;
  return { root, sent, updates, source, queue, row, get store() { return store; },
    due() { store.db.prepare("UPDATE lark_progress_cards SET next_attempt_at='2000-01-01T00:00:00Z'").run(); },
    fail(value: boolean) { failure = value; },
    hold() { let release!: () => void; barrier = new Promise(resolve => { release = resolve; }); return release; },
    holdUpdate() { let release!: () => void; updateBarrier = new Promise(resolve => { release = resolve; }); return release; },
    async reopen() { await drainLarkProgressCards(); store.close(); store = new SqliteAgentStore(database); configureConversationRuntime({ ...options, database: store.db }); },
    async close() { await drainLarkProgressCards(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test("compact progress cards have no header or buttons, bound recent lines and neutralize mentions", () => {
  const card = buildLarkProgressCard({ state: "completed", entries: Array.from({ length: 8 }, (_, i) => ({ id: String(i), at: "2026-10-28T05:00:00Z", text: `line-${i} <at id=all></at>` })) });
  assert.equal(card.schema, "2.0"); assert.equal(card.config.width_mode, "compact");
  const text = JSON.stringify(card);
  assert.doesNotMatch(text, /"header"|"button"|<at|line-0|line-1|line-2/);
  assert.match(text, /13:00/); assert.match(text, /已结束/); assert.match(text, /line-7/);
  assert.equal(card.body.vertical_spacing, "4px");
  assert.deepEqual(card.body.elements[0], { tag: "markdown", content: "<font color='grey'>已结束</font>", text_size: "notation" });
  assert.doesNotMatch(text, /background_style|column_set|\*\*/);
  assert.equal(card.body.elements[1].content.split("\n").length, 5);
  assert.ok(!card.body.elements[1].content.includes("\n\n"));
});

test("progress uses one message, coalesces edits, never marks the question sent, and seals its final state", async () => {
  const f = fixture(); try {
    f.queue("first"); await drainLarkProgressCards();
    assert.equal(f.sent.length, 1); assert.equal(f.source().reply_status, "pending");
    for (let i = 0; i < 7; i++) f.queue(`step-${i}`);
    await retryPendingLarkProgressCards(); assert.equal(f.updates.length, 0);
    assert.equal(f.queue("step-6", "duplicate"), false);
    f.due(); await drainLarkProgressCards();
    assert.equal(f.sent.length, 1); assert.equal(f.updates.length, 1);
    assert.deepEqual(f.updates[0].entries.map(e => e.text), ["step-2", "step-3", "step-4", "step-5", "step-6"]);
    finishLarkProgressCard("logical-one", "completed"); await drainLarkProgressCards();
    assert.equal(f.updates.at(-1)!.state, "completed"); assert.equal(f.queue("late event"), false);
    assert.equal(f.row().delivered_version, f.row().version); assert.equal(f.row().pending, 0);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_messages WHERE direction='outbound'").get() as any).n, 1);
    const plan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT progress_id FROM lark_progress_cards WHERE pending=1 AND next_attempt_at<=? AND attempts<5 ORDER BY next_attempt_at LIMIT 20").all(new Date().toISOString());
    assert.match(JSON.stringify(plan), /idx_lark_progress_pending/);
  } finally { await f.close(); }
});

test("terminal state follows an in-flight send and an older PATCH without racing or duplicating a card", async () => {
  const f = fixture(); let release!: () => void;
  try {
    release = f.hold(); f.queue("first"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 1); f.queue("second"); finishLarkProgressCard("logical-one", "failed");
    release(); await drainLarkProgressCards();
    assert.equal(f.sent.length, 1); assert.equal(f.updates.at(-1)!.state, "failed");
    assert.equal(f.row().delivered_version, f.row().version);
  } finally { release?.(); await f.close(); }
});

test("lost creation receipts reuse one idempotency key across reopen and never resurrect running after failure", async () => {
  const f = fixture(); try {
    f.fail(true); f.queue("first"); await drainLarkProgressCards();
    assert.equal(f.row().attempts, 1); assert.equal(f.row().create_attempted, 1);
    await f.reopen(); f.fail(false); finishLarkProgressCard("logical-one", "failed"); await drainLarkProgressCards();
    assert.equal(f.sent.length, 2); assert.equal(f.sent[0].key, f.sent[1].key);
    assert.equal(f.sent.at(-1)!.content.state, "failed"); assert.equal(f.row().pending, 0);
  } finally { await f.close(); }
});

test("a slow old PATCH completes before the terminal PATCH, and exhausted retries leave the due index", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.queue("first"); await drainLarkProgressCards(); release = f.holdUpdate();
    f.queue("second"); f.due(); const pending = retryPendingLarkProgressCards();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.updates.length, 1);
    finishLarkProgressCard("logical-one", "completed"); release(); await pending; await drainLarkProgressCards();
    assert.deepEqual(f.updates.map(c => c.state), ["running", "completed"]);
    assert.equal(f.row().pending, 0); assert.equal(f.queue("stale"), false);
  } finally { release?.(); await f.close(); }
  const failed = fixture();
  try {
    failed.fail(true); failed.queue("first"); await drainLarkProgressCards();
    for (let i = 0; i < 8; i++) { failed.due(); await drainLarkProgressCards(); }
    assert.equal(failed.sent.length, 5); assert.equal(failed.row().attempts, 5); assert.equal(failed.row().pending, 0);
  } finally { await failed.close(); }
});

test("bots, disabled progress and privacy groups cannot create progress; disabling updates still permits terminal closure", async () => {
  const f = fixture(); try {
    f.store.db.prepare("UPDATE lark_messages SET sender_type='bot' WHERE id=1").run(); assert.equal(f.queue("bot"), false);
    f.store.db.prepare("UPDATE lark_messages SET sender_type='user' WHERE id=1").run();
    config.groupPrivacyEnforced = true; assert.equal(f.queue("private"), false); config.groupPrivacyEnforced = false;
    setAppSettingValue("interimRepliesEnabled", "false"); assert.equal(f.queue("off"), false);
    setAppSettingValue("interimRepliesEnabled", "true"); f.queue("first"); await drainLarkProgressCards();
    setAppSettingValue("interimRepliesEnabled", "false"); finishLarkProgressCard("logical-one", "cancelled"); await drainLarkProgressCards();
    assert.equal(f.updates.at(-1)!.state, "cancelled"); assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test("recovery rebinds the same card, while a failed original run closes it after restart", async () => {
  const f = fixture(); try {
    f.queue("first"); await drainLarkProgressCards();
    f.store.db.prepare("UPDATE lark_messages SET codex_turn_id='turn-two' WHERE id=1").run();
    rebindLarkProgressCard("logical-one", "turn-two", "thread-two"); f.queue("resumed"); f.due(); await drainLarkProgressCards();
    assert.equal(f.sent.length, 1); assert.equal(f.row().native_turn_id, "turn-two");
    f.store.db.prepare("UPDATE lark_messages SET codex_status='failed' WHERE id=1").run();
    await f.reopen(); reconcileLarkProgressCards(); await drainLarkProgressCards();
    assert.equal(f.updates.at(-1)!.state, "interrupted"); assert.equal(f.row().pending, 0);
  } finally { await f.close(); }
});
