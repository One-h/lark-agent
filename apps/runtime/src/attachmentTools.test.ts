import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config, enqueueLarkCodexReply, retryPendingLarkMediaReplies, retryPendingLarkTextReplies, retryPendingLarkCompletionReactions } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { createRuntime } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
async function until(check: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!check()) { assert(performance.now() < deadline, "attachment fixture timed out"); await immediate(); }
}

async function fixture(sharedToken = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-attachment-native-"));
  const executable = path.join(root, "codex.mjs"), cli = path.join(root, "lark-cli"), log = path.join(root, "cli.jsonl"), failureFile = path.join(root, "fail-media");
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
let turn=0;
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"attachment-thread"}}});
 else if(m.method==="thread/loaded/list")send({id:m.id,result:{data:["attachment-thread"],nextCursor:null}});
 else if(m.method==="turn/start"||m.method==="turn/steer"){
  if(m.method==="turn/start")turn++;
  send({id:m.id,result:{turn:{id:"attachment-turn-"+turn,status:"inProgress"}}});
  send({method:"item/completed",params:{threadId:"attachment-thread",turnId:"attachment-turn-"+turn,item:{type:"userMessage",clientId:m.params.clientUserMessageId}}});
 }else if(m.method==="fixture/emit"){send({id:m.id,result:{}});for(const n of m.params.notifications)send(n);}
 else if(m.method)send({id:m.id,result:{}});
});
`); fs.chmodSync(executable, 0o755);
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from "node:fs";
const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+"\\n");
if(fs.existsSync(${JSON.stringify(failureFile)})&&(a.includes("--file")||a.includes("--msg-type"))){console.error("fixture upload failed");process.exit(1);}
console.log(JSON.stringify({ok:true,data:{message_id:"om_cli_fixture",chat_id:"oc_fixture",image_key:"img_fixture",messages:[]}}));
`); fs.chmodSync(cli, 0o755);
  const oldPath = process.env.PATH, oldCodex = process.env.CODEX_EXECUTABLE;
  process.env.PATH = `${root}:${oldPath ?? ""}`; process.env.CODEX_EXECUTABLE = executable;
  const texts: Array<{ id: string; text: string; key: string }> = [], reactions: string[] = [];
  let failText = false;
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [], runtimeToken: sharedToken ? "fixture-secret" : undefined, port: 0,
    textReplySender: (id, text, key) => { if (failText) return { ok: false, error: "fixture text failure" }; texts.push({ id, text, key });
      return { ok: true, messageId: `om_text_${texts.length}`, chatId: "oc_fixture", messageAt: null, messageType: "text" }; },
    reactionSender: (id, emoji) => { reactions.push(`${id}:${emoji}`); return { ok: true }; } });
  await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { stickerUsageMode: "off", interimRepliesEnabled: false, executionReceiptsEnabled: false } });
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`; config.larkAgentRuntimeUrl = url;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const client = new Client({ name: "attachments-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(source, "node_modules/tsx/dist/cli.mjs"), path.join(source, "packages/mcp-stickers/src/index.ts")], cwd: source,
    env: { ...process.env, LARK_AGENT_RUNTIME_URL: url, LARK_AGENT_RUNTIME_TOKEN: config.larkAgentRuntimeToken } as Record<string, string> }));
  const row = (id = 1) => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE id=?").get(id) as any;
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
  const mediaCalls = () => calls().filter(a => a.includes("+messages-reply") && (a.includes("--file") || a.includes("--msg-type")));
  const due = () => {
    runtime.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='1970-01-01' WHERE status='pending'").run();
    runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE reply_status='pending'").run();
  };
  return { root, runtime, client, texts, reactions, row, calls, mediaCalls, due,
    failText(value: boolean) { failText = value; },
    failMedia() { fs.writeFileSync(failureFile, "fail"); },
    async start(id = 1) {
      const now = new Date().toISOString();
      runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
        VALUES(?,?,'oc_fixture','p2p','ou_sender','user','text','export fixture files',1,'p2p','pending','failed','{}',?,?)`).run(id, `om_${id}`, now, now);
      assert.equal(enqueueLarkCodexReply(id), true);
      await until(() => Boolean(row(id).codex_turn_id) && fs.existsSync(path.join(row(id).codex_task_dir, "prompt.md")));
      const prompt = fs.readFileSync(path.join(row(id).codex_task_dir, "prompt.md"), "utf8");
      assert.match(prompt, /attach_files/); assert.doesNotMatch(prompt, /<lark-media>/);
      const token = prompt.match(/context_token=([A-Za-z0-9_-]{32})/)?.[1]; assert.equal(token?.length, 32);
      return { token: token!, taskDir: row(id).codex_task_dir as string, turnId: row(id).codex_turn_id as string };
    },
    async complete(text: string | null, status = "completed", id = 1) {
      const turnId = row(id).codex_turn_id;
      const notifications = text === null ? [] : [{ method: "item/completed", params: { threadId: "attachment-thread", turnId, item: { id: "answer", type: "agentMessage", phase: "final_answer", text } } }];
      await codexAppServer.request("fixture/emit", { notifications: [...notifications, { method: "turn/completed", params: { threadId: "attachment-thread", turn: { id: turnId, status } } }] });
      await until(() => !["running", "queued"].includes(row(id).codex_status));
    },
    async close() {
      await client.close(); await runtime.app.close(); runtime.stop(); await immediate();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCodex === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldCodex;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("MCP stages documents and image groups without sending, then waits for final text and marks actual delivery", async () => {
  const f = await fixture();
  try {
    const current = await f.start(); const output = path.join(current.taskDir, "output");
    fs.writeFileSync(path.join(output, "report.csv"), "id,value\n1,original\n");
    for (const name of ["first.png", "second.png"]) fs.writeFileSync(path.join(output, name), Buffer.from(png, "base64"));
    const files = [{ path: "report.csv", name: "视频链接.csv" }, { path: "first.png" }, { path: "second.png" }];
    for (let i = 0; i < 2; i++) {
      const staged = await f.client.callTool({ name: "attach_files", arguments: { context_token: current.token, files } });
      assert.equal(staged.isError, false);
      const body = JSON.parse((staged.content as Array<{ text: string }>)[0].text);
      assert.equal(body.status, "staged"); assert.equal(body.sent, false); assert.equal(body.files.length, 3);
    }
    assert.equal(f.mediaCalls().length, 0);
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox").get() as { n: number }).n, 0);
    const route = "/v1/internal/attachments/register", payload = { contextToken: current.token, input: { files } };
    for (const headers of [{}, { authorization: "Bearer wrong" }]) assert.equal((await f.runtime.app.inject({ method: "POST", url: route, headers, payload })).statusCode, 403);
    assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: "z".repeat(32), files } })).isError, true);
    assert.equal((await f.runtime.app.inject({ method: "POST", url: route, headers: { authorization: "Bearer fixture-secret" }, remoteAddress: "203.0.113.4", payload })).statusCode, 403);
    fs.writeFileSync(path.join(output, "report.csv"), "modified after registration");
    f.failText(true); await f.complete("文件已准备。");
    assert.equal(f.row().codex_status, "answered"); assert.equal(f.row().reply_status, "pending");
    assert.equal(f.mediaCalls().length, 0); assert.deepEqual(f.reactions, []);
    const media = () => f.runtime.store.db.prepare("SELECT * FROM lark_delivery_outbox WHERE kind IN ('media','image-post') ORDER BY id").all() as Array<{ kind: string; payload: string; status: string; attempts: number }>;
    assert.deepEqual(media().map(r => r.kind), ["image-post", "media"]);
    f.due(); retryPendingLarkMediaReplies(); assert.equal(f.mediaCalls().length, 0); assert(media().every(row => row.attempts === 0));
    f.failText(false); retryPendingLarkTextReplies(); f.due(); retryPendingLarkMediaReplies(); f.due(); retryPendingLarkCompletionReactions();
    assert.equal(f.mediaCalls().length, 2); assert(media().every(row => row.status === "sent"));
    const file = JSON.parse(media().find(row => row.kind === "media")!.payload);
    assert.equal(path.basename(file.paths[0]), "视频链接.csv");
    assert.equal(fs.readFileSync(path.join(file.taskDir, file.paths[0]), "utf8"), "id,value\n1,original\n");
    assert.equal(f.calls().filter(a => a[1] === "images" && a[2] === "create").length, 2);
    assert.deepEqual(f.reactions, ["om_1:DONE"]);
    f.due(); retryPendingLarkMediaReplies(); retryPendingLarkCompletionReactions(); assert.equal(f.mediaCalls().length, 2);
  } finally { await f.close(); }
});

test("attachment-only replies work, while intentional silence and failed turns discard staged delivery", async () => {
  for (const outcome of ["only-file", "silent", "failed"]) {
    const f = await fixture();
    try {
      const current = await f.start(); fs.writeFileSync(path.join(current.taskDir, "output", "report.md"), "fixture markdown");
      assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: current.token, files: [{ path: "report.md" }] } })).isError, false);
      await f.complete(outcome === "silent" ? "<lark-no-reply/>" : null, outcome === "failed" ? "interrupted" : "completed");
      assert.equal(f.mediaCalls().length, outcome === "only-file" ? 1 : 0);
      assert.equal(f.row().codex_status, outcome === "only-file" ? "answered" : outcome === "silent" ? "no_reply" : "failed");
      if (outcome === "only-file") assert.equal(f.row().reply_status, "sent");
      assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: current.token, files: [] } })).isError, true);
    } finally { await f.close(); }
  }
});

test("bot-only installs use a private process token without opening host capabilities", async () => {
  const f = await fixture(false);
  try {
    const current = await f.start(); fs.writeFileSync(path.join(current.taskDir, "output", "report.csv"), "fixture");
    assert.equal((await f.runtime.app.inject({ method: "POST", url: "/v1/internal/attachments/register", payload: { contextToken: current.token, input: { files: [] } } })).statusCode, 403);
    assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: current.token, files: [{ path: "report.csv" }] } })).isError, false);
    assert.equal((await f.runtime.app.inject({ method: "POST", url: "/v1/capabilities/register", headers: { authorization: `Bearer ${config.larkAgentRuntimeToken}` }, payload: { capabilities: [] } })).statusCode, 401);
    await f.complete(null); assert.equal(f.mediaCalls().length, 1);
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE '%token%'").get() as { n: number }).n, 0);
  } finally { await f.close(); }
});

test("a steered message cannot redirect an earlier message's registered attachments", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); fs.writeFileSync(path.join(first.taskDir, "output", "report.csv"), "fixture");
    assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: first.token, files: [{ path: "report.csv" }] } })).isError, false);
    const second = await f.start(2); assert.equal(second.turnId, first.turnId);
    await until(() => fs.readFileSync(path.join(second.taskDir, "codex.stdout.jsonl"), "utf8").includes('"type":"userMessage"'));
    assert.equal((await f.client.callTool({ name: "attach_files", arguments: { context_token: first.token, files: [] } })).isError, true);
    await f.complete("补充问题已处理。", "completed", 2);
    const sentFile = f.mediaCalls().find(a => a.includes("--file")); assert(sentFile);
    assert.equal(sentFile[sentFile.indexOf("--message-id") + 1], "om_1");
    assert.equal(f.texts.at(-1)?.id, "om_2");
    assert.deepEqual(f.reactions.sort(), ["om_1:DONE", "om_2:DONE"]);
  } finally { await f.close(); }
});

test("malformed legacy declarations report failure instead of leaking tags or marking completion", async () => {
  const f = await fixture();
  try {
    await f.start(); await f.complete('已导出。<lark-media>{"files":[{"path":"report.csv"}]}</lark_media');
    assert.equal(f.row().codex_status, "failed"); assert.match(f.texts.at(-1)!.text, /附件校验失败/);
    assert.doesNotMatch(f.texts.at(-1)!.text, /lark-media|lark_media/); assert.deepEqual(f.reactions, []);
  } finally { await f.close(); }
});

test("terminal media failures emit one durable failure notice and never a completion reaction", async () => {
  const f = await fixture();
  try {
    const current = await f.start(); fs.writeFileSync(path.join(current.taskDir, "output", "report.csv"), "fixture");
    await f.client.callTool({ name: "attach_files", arguments: { context_token: current.token, files: [{ path: "report.csv" }] } });
    f.failMedia(); await f.complete("文件已准备。");
    for (let i = 1; i < 8; i++) { f.due(); retryPendingLarkMediaReplies(); }
    const row = f.runtime.store.db.prepare("SELECT status,attempts FROM lark_delivery_outbox WHERE kind='media'").get() as { status: string; attempts: number };
    assert.deepEqual(row, { status: "failed", attempts: 8 });
    f.failText(true); retryPendingLarkTextReplies();
    assert.equal((f.runtime.store.db.prepare("SELECT status FROM lark_delivery_outbox WHERE kind='media-notice'").get() as { status: string }).status, "pending");
    f.failText(false); f.due(); retryPendingLarkTextReplies(); retryPendingLarkTextReplies(); retryPendingLarkCompletionReactions();
    assert.equal(f.texts.filter(message => message.text.includes("未能送达")).length, 1);
    assert.equal(f.texts.filter(message => message.text.includes("未能送达"))[0].id, "om_1");
    assert.deepEqual(f.reactions, []);
  } finally { await f.close(); }
});
