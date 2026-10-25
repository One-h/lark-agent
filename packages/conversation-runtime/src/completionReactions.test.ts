import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, type LarkReactionSender } from "./context.js";
import { queueLarkCompletionReactions, retryPendingLarkCompletionReactions } from "./completionReactions.js";

function fixture(sender?: LarkReactionSender, mode: "active" | "shadow" = "active") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-completion-reaction-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  configureConversationRuntime({ database: store.db, mode, repoRoot: root, larkStickerDirectory: path.join(root, "stickers"),
    reactionSender: sender ?? ((messageId, emoji) => { reactions.push({ messageId, emoji }); return { ok: true }; }) });
  const now = new Date().toISOString();
  for (const id of [1, 2]) store.db.prepare(`INSERT INTO lark_messages
    (id,message_id,chat_id,chat_type,reply_status,reply_delivery_key,codex_status,codex_turn_id,raw_json,received_at,created_at)
    VALUES (?,?,'oc_fixture','p2p','sent','final-key','answered','turn-fixture','{}',?,?)`).run(id, `om_${id}`, now, now);
  const rows = () => store.db.prepare("SELECT * FROM lark_delivery_outbox WHERE kind='completion-reaction' ORDER BY id").all() as Array<{ status: string; attempts: number; last_error: string }>;
  const due = () => store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='1970-01-01T00:00:00Z'").run();
  return { store, reactions, rows, due,
    queue(ids = [1], key: string | undefined = "final-key", mediaIds: number[] = []) { queueLarkCompletionReactions(ids.map(id => ({ id, messageId: `om_${id}` })), "turn-fixture", 1, key, mediaIds); },
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("one DONE per original message, including merged members and intentional silence", () => {
  const f = fixture(); try {
    f.store.db.prepare("UPDATE lark_messages SET codex_status='no_reply' WHERE id=2").run();
    f.queue([1, 2]); f.queue([1, 2]); retryPendingLarkCompletionReactions();
    assert.deepEqual(f.reactions, [{ messageId: "om_1", emoji: "DONE" }, { messageId: "om_2", emoji: "DONE" }]);
    assert.deepEqual(f.rows().map(r => r.status), ["sent", "sent"]);
  } finally { f.close(); }
});

test("running, failed, cancelled and superseded turns never receive DONE", () => {
  for (const status of ["running", "queued", "failed", "timeout", "skipped"]) {
    const f = fixture(); try {
      f.store.db.prepare("UPDATE lark_messages SET codex_status=? WHERE id=1").run(status);
      f.queue(); assert.deepEqual(f.reactions, []); assert.equal(f.rows()[0].status, "failed");
    } finally { f.close(); }
  }
  const f = fixture(); try {
    f.store.db.prepare("UPDATE lark_messages SET reply_status='pending' WHERE id=1").run();
    f.queue(); f.store.db.prepare("UPDATE lark_messages SET codex_turn_id='new-turn',reply_status='sent' WHERE id=1").run();
    f.due(); retryPendingLarkCompletionReactions(); assert.deepEqual(f.reactions, []);
    assert.equal(f.rows()[0].status, "failed");
  } finally { f.close(); }
});

test("final text retry finishes before DONE; permanent delivery failure never marks success", () => {
  for (const next of ["sent", "failed"]) {
    const f = fixture(); try {
      f.store.db.prepare("UPDATE lark_messages SET reply_status='pending' WHERE id=1").run();
      f.queue([1, 2]); assert.deepEqual(f.reactions, []);
      f.store.db.prepare("UPDATE lark_messages SET reply_status=? WHERE id=1").run(next);
      f.due(); retryPendingLarkCompletionReactions();
      assert.equal(f.reactions.length, next === "sent" ? 2 : 0);
    } finally { f.close(); }
  }
});

test("attachments must also be delivered before DONE", () => {
  for (const next of ["sent", "failed"]) {
    const f = fixture(); try {
      const id = Number(f.store.db.prepare("INSERT INTO lark_delivery_outbox(lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at) VALUES(1,'media','{}','media-key','1970-01-01','1970-01-01')").run().lastInsertRowid);
      f.queue([1], undefined, [id]); assert.deepEqual(f.reactions, []);
      f.store.db.prepare("UPDATE lark_delivery_outbox SET status=? WHERE id=?").run(next, id);
      f.due(); retryPendingLarkCompletionReactions(); assert.equal(f.reactions.length, next === "sent" ? 1 : 0);
    } finally { f.close(); }
  }
});

test("reaction failures retry durably without changing the successful task or text delivery", () => {
  let attempts = 0;
  const f = fixture(() => { attempts++; if (attempts === 1) throw new Error("temporary transport failure"); return { ok: true }; });
  try {
    f.queue(); assert.equal(f.rows()[0].attempts, 1); assert.equal(f.rows()[0].status, "pending");
    f.due(); assert.equal(retryPendingLarkCompletionReactions(), 1); assert.equal(f.rows()[0].status, "sent");
    assert.equal(retryPendingLarkCompletionReactions(), 0); assert.equal(attempts, 2);
    assert.deepEqual(f.store.db.prepare("SELECT codex_status,reply_status,reply_error FROM lark_messages WHERE id=1").get(), { codex_status: "answered", reply_status: "sent", reply_error: null });
  } finally { f.close(); }
});

test("reaction retries are bounded and shadow mode does not emit completion reactions", () => {
  const f = fixture(() => ({ ok: false, error: "transport unavailable" })); try {
    f.queue(); for (let i = 1; i < 8; i++) { f.due(); retryPendingLarkCompletionReactions(); }
    assert.equal(f.rows()[0].attempts, 8); assert.equal(f.rows()[0].status, "failed");
    f.due(); assert.equal(retryPendingLarkCompletionReactions(), 0);
  } finally { f.close(); }
  const shadow = fixture(undefined, "shadow"); try { shadow.queue(); assert.deepEqual(shadow.reactions, []); assert.deepEqual(shadow.rows(), []); }
  finally { shadow.close(); }
});
