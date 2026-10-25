import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { larkReplyIdempotencyKey } from "@lark-agent/adapter-lark-cli";
import { createRuntime } from "../apps/runtime/src/index.js";
import { configureConversationRuntime, enqueueLarkCodexReply, uploadLarkStickers, retryPendingLarkMediaReplies, retryPendingLarkTextReplies } from "@lark-agent/conversation-runtime";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-e2e-"));
const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", trustedSenderIds: [], workspaceRoot: root, port: 4783 });
const delivery: string[] = [];
let finalAttempts = 0;
let failedFinalKey: string | null = null;
let successfulFinalKey: string | null = null;
configureConversationRuntime({ database: runtime.store.db, mode: "active", repoRoot: root, workspaceRoot: root, larkStickerDirectory: path.join(root, "stickers"), runtimeUrl: "http://127.0.0.1:4783",
  textReplySender: (_id, _text, key) => {
    const task = runtime.store.db.prepare("SELECT codex_turn_id FROM lark_messages WHERE message_id='om_sticker_test'").get() as { codex_turn_id: string | null } | undefined;
    if (task?.codex_turn_id && key === larkReplyIdempotencyKey("codexfinal", `${task.codex_turn_id}:om_sticker_test`)) {
      finalAttempts++;
      if (finalAttempts === 1) { failedFinalKey = key; delivery.push("text-failed"); return { ok: false, error: "simulated temporary delivery failure" }; }
      successfulFinalKey = key;
    }
    delivery.push("text"); return { ok: true, messageId: "om_mock_text" };
  },
  mediaReplySender: (_messageId, taskDir, relativePath) => { assert(fs.existsSync(path.join(taskDir, relativePath))); assert(successfulFinalKey); delivery.push("sticker"); return { ok: true }; }
});
try {
  await runtime.app.listen({host:"127.0.0.1",port:4783});
  runtime.store.db.prepare("DELETE FROM capabilities").run();
  runtime.store.setSetting("prompt.larkAssistant", "这是隔离的表情工具测试。只使用 lark_stickers MCP 的 search/select；不读取工作区、不调用 shell 或联网工具。正常回答用户，不解释测试过程。");
  runtime.store.setSetting("interimRepliesEnabled", "false");
  const sourceDb = process.argv[process.argv.indexOf("--sticker-db") + 1];
  if (process.argv.includes("--sticker-db")) {
    const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try {
      const rows = source.prepare("SELECT name,description,tags,file_name,mime_type FROM stickers WHERE enabled=1 AND deleted_at IS NULL AND name LIKE '%得意%' AND size_bytes<=2097152 LIMIT 3").all() as Array<{name:string;description:string;tags:string;file_name:string;mime_type:string}>;
      assert(rows.length>0);
      uploadLarkStickers(rows.map((s)=>({name:s.name,description:s.description,tags:JSON.parse(s.tags),fileName:path.basename(s.file_name),mimeType:s.mime_type,dataBase64:fs.readFileSync(path.join(path.dirname(sourceDb),"stickers",path.basename(s.file_name))).toString("base64")})));
    } finally {source.close();}
  } else {
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
    uploadLarkStickers([{ name:"得意", description:"得意自夸", tags:["得意","自夸"], fileName:"test.png",mimeType:"image/png",dataBase64:png }]);
  }
  const now=new Date().toISOString();
  const id=Number(runtime.store.db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,raw_json,received_at,created_at) VALUES ('om_sticker_test','oc_sticker_test','p2p','ou_test','user','text',?,1,'p2p','{}',?,?)").run("来一个得意的表情包，再配一句简短的话。",now,now).lastInsertRowid);
  assert(enqueueLarkCodexReply(id));
  let row: any;
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r,1000));
    retryPendingLarkTextReplies();retryPendingLarkMediaReplies();
    row=runtime.store.db.prepare("SELECT codex_status,codex_error,codex_reply,codex_task_dir FROM lark_messages WHERE id=?").get(id);
    if(row.codex_status==="answered"&&delivery.includes("sticker"))break;
    if(["failed","no_reply"].includes(row.codex_status))break;
  }
  assert.equal(row.codex_status,"answered",row.codex_error);
  assert(delivery.includes("sticker"),"model did not select a sticker");
  assert.equal(delivery.at(-1),"sticker");
  assert(delivery.indexOf("text")<delivery.indexOf("sticker"));
  assert.equal(delivery.filter(x=>x==="sticker").length,1);
  assert(delivery.includes("text-failed"));
  assert.equal(failedFinalKey, successfulFinalKey);
  const events=fs.readFileSync(path.join(row.codex_task_dir,"codex.stdout.jsonl"),"utf8");
  assert(events.includes("lark_stickers") && events.includes("search") && events.includes("select"));
  console.log(JSON.stringify({ok:true,delivery,reply:row.codex_reply,artifacts:root}));
} finally {await runtime.app.close();runtime.stop();}
