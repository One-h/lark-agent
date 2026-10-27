import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { enqueueLarkCodexReply, parseLarkExecutionConfigs } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { createRuntime } from "./index.js";

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert(performance.now() < deadline, "native fixture timed out");
    await immediate();
  }
}

test("settings reach native thread and turn parameters, rebind old sessions and preserve all message history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-native-settings-"));
  const workspaceA = path.join(root, "workspace-a"); const workspaceB = path.join(root, "workspace-b");
  fs.mkdirSync(workspaceA); fs.mkdirSync(workspaceB);
  const log = path.join(root, "rpc.jsonl"); const executable = path.join(root, "codex.mjs");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const send = x => process.stdout.write(JSON.stringify(x) + "\\n");
let thread = 0; let turn = 0; let currentThread = "";
readline.createInterface({input: process.stdin}).on("line", line => {
  const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (m.method === "thread/start") { currentThread = "settings-thread-" + (++thread); send({id:m.id,result:{thread:{id:currentThread}}}); }
  else if (m.method === "thread/resume") { currentThread=m.params.threadId; send({id:m.id,result:{thread:{id:currentThread}}}); }
  else if (m.method === "thread/loaded/list") send({id:m.id,result:{data:currentThread?[currentThread]:[],nextCursor:null}});
  else if (m.method === "turn/start") send({id:m.id,result:{turn:{id:"settings-turn-" + (++turn),status:"inProgress"}}});
  else if (m.method === "fixture/complete") {
    send({id:m.id,result:{}});
    const turnId="settings-turn-" + turn;
    send({method:"item/completed",params:{threadId:currentThread,turnId,item:{id:"answer-"+turn,type:"agentMessage",phase:"final_answer",text:"<lark-no-reply/>"}}});
    send({method:"turn/completed",params:{threadId:currentThread,turn:{id:turnId,status:"completed"}}});
  } else if (m.method) send({id:m.id,result:{}});
});
`);
  fs.chmodSync(executable, 0o755);
  const oldExecutable = process.env.CODEX_EXECUTABLE; process.env.CODEX_EXECUTABLE = executable;
  const runtime = createRuntime({databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: workspaceA, trustedSenderIds: ["ou_sender"], reactionSender: () => ({ok: true})});
  const row = (id: number) => runtime.store.db.prepare("SELECT codex_status,codex_turn_id,codex_session_id,codex_task_dir FROM lark_messages WHERE id=?").get(id) as {codex_status: string; codex_turn_id: string; codex_session_id: string; codex_task_dir: string};
  const records = () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const start = async (id: number, expectedTurn = id) => {
    const now = new Date().toISOString();
    runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES (?,?,'oc_same','p2p','ou_sender','user','text','fixture request',1,'pending','failed','{}',?,?)`).run(id, `om_${id}`, now, now);
    assert.equal(enqueueLarkCodexReply(id), true);
    await until(() => row(id).codex_turn_id === `settings-turn-${expectedTurn}`);
  };
  const snapshots = (id: number) => parseLarkExecutionConfigs(fs.readFileSync(path.join(row(id).codex_task_dir, "execution-configs.jsonl"), "utf8"));
  const complete = async (id: number) => {
    await codexAppServer.request("fixture/complete", {});
    await until(() => row(id).codex_status === "no_reply");
  };
  try {
    await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedExecutionEnabled: true, stickerUsageMode: "off", executionReceiptsEnabled: false, codexModel: "model-a", reasoningEffort: "high"}});
    await start(1);
    let calls = records();
    assert.equal(calls.find(r => r.method === "thread/start").params.sandbox, "danger-full-access");
    assert.equal(calls.find(r => r.method === "turn/start").params.cwd, workspaceA);
    assert.equal(snapshots(1)[0].model, "model-a");
    assert.equal(snapshots(1)[0].reasoningEffort, "high");
    assert.equal(snapshots(1)[0].sandbox, "danger-full-access");
    const busy = await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {workspaceRoot: workspaceB, trustedExecutionEnabled: false}});
    assert.equal(busy.statusCode, 409);
    await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {codexModel: "model-b", reasoningEffort: "low"}});
    await runtime.app.inject({method: "PUT", url: "/v1/chats/oc_same/persona", payload: {mode: "custom", name: "新版人设", instructions: "new persona"}});
    await start(2, 1);
    await until(() => fs.existsSync(path.join(row(2).codex_task_dir, "execution-configs.jsonl")));
    assert.equal(snapshots(2)[0].action, "turn/steer");
    assert.equal(snapshots(2)[0].model, "model-a");
    assert.equal(snapshots(2)[0].reasoningEffort, "high");
    assert.equal(snapshots(2)[0].persona.mode, "default");
    const detail = (await runtime.app.inject({method: "GET", url: "/v1/messages/2"})).json();
    assert.deepEqual(detail.executionConfigs, snapshots(2));
    await complete(1);
    runtime.store.db.prepare("DELETE FROM settings WHERE key LIKE 'codex.threadWorkspace:%'").run();
    const saved = await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {workspaceRoot: workspaceB}});
    assert.equal(saved.statusCode, 200, saved.body);
    await start(3, 2);
    calls = records();
    const resumed = calls.filter(r => r.method === "thread/resume").at(-1);
    assert.equal(resumed.params.threadId, row(1).codex_session_id);
    assert.equal(resumed.params.cwd, workspaceB);
    assert.equal(row(1).codex_session_id, row(3).codex_session_id);
    assert.equal(snapshots(3)[0].model, "model-b");
    assert.equal(snapshots(3)[0].reasoningEffort, "low");
    assert.equal(snapshots(3)[0].persona.name, "新版人设");
    const secondTurn = calls.filter(r => r.method === "turn/start")[1];
    assert.equal(secondTurn.params.cwd, workspaceB);
    assert(JSON.stringify(secondTurn.params.input).includes(path.join(workspaceB, "AGENTS.md")));
    const artifact = JSON.parse(fs.readFileSync(path.join(row(3).codex_task_dir, "resume-session.json"), "utf8"));
    assert.equal(artifact.workspaceRoot, workspaceB);
    assert.equal(artifact.promptMode, "full");
    await complete(3);
    assert.equal((await runtime.app.inject({method: "PATCH", url: "/v1/settings", payload: {trustedExecutionEnabled: false}})).statusCode, 200);
    await start(4, 3);
    calls = records();
    assert.notEqual(row(4).codex_session_id, row(3).codex_session_id);
    const untrusted = calls.filter(r => r.method === "thread/start").at(-1);
    assert.equal(untrusted.params.sandbox, "read-only");
    assert.equal(untrusted.params.approvalPolicy, "on-request");
    assert.equal(calls.filter(r => r.method === "turn/start").at(-1).params.cwd, workspaceB);
    assert.equal(snapshots(4)[0].sandbox, "read-only");
    await complete(4);
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS n FROM lark_messages").get() as {n: number}).n, 4);
  } finally {
    await runtime.app.close(); runtime.stop(); await immediate();
    if (oldExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldExecutable;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
