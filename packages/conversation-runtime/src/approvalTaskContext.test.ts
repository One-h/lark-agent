import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { loadApprovalTaskContext, formatApprovalTaskContext } from "./approvalTaskContext.js";
import { configureTurnApprovalReviewer, reviewLarkTurnAutoApproval, stopLarkTurnAutoApprovalReviews } from "./turnAutoApproval.js";
import { turnApprovalModelPrompt } from "./turnApprovalReviewer.js";

test("approval background is bounded, chronological and isolated by person, chat, thread, topic and time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-approval-background-"));
  const store = new SqliteAgentStore(path.join(root, "agent.sqlite"));
  try {
    configureConversationRuntime({ database: store.db, repoRoot: root, workspaceRoot: root, larkStickerDirectory: path.join(root, "stickers"), approverId: "ou_owner" });
    const insert = store.db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,sender_id,codex_session_id,thread_id,received_at,created_at,content,codex_reply,sender_type,direction,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'{}')`);
    const add = (id: number, patch: Partial<{chat: string; sender: string; thread: string; topic: string | null; at: string; content: string; result: string; type: string; direction: string}> = {}) => {
      const row = { chat: "oc_chat", sender: "ou_sender", thread: "thread-one", topic: null, at: "2026-01-01T11:00:00Z", content: `history-${id}`, result: "", type: "user", direction: "inbound", ...patch };
      insert.run(id, `om_${id}`, row.chat, row.sender, row.thread, row.topic, row.at, row.at, row.content, row.result, row.type, row.direction);
    };
    add(1, { content: "部署 demo-api 和 demo-worker", result: "发布暂停，等待确认。" });
    add(2, { content: "什么前置条件？" });
    add(3, { chat: "oc_other" }); add(4, { sender: "ou_other" }); add(5, { thread: "thread-other" });
    add(6, { topic: "topic-other" }); add(7, { at: "2025-12-31T00:00:00Z" }); add(8, { type: "app" });
    add(9, { direction: "outbound" }); add(10, { at: "2026-01-02T00:00:00Z" });
    add(20, { at: "2026-01-01T12:00:00Z", content: "这是第一次上线，为什么需要处理旧数据？" });
    const context = loadApprovalTaskContext(store.db, 20, "ou_sender");
    assert.deepEqual(context.map(row => row.messageId), [1, 2]);
    assert.match(formatApprovalTaskContext(context), /部署 demo-api 和 demo-worker/);
    assert.deepEqual(loadApprovalTaskContext(store.db, 20, "ou_other"), []);
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    let sawBackground = false;
    configureTurnApprovalReviewer(async input => {
      sawBackground = true;
      assert.equal(input.originalMessage, "这是第一次上线，为什么需要处理旧数据？");
      assert.deepEqual(input.taskContext?.map(row => row.messageId), [1, 2]);
      const prompt = JSON.parse(turnApprovalModelPrompt(input, []));
      assert.equal(prompt.request, input.originalMessage); assert.match(prompt.taskContext[0].request, /部署 demo-api/);
      return { decision: "manual", reason: "背景不是新授权" };
    });
    const decision = await reviewLarkTurnAutoApproval({ messageId: 20, turnId: "new-turn", senderId: "ou_sender", originalMessage: "这是第一次上线，为什么需要处理旧数据？", operation: 'forge.deploy.production: {"repo":"demo-api","apps":["demo-api"]}', cwd: root });
    assert.equal(sawBackground, true); assert.equal(decision.source, "model"); assert.equal(decision.approved, false);
    for (let id = 11; id < 17; id++) add(id, { content: "x".repeat(1000), result: "y".repeat(1000) });
    const bounded = loadApprovalTaskContext(store.db, 20, "ou_sender");
    assert.equal(bounded.length, 6);
    assert.ok(bounded.reduce((n, row) => n + row.request.length + row.result.length, 0) <= 2400);
  } finally { stopLarkTurnAutoApprovalReviews(); configureTurnApprovalReviewer(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
