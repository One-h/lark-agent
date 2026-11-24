import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LarkProgressContent } from "@lark-agent/adapter-lark-cli";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import {
  bindLarkBuiltinPlugins, configureConversationRuntime, finishLarkProgressCard, queueLarkCompletionReactions,
  queueLarkProgressUpdate, rebindLarkProgressCard, reconcileLarkProgressCards, resolveLarkBuiltinPlugins,
  type LarkBuiltinPluginId, type LarkMessageRow
} from "@lark-agent/conversation-runtime";
import { publishLarkTurnObservation } from "../../../../packages/conversation-runtime/src/turnObservations.js";
import { mountCompletionReactionsPlugin, mountProgressCardsPlugin } from "./presentationPlugins.js";

function fixture(beforeProgressReceipt?: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-presentation-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const database = store.db;
  const sent: LarkProgressContent[] = [], updates: LarkProgressContent[] = [];
  const reactions: Array<[string, string]> = [];
  configureConversationRuntime({ database, mode: "active", larkStickerDirectory: root, repoRoot: root,
    progressSender: async (_id, content) => {
      sent.push(content);
      await beforeProgressReceipt?.();
      return { ok: true, messageId: "om_card", chatId: "oc_fixture", messageAt: null, messageType: "interactive" };
    },
    progressUpdater: async (_id, content) => { updates.push(content); return { ok: true }; },
    reactionSender: (id, emoji) => { reactions.push([id, emoji]); return { ok: true }; }
  });
  const now = new Date().toISOString();
  for (const id of [1, 2]) database.prepare(`INSERT INTO lark_messages
    (id,message_id,chat_id,chat_type,sender_type,codex_turn_id,codex_status,reply_status,reply_delivery_key,raw_json,received_at,created_at)
    VALUES (?,?,'oc_fixture','p2p','user','turn-one','running','pending','final-key','{}',?,?)`).run(id, `om_${id}`, now, now);
  const identity = { runId: "run-one", turnId: "turn-one", threadId: "thread-one", sourceMessageId: 1 };
  const progress = mountProgressCardsPlugin(database);
  return { database, progress, completion: mountCompletionReactionsPlugin(), sent, updates, reactions,
    disable: (...ids: LarkBuiltinPluginId[]) => bindLarkBuiltinPlugins(database, resolveLarkBuiltinPlugins(ids)),
    observe: (summary: string, runId = identity.runId) => publishLarkTurnObservation(database, { ...identity, runId, kind: "turn.progress", progressKey: summary, summary }),
    finish: () => publishLarkTurnObservation(database, { ...identity, kind: "turn.finished", outcome: "completed" }),
    queue: (text: string) => queueLarkProgressUpdate({ progressId: identity.runId, turnId: identity.turnId, threadId: identity.threadId,
      source: database.prepare("SELECT * FROM lark_messages WHERE id=1").get() as LarkMessageRow, eventId: text, text }),
    cards: () => database.prepare("SELECT * FROM lark_progress_cards").all(),
    doneRows: () => database.prepare("SELECT * FROM lark_delivery_outbox WHERE kind='completion-reaction'").all(),
    due: () => database.prepare("UPDATE lark_progress_cards SET next_attempt_at='2000-01-01T00:00:00Z'").run(),
    async close() { await progress.drain(); progress.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test("progress mount observes and drains by default, then unsubscribes on stop", async () => {
  const f = fixture();
  try {
    f.observe("first"); await f.progress.drain();
    assert.deepEqual(f.sent.map(card => card.state), ["running"]);
    f.finish(); await f.progress.drain();
    assert.deepEqual(f.updates.map(card => card.state), ["completed"]);
    f.progress.stop();
    f.observe("after stop", "run-two"); await f.progress.drain();
    assert.equal(f.cards().length, 1);
  } finally { await f.close(); }
});

test("paused progress ignores events and direct mutations, and retains a due update for reconciliation", async () => {
  const f = fixture();
  try {
    f.observe("first"); await f.progress.drain();
    assert.equal(f.queue("pending"), true);
    f.due();
    const saved = f.cards();
    f.disable("progress-cards");
    assert.equal(f.queue("disabled"), false);
    rebindLarkProgressCard("run-one", "turn-two", "thread-two");
    finishLarkProgressCard("run-one", "cancelled");
    f.observe("ignored", "run-two"); f.finish();
    f.database.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    reconcileLarkProgressCards();
    await f.progress.tick(); await f.progress.drain();
    assert.deepEqual(f.cards(), saved);
    assert.equal(f.updates.length, 0);

    f.disable();
    reconcileLarkProgressCards(); await f.progress.tick();
    assert.deepEqual(f.updates.map(card => [card.state, card.entries.at(-1)?.text]), [["completed", "pending"]]);
  } finally { await f.close(); }
});

test("pausing a lost-receipt retry saves its recovered card ID without starting a new PATCH", async () => {
  let attempts = 0, release!: () => void, started!: () => void;
  const retryStarted = new Promise<void>(resolve => { started = resolve; });
  const receipt = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => {
    if (++attempts === 1) throw new Error("lost progress receipt");
    started();
    await receipt;
  });
  try {
    f.observe("first"); await f.progress.drain();
    f.due();
    const retry = f.progress.tick();
    await retryStarted;
    f.disable("progress-cards");
    const drained = f.progress.drain();
    release();
    await Promise.all([retry, drained]);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.database.prepare("SELECT card_message_id,pending,attempts FROM lark_progress_cards").get(),
      { card_message_id: "om_card", pending: 1, attempts: 1 });
    f.disable();
    await f.progress.tick();
    assert.equal(f.sent.length, 2);
    assert.equal(f.updates.length, 1);
  } finally { release(); await f.close(); }
});

test("paused DONE leaves the outbox intact and resumes only after final text and media", async () => {
  const f = fixture();
  try {
    f.database.prepare("UPDATE lark_messages SET codex_status='answered'").run();
    const mediaId = Number(f.database.prepare(`INSERT INTO lark_delivery_outbox
      (lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at)
      VALUES (1,'media','{}','media-key','2000-01-01','2000-01-01')`).run().lastInsertRowid);
    const queue = (id: number) => queueLarkCompletionReactions([{ id, messageId: `om_${id}` }], "turn-one", 1, "final-key", [mediaId], true);
    const due = () => f.database.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE kind='completion-reaction'").run();
    queue(1); due();
    const saved = f.doneRows();
    f.disable("completion-reactions");
    queue(2);
    assert.equal(f.completion.tick(), 0);
    assert.deepEqual(f.doneRows(), saved);
    assert.deepEqual(f.reactions, []);

    f.disable();
    assert.equal(f.completion.tick(), 1);
    assert.deepEqual(f.reactions, []);
    f.database.prepare("UPDATE lark_messages SET reply_status='sent' WHERE id=1").run();
    due(); assert.equal(f.completion.tick(), 1);
    assert.deepEqual(f.reactions, []);
    f.database.prepare("UPDATE lark_delivery_outbox SET status='sent' WHERE id=?").run(mediaId);
    due(); assert.equal(f.completion.tick(), 1);
    assert.deepEqual(f.reactions, [["om_1", "DONE"]]);
    assert.equal(f.completion.tick(), 0);
  } finally { await f.close(); }
});
