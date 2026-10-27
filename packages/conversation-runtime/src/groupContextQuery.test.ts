import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime } from "./context.js";
import { buildLarkCodexDeltaPrompt, formatRecentLarkMessages, loadLarkGroupContext, loadRecentLarkChatMessages } from "./responder.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-context-query-"));
  const store = new SqliteAgentStore(path.join(root, "agent.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: path.join(root, "stickers") });
  return { root, store };
}

test("bounded context preserves chronological windows, topic isolation and scoped cursors", () => {
  const { root, store } = fixture();
  try {
    const insert = store.db.prepare(`INSERT INTO lark_messages
      (message_id,chat_id,chat_type,thread_id,root_message_id,content,message_at,received_at,created_at,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,'{}')`);
    const rows: Array<{ id: number; message_id: string; chat_id: string; thread_id: string | null; root_message_id: string | null; at: string }> = [];
    store.db.transaction(() => {
      for (let i = 0; i < 240; i += 1) {
        const message_id = `message-${i}`;
        const chat_id = i % 7 === 0 ? "other-group" : "test-group";
        const thread_id = i % 4 === 0 ? "topic-a" : i % 4 === 1 ? "topic-b" : null;
        const root_message_id = thread_id === "topic-a" ? "message-2" : thread_id === "topic-b" ? "message-3" : null;
        const at = `2026-01-01T00:00:0${i % 9}.000Z`;
        const id = Number(insert.run(message_id, chat_id, i % 5 === 0 ? null : "group", thread_id, root_message_id,
          `content-${i}`, i % 3 === 0 ? null : at, at, at).lastInsertRowid);
        rows.push({ id, message_id, chat_id, thread_id, root_message_id, at });
      }
    })();
    const current = { id: 220, chat_id: "test-group", root_message_id: null as string | null, thread_id: null as string | null };
    const sort = (a: typeof rows[number], b: typeof rows[number]) => a.at.localeCompare(b.at) || a.id - b.id;
    const roots = new Set(rows.filter(row => row.chat_id === current.chat_id && row.thread_id !== null).map(row => row.root_message_id));
    const ordinary = (row: typeof rows[number]) => row.thread_id === null && !roots.has(row.message_id);
    for (const thread of [null, "topic-a", "topic-b"]) {
      for (const trusted of [false, true]) {
        const cursor = trusted ? 200 : 10;
        const key = `${current.chat_id}::${thread ? `topic:${thread}` : "main-v2"}`;
        store.db.prepare("INSERT INTO lark_group_context_cursors VALUES (?,?,?,?)")
          .run(key, trusted ? "trusted" : "untrusted", cursor, "2026-01-01");
        const message = { ...current, thread_id: thread, root_message_id: thread === "topic-a" ? "message-2" : thread === "topic-b" ? "message-3" : null };
        const eligible = rows.filter(row => row.chat_id === message.chat_id && row.id > cursor && row.id < message.id
          && (thread ? row.thread_id === thread || row.message_id === message.root_message_id : ordinary(row))).sort(sort);
        for (const limit of [0, 1, 5, 50, 1000]) {
          const context = loadLarkGroupContext(message, trusted, limit, true);
          assert.deepEqual(context.messages.map(row => row.id), limit ? eligible.slice(-limit).map(row => row.id) : []);
          assert.equal(context.hasMore, limit > 0 && eligible.length > limit);
          assert.equal(context.cursorId, limit ? message.id : null);
          if (thread && limit) {
            const boundary = rows.find(row => row.message_id === message.root_message_id)!.id;
            const background = rows.filter(row => row.chat_id === message.chat_id && row.id < boundary && ordinary(row)).sort(sort).slice(-10);
            assert.deepEqual(context.backgroundMessages.map(row => row.id), background.map(row => row.id));
          } else assert.deepEqual(context.backgroundMessages, []);
        }
        assert.equal((store.db.prepare("SELECT last_message_id FROM lark_group_context_cursors WHERE chat_id=? AND trust_scope=?")
          .get(key, trusted ? "trusted" : "untrusted") as { last_message_id: number }).last_message_id, cursor);
      }
    }
    assert.equal(loadLarkGroupContext({ ...current, chat_id: null }, false).hasMore, false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("context reads use explicit indexes and limit plus one without exact counts", () => {
  const { root, store } = fixture();
  const originalPrepare = store.db.prepare;
  const queries: string[] = [];
  try {
    store.db.pragma("automatic_index = OFF");
    store.db.prepare = function (this: typeof store.db, sql: string) {
      queries.push(sql);
      return originalPrepare.call(this, sql);
    } as typeof store.db.prepare;
    loadLarkGroupContext({ id: 10, chat_id: "test-group", thread_id: null }, false, 50);
    loadLarkGroupContext({ id: 10, chat_id: "test-group", thread_id: "topic-a", root_message_id: "root-a" }, false, 50, true);
    loadRecentLarkChatMessages("test-group", 10, 50);
    store.db.prepare = originalPrepare;
    const contextQueries = queries.filter(sql => /FROM lark_messages AS messages/.test(sql));
    assert.equal(contextQueries.length, 4);
    assert.ok(queries.every(sql => !/COUNT\s*\(/i.test(sql)));
    for (const sql of contextQueries) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill(0)) as Array<{ detail: string }>;
      const details = plan.map(row => row.detail).join("\n");
      assert.match(details, /SEARCH messages USING INDEX idx_lark_messages_context_time/);
      assert.doesNotMatch(details, /SCAN (?:messages|topic_child)|USE TEMP B-TREE FOR ORDER BY/);
      if (/topic_child/.test(sql)) assert.match(details, /SEARCH topic_child USING COVERING INDEX idx_lark_messages_context_root/);
    }
    const context = loadLarkGroupContext({ id: 10, chat_id: "test-group", thread_id: null }, false, 50);
    assert.equal(context.hasMore, false);
  } finally { store.db.prepare = originalPrepare; store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("omission hints distinguish bounded history from exact text-budget truncation", () => {
  const { root, store } = fixture();
  try {
    store.db.prepare(`INSERT INTO lark_messages (message_id,chat_id,content,raw_json,received_at,created_at)
      VALUES ('older','test-group','hello','{}','2026-01-01','2026-01-01')`).run();
    const context = loadLarkGroupContext({ id: 2, chat_id: "test-group" }, false, 1);
    assert.doesNotMatch(formatRecentLarkMessages(context.messages, 1000, 0, context.hasMore), /已省略/);
    assert.match(formatRecentLarkMessages(context.messages, 1000, 3), /已省略更早的 3 条消息/);
    const message = { id: 2, message_id: "current", chat_id: "test-group", chat_type: "group", sender_id: null,
      content: "hi", reply_to_message_id: null, reply_to_message_type: null, reply_to_content: null };
    const prompt = buildLarkCodexDeltaPrompt(message, { recentMessages: context.messages, recentMessagesHasMore: true });
    assert.match(prompt, /已省略更早的消息/);
    assert.doesNotMatch(prompt, /已省略更早的 \d+ 条消息/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("existing isolated databases receive context indexes without changing messages or cursors", () => {
  const { root, store } = fixture();
  try {
    store.db.exec("DROP INDEX idx_lark_messages_context_time; DROP INDEX idx_lark_messages_context_root");
    store.db.prepare(`INSERT INTO lark_messages (message_id,chat_id,content,raw_json,received_at,created_at)
      VALUES ('kept','test-group','preserved','{}','2026-01-01','2026-01-01')`).run();
    store.db.prepare("INSERT INTO lark_group_context_cursors VALUES ('test-group::main-v2','untrusted',1,'2026-01-01')").run();
    // First run the old, unrelated backfills so this check isolates index migration.
    store.migrate();
    const before = store.db.prepare("SELECT * FROM lark_messages").all();
    const cursors = store.db.prepare("SELECT * FROM lark_group_context_cursors").all();
    store.db.exec("DROP INDEX idx_lark_messages_context_time; DROP INDEX idx_lark_messages_context_root");
    store.migrate();
    store.migrate();
    assert.deepEqual(store.db.prepare("SELECT * FROM lark_messages").all(), before);
    assert.deepEqual(store.db.prepare("SELECT * FROM lark_group_context_cursors").all(), cursors);
    assert.equal((store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_lark_messages_context_%'").get() as { n: number }).n, 2);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
