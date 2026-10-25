import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { claimLarkCodexReply } from "./responder.js";
import { hasRecentHandledLarkMessage, shouldStartSpontaneousLarkReply } from "./worker.js";
import { conversationSpontaneousSettings, setConversationSpontaneousSettings } from "./spontaneous.js";

test("unmentioned spontaneous selections enter the queue once and participate in cooldown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-spontaneous-queue-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: root, mode: "active" });
  const event = { chat_id: "oc_group", chat_type: "group", sender_type: "user", message_type: "text", content: "1111" };
  const now = Date.now();
  let counter = 0;
  const insert = (trigger = "spontaneous", mentioned = 0, chat = "oc_group", sender = "user", type = "text", messageId: string | null = `om_${++counter}`) => Number(store.db.prepare(`
    INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
    VALUES (?,?,'group',?,?,'1111',?,?,'pending','skipped','{}',?,?)
  `).run(messageId, chat, sender, type, mentioned, trigger, new Date(now).toISOString(), new Date(now).toISOString()).lastInsertRowid);
  try {
    setAppSettingValue("repliesEnabled", "true");
    setAppSettingValue("groupSpontaneousRepliesEnabled", "true");
    setAppSettingValue("groupSpontaneousReplyRate", "1");
    setAppSettingValue("groupSpontaneousReplyCooldownMs", "120000");
    setAppSettingValue("groupSpontaneousChatIds", '["oc_group"]');
    assert.equal(shouldStartSpontaneousLarkReply(event, false, hasRecentHandledLarkMessage("oc_group", now), 0.9), true);
    const id = insert();
    assert.equal(claimLarkCodexReply(id), true);
    assert.deepEqual(store.db.prepare("SELECT mentioned,reply_trigger,codex_status FROM lark_messages WHERE id=?").get(id), { mentioned: 0, reply_trigger: "spontaneous", codex_status: "queued" });
    assert.equal(claimLarkCodexReply(id), false);
    for (const state of ["queued", "running", "answered", "no_reply"]) {
      store.db.prepare("UPDATE lark_messages SET codex_status=? WHERE id=?").run(state, id);
      assert.equal(hasRecentHandledLarkMessage("oc_group", now), true);
      assert.equal(shouldStartSpontaneousLarkReply(event, false, hasRecentHandledLarkMessage("oc_group", now), 0), false);
    }
    assert.equal(hasRecentHandledLarkMessage("oc_other", now), false);
    assert.equal(hasRecentHandledLarkMessage("oc_group", now + 119_999), true);
    assert.equal(hasRecentHandledLarkMessage("oc_group", now + 120_001), false);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, hasRecentHandledLarkMessage("oc_group", now + 120_001), 0.9), true);
    setAppSettingValue("groupSpontaneousReplyCooldownMs", "0");
    assert.equal(hasRecentHandledLarkMessage("oc_group", now), false);
    for (const state of ["failed", "timeout", "skipped"]) {
      store.db.prepare("UPDATE lark_messages SET codex_status=? WHERE id=?").run(state, id);
      assert.equal(hasRecentHandledLarkMessage("oc_group", now), false);
    }
    assert.equal(claimLarkCodexReply(insert("none")), false);
    assert.equal(claimLarkCodexReply(insert("spontaneous", 0, "oc_other")), false);
    assert.equal(claimLarkCodexReply(insert("spontaneous", 0, "oc_group", "bot")), false);
    assert.equal(claimLarkCodexReply(insert("spontaneous", 0, "oc_group", "user", "image")), false);
    assert.equal(claimLarkCodexReply(insert("spontaneous", 0, "oc_group", "user", "text", null)), false);
    const waiting = insert();
    setAppSettingValue("groupSpontaneousRepliesEnabled", "false");
    assert.equal(claimLarkCodexReply(waiting), false);
    assert.equal(claimLarkCodexReply(insert("mention", 1, "oc_other")), true);
    setAppSettingValue("groupSpontaneousRepliesEnabled", "true");
    setAppSettingValue("groupSpontaneousReplyRate", "0");
    assert.equal(claimLarkCodexReply(waiting), false);
    setAppSettingValue("groupSpontaneousReplyRate", "1");
    setAppSettingValue("repliesEnabled", "false");
    assert.equal(claimLarkCodexReply(waiting), false);
    assert.equal(claimLarkCodexReply(insert("mention", 1)), false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("each group can override global spontaneous replies without enabling other groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-spontaneous-groups-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: root, mode: "active" });
  const event = { chat_id: "oc_group", chat_type: "group", sender_type: "user", message_type: "text", content: "hello" };
  const now = Date.now();
  const insert = () => Number(store.db.prepare(`
    INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
    VALUES (?,?,'group','user','text','hello',0,'spontaneous','pending','skipped','{}',?,?)
  `).run(`om_${now}_${Math.random()}`, "oc_group", new Date(now).toISOString(), new Date(now).toISOString()).lastInsertRowid);
  try {
    setAppSettingValue("repliesEnabled", "true");
    setAppSettingValue("groupSpontaneousRepliesEnabled", "false");
    setAppSettingValue("groupSpontaneousReplyRate", "0.2");
    setAppSettingValue("groupSpontaneousReplyCooldownMs", "120000");
    setAppSettingValue("groupSpontaneousChatIds", "[]");
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0), false);
    setConversationSpontaneousSettings("oc_group", { mode: "on", replyRate: 0.5, cooldownMs: 60_000 });
    assert.equal(conversationSpontaneousSettings("oc_group").effectiveEnabled, true);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.4), true);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.6), false);
    assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_id: "oc_other" }, false, false, 0), false);
    const id = insert();
    assert.equal(claimLarkCodexReply(id), true);
    assert.equal(hasRecentHandledLarkMessage("oc_group", now + 59_999), true);
    assert.equal(hasRecentHandledLarkMessage("oc_group", now + 60_001), false);
    setConversationSpontaneousSettings("oc_group", { mode: "off" });
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0), false);
    assert.equal(claimLarkCodexReply(insert()), false);
    setAppSettingValue("groupSpontaneousRepliesEnabled", "true");
    setAppSettingValue("groupSpontaneousChatIds", '["oc_group"]');
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0), false);
    setConversationSpontaneousSettings("oc_group", { mode: "global" });
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.1), true);
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.3), false);
    assert.equal(claimLarkCodexReply(insert()), true);
    setAppSettingValue("groupSpontaneousChatIds", "[]");
    assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0), false);
    assert.throws(() => setConversationSpontaneousSettings("oc_group", { replyRate: 2 }), /概率/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
