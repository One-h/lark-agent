import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import { createRuntime } from "../apps/runtime/src/index.js";
import { configureConversationRuntime, enqueueLarkCodexReply, retryPendingLarkMediaReplies, retryPendingLarkTextReplies, uploadLarkStickers } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../packages/conversation-runtime/src/codexRuntime.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-mcp-resume-"));
const legacy = new CodexAppServerClient(() => root);
const created = await legacy.request<{ thread: { id: string } }>("thread/start", { cwd: root, model: "gpt-5.6-terra", approvalPolicy: "never", sandbox: "read-only" });
const legacyThreadId = created.thread.id;
let legacyTurnId = "";
const legacyCompleted = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("legacy test turn timed out")), 60_000);
  const unsubscribe = legacy.onNotification((notification) => {
    if (notification.method !== "turn/completed") return;
    const params = notification.params as { turn?: { id?: unknown; status?: unknown } };
    if (params.turn?.id !== legacyTurnId) return;
    clearTimeout(timeout); unsubscribe(); resolve();
  });
});
const legacyTurn = await legacy.request<{ turn: { id: string } }>("turn/start", { threadId: legacyThreadId, input: [{ type: "text", text: "只回复 ready。" }], cwd: root, approvalPolicy: "never" });
legacyTurnId = legacyTurn.turn.id;
await legacyCompleted;
await legacy.request("thread/archive", { threadId: legacyThreadId });
legacy.stop();
await new Promise((resolve) => setTimeout(resolve, 500));

const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", trustedSenderIds: [], workspaceRoot: root, port: 4784 });
const delivery: string[] = [];
configureConversationRuntime({ database: runtime.store.db, mode: "active", repoRoot: root, workspaceRoot: root, larkStickerDirectory: path.join(root, "stickers"), runtimeUrl: "http://127.0.0.1:4784",
  textReplySender: () => { delivery.push("text"); return { ok: true, messageId: "om_mock_text" }; },
  mediaReplySender: () => { delivery.push("sticker"); return { ok: true }; }
});
try {
  await runtime.app.listen({ host: "127.0.0.1", port: 4784 });
  runtime.store.db.prepare("DELETE FROM capabilities").run();
  runtime.store.setSetting("prompt.larkAssistant", "这是隔离的 MCP 恢复测试。用户要表情包时必须使用 lark_stickers MCP 搜索并选择，再简短回复；不调用其他工具。");
  runtime.store.setSetting("interimRepliesEnabled", "false");
  const now = new Date().toISOString();
  runtime.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES ('oc_resume::untrusted','oc_resume','untrusted',?,?,?)").run(legacyThreadId, now, now);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
  uploadLarkStickers([{ name: "得意", description: "得意自夸", tags: ["得意", "自夸"], fileName: "test.png", mimeType: "image/png", dataBase64: png }]);
  const saved = runtime.store.db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,raw_json,received_at,created_at) VALUES ('om_resume','oc_resume','p2p','ou_test','user','text',?,1,'p2p','{}',?,?)").run("来一个得意的表情包，再配一句话。", now, now);
  const messageId = Number(saved.lastInsertRowid);
  assert(enqueueLarkCodexReply(messageId));
  let row: { codex_status: string; codex_error: string | null; codex_task_dir: string | null } | undefined;
  for (let index = 0; index < 120; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    retryPendingLarkTextReplies(); retryPendingLarkMediaReplies();
    row = runtime.store.db.prepare("SELECT codex_status,codex_error,codex_task_dir FROM lark_messages WHERE id=?").get(messageId) as typeof row;
    if (row?.codex_status === "answered" && delivery.includes("sticker")) break;
    if (row && ["failed", "no_reply"].includes(row.codex_status)) break;
  }
  assert.equal(row?.codex_status, "answered", row?.codex_error ?? "resume test timed out");
  assert.deepEqual(delivery.slice(-2), ["text", "sticker"]);
  assert(row?.codex_task_dir);
  const session = JSON.parse(fs.readFileSync(path.join(row.codex_task_dir, "resume-session.json"), "utf8"));
  assert.equal(session.previousSessionId, legacyThreadId);
  assert.equal(session.currentSessionId, legacyThreadId);
  const events = fs.readFileSync(path.join(row.codex_task_dir, "codex.stdout.jsonl"), "utf8");
  assert(events.includes("lark_stickers") && events.includes("search") && events.includes("select"));
  console.log(JSON.stringify({ ok: true, legacyThreadId, resumedSameThread: true, delivery }));
  await codexAppServer.requestIfRunning("thread/archive", { threadId: legacyThreadId }, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
} finally {
  await runtime.app.close(); runtime.stop();
}
