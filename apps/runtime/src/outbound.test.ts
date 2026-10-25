import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { sendHostOutboundMessage } from "./outbound.js";

function withStore(run: (store: SqliteAgentStore) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "lark-agent-outbound-"));
  const store = new SqliteAgentStore(path.join(directory, "runtime.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("host outbound sends a direct message to a known contact", () => withStore((store) => {
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO contacts (open_id,name,aliases,updated_at) VALUES (?,?,?,?)")
    .run("ou_recipient", "测试联系人", "[]", now);
  const calls: Array<{ recipient: string; text: string; key: string }> = [];
  const records: Array<{ messageId: string; source: string }> = [];
  const result = sendHostOutboundMessage(store, {
    recipient: "测试联系人",
    text: "待办提醒",
    idempotencyKey: "todo-reminder-1"
  }, {
    sendDirect: (recipient, text, key) => {
      calls.push({ recipient, text, key });
      return { ok: true, messageId: "om_sent", chatId: "oc_direct", messageAt: now, messageType: "text" };
    },
    sendReply: () => ({ ok: true, messageId: null, chatId: null, messageAt: null, messageType: null }),
    record: (input) => { records.push({ messageId: input.messageId, source: input.source }); return 1; }
  });

  assert.deepEqual(calls, [{ recipient: "ou_recipient", text: "待办提醒", key: "todo-reminder-1" }]);
  assert.equal(result.messageId, "om_sent");
  assert.deepEqual(records, [{ messageId: "om_sent", source: "proactive" }]);
}));

test("host outbound replies to the source group and mentions its sender", () => withStore((store) => {
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO contacts (open_id,name,aliases,updated_at) VALUES (?,?,?,?)")
    .run("ou_sender", "提单人", "[]", now);
  const row = store.db.prepare(`
    INSERT INTO lark_messages (
      event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,
      codex_status,raw_json,received_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run("evt_source", "om_source", "oc_group", "group", "ou_sender", "text", "帮我处理", 1, "answered", "{}", now, now);
  const calls: Array<{ messageId: string; text: string; key: string }> = [];
  const records: Array<{ messageId: string; replyToMessageId: string | null; source: string }> = [];
  const result = sendHostOutboundMessage(store, {
    replyToLarkMessageId: Number(row.lastInsertRowid),
    text: "待办已经完成",
    idempotencyKey: "todo-complete-1"
  }, {
    sendDirect: () => ({ ok: true, messageId: null, chatId: null, messageAt: null, messageType: null }),
    sendReply: (messageId, text, key) => {
      calls.push({ messageId, text, key });
      return { ok: true, messageId: "om_reply", chatId: "oc_group", messageAt: now, messageType: "text" };
    },
    record: (input) => { records.push({ messageId: input.messageId, replyToMessageId: input.replyToMessageId, source: input.source }); return 2; }
  });

  assert.equal(calls[0]?.messageId, "om_source");
  assert.match(calls[0]?.text ?? "", /^<at user_id="ou_sender">提单人<\/at> 待办已经完成$/);
  assert.equal(calls[0]?.key, "todo-complete-1");
  assert.equal(result.messageId, "om_reply");
  assert.deepEqual(records, [{ messageId: "om_reply", replyToMessageId: "om_source", source: "reply" }]);
}));

test("host outbound remains successful when local recording fails", () => withStore((store) => {
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO contacts (open_id,name,aliases,updated_at) VALUES (?,?,?,?)")
    .run("ou_recipient", "测试联系人", "[]", now);
  const result = sendHostOutboundMessage(store, {
    recipient: "测试联系人",
    text: "待办提醒",
    idempotencyKey: "todo-reminder-record-failure"
  }, {
    sendDirect: () => ({ ok: true, messageId: "om_sent_record_failure", chatId: "oc_direct", messageAt: now, messageType: "text" }),
    sendReply: () => ({ ok: true, messageId: null, chatId: null, messageAt: null, messageType: null }),
    record: () => { throw new Error("simulated record failure"); }
  });
  assert.equal(result.messageId, "om_sent_record_failure");
}));
