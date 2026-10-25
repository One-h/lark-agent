import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../apps/runtime/src/index.js";
import { configureConversationRuntime, enqueueLarkCodexReply, larkResponderOwnsThread, reconcilePendingLarkThreadArchives } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../packages/conversation-runtime/src/codexRuntime.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-rapid-reuse-"));
const textReplySender = () => ({ ok: true as const, messageId: "om_mock" });
const options = { databasePath: path.join(root, "test.sqlite"), mode: "active" as const, trustedSenderIds: [], workspaceRoot: root, textReplySender };
let runtime = createRuntime(options);
configureConversationRuntime({ database: runtime.store.db, mode: "active", repoRoot: root, workspaceRoot: root,
  larkStickerDirectory: path.join(root, "stickers"), taskOutputDir: path.join(root, "tasks"), textReplySender });
runtime.store.setSetting("prompt.larkAssistant", "只回答用户当前问题，保持简短；不要调用工具。");
runtime.store.setSetting("interimRepliesEnabled", "false");
runtime.store.setSetting("stickerUsageMode", "off");
runtime.store.db.prepare("DELETE FROM capabilities").run();
const insert = runtime.store.db.prepare(`INSERT INTO lark_messages
  (message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
  VALUES (?,'oc_rapid','p2p','ou_test','user','text',?,1,'p2p','pending','skipped','{}',?,?)`);
const createdThreadIds = new Set<string>();

async function send(messageId: string, text: string): Promise<{ codex_session_id: string; codex_status: string; codex_error: string | null }> {
  const now = new Date().toISOString();
  const id = Number(insert.run(messageId, text, now, now).lastInsertRowid);
  if (!enqueueLarkCodexReply(id)) throw new Error("Unable to enqueue test message");
  for (let index = 0; index < 300; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = runtime.store.db.prepare("SELECT codex_status,codex_session_id,codex_error FROM lark_messages WHERE id=?").get(id) as { codex_session_id: string; codex_status: string; codex_error: string | null };
    if (row.codex_status === "answered") { createdThreadIds.add(row.codex_session_id); return row; }
    if (["failed", "timeout", "no_reply"].includes(row.codex_status)) throw new Error(JSON.stringify(row));
  }
  throw new Error("Test message timed out");
}

try {
  const first = await send("om_rapid_1", "只回复 ONE");
  const afterFirst = { appServer: codexAppServer.status(), owned: larkResponderOwnsThread(first.codex_session_id) };
  const second = await send("om_rapid_2", "只回复 TWO");
  if (first.codex_session_id !== second.codex_session_id) {
    const afterSecond = { appServer: codexAppServer.status(), firstOwned: larkResponderOwnsThread(first.codex_session_id), secondOwned: larkResponderOwnsThread(second.codex_session_id) };
    const secondTask = runtime.store.db.prepare("SELECT codex_task_dir FROM lark_messages WHERE message_id='om_rapid_2'").get() as { codex_task_dir?: string };
    const stderr = secondTask.codex_task_dir ? fs.readFileSync(path.join(secondTask.codex_task_dir, "codex.stderr.log"), "utf8") : "";
    const reuseCheck = secondTask.codex_task_dir ? fs.readFileSync(path.join(secondTask.codex_task_dir, "codex.stdout.jsonl"), "utf8").split("\n").find((line) => line.includes("thread/reuse-check")) : "";
    throw new Error(`Session split: ${JSON.stringify({ first, afterFirst, second, afterSecond, reuseCheck, stderr })}`);
  }
  let queued: { thread_id: string; attempts: number; due_at: string } | undefined;
  for (let index = 0; index < 30; index += 1) {
    queued = runtime.store.db.prepare("SELECT thread_id,attempts,due_at FROM lark_codex_archive_queue WHERE thread_id=?").get(first.codex_session_id) as typeof queued;
    if (queued) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!queued) throw new Error("Finished thread was not scheduled for durable archiving");
  await runtime.app.close(); runtime.stop();
  runtime = createRuntime(options);
  if (!(runtime.store.db.prepare("SELECT 1 FROM lark_codex_archive_queue WHERE thread_id=?").get(first.codex_session_id))) {
    throw new Error("Pending archive was lost after runtime restart");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
  const afterArchive = runtime.store.db.prepare("SELECT attempts,last_error FROM lark_codex_archive_queue WHERE thread_id=?").get(first.codex_session_id) as { attempts: number; last_error: string | null } | undefined;
  if (afterArchive) throw new Error(`Thread archive did not finish: ${JSON.stringify(afterArchive)}`);
  console.log(JSON.stringify({ ok: true, sessionId: first.codex_session_id, reused: true, afterFirst }));
} finally {
  for (const threadId of createdThreadIds) {
    try { await codexAppServer.requestIfRunning("thread/archive", { threadId }, 10_000); } catch { /* The runtime may already have archived it. */ }
    try { await codexAppServer.requestIfRunning("thread/unsubscribe", { threadId }, 10_000); } catch { /* The runtime may already have unloaded it. */ }
  }
  runtime.stop();
  if (process.env.LARK_KEEP_RAPID_REUSE_ARTIFACTS === "1") console.error(`Rapid reuse artifacts: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
