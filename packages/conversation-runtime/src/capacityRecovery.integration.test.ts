import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { codexAppServer } from "./codexRuntime.js";
import { parseLarkExecutionConfigs } from "./executionConfig.js";
import { configureTurnApprovalReviewer } from "./turnAutoApproval.js";
import { decideLarkExecutionApproval, enqueueLarkCodexReply, stopLarkCodexResponder } from "./responder.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert(performance.now() < deadline, "fixture did not reach the expected state");
    await immediate();
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-capacity-recovery-"));
  const executable = path.join(root, "codex.mjs");
  const log = path.join(root, "rpc.jsonl");
  const threadId = path.basename(root);
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const send = x => process.stdout.write(JSON.stringify(x) + "\\n");
const counter = ${JSON.stringify(path.join(root, "turn-counter"))};
let turn = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
readline.createInterface({input: process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (m.method === "thread/start" || m.method === "thread/resume") send({id: m.id, result: {thread: {id: ${JSON.stringify(threadId)}}}});
  else if (m.method === "thread/loaded/list") send({id:m.id,result:{data:[${JSON.stringify(threadId)}],nextCursor:null}});
  else if (m.method === "thread/list") send({id:m.id,result:{data:m.params.archived?[]:[{id:${JSON.stringify(threadId)}}],nextCursor:null}});
  else if (m.method === "turn/start") { fs.writeFileSync(counter, String(++turn)); send({id: m.id, result: {turn: {id: "turn-" + turn, status: "inProgress"}}}); }
  else if (m.method === "turn/steer") {
    send({id: m.id, result: {}});
    send({method: "item/completed", params: {turnId: m.params.expectedTurnId, item: {type: "userMessage", clientId: m.params.clientUserMessageId}}});
  } else if (m.method === "fixture/emit") {
    send({id: m.id, result: {}});
    for (const n of m.params.notifications) send(n);
  } else if (m.method) send({id: m.id, result: {}});
});
`);
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(root, "lark-cli"), `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,data:{message_id:"om_card_fixture"}}));\n`);
  fs.chmodSync(path.join(root, "lark-cli"), 0o755);
  const previousCodex = process.env.CODEX_EXECUTABLE;
  const previousPath = process.env.PATH;
  process.env.CODEX_EXECUTABLE = executable;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const delivered: string[] = [];
  configureConversationRuntime({ database: store.db, mode: "active", repoRoot: root, workspaceRoot: root,
    larkStickerDirectory: path.join(root, "stickers"), approverId: "ou_owner", model: "gpt-6.1-sol",
    textReplySender: (_messageId, text) => { delivered.push(text); return {ok: true, messageId: `om_sent_${delivered.length}`, chatId: "oc_fixture", messageAt: null, messageType: "text"}; }
  });
  for (const [key, value] of Object.entries({stickerUsageMode: "off", executionReceiptsEnabled: "false", interimRepliesEnabled: "false"})) setAppSettingValue(key, value);
  const add = (id: number, content = "唯一原始请求：核对发布版本") => {
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,message_at,raw_json,received_at,created_at)
      VALUES (?,?,'oc_fixture','p2p','ou_sender','user','text',?,1,'p2p','pending',?,'{}',?,?)`).run(id, `om_${id}`, content, now, now, now);
    assert.equal(enqueueLarkCodexReply(id), true);
  };
  const row = (id = 1) => store.db.prepare("SELECT codex_status,codex_turn_id,codex_task_dir FROM lark_messages WHERE id=?").get(id) as {codex_status: string; codex_turn_id: string; codex_task_dir: string};
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const emit = (notifications: unknown[]) => codexAppServer.request("fixture/emit", {notifications});
  const fail = (code = "serverOverloaded") => emit([
    {method: "error", params: {threadId, turnId: row().codex_turn_id, error: {message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: code}, willRetry: false}},
    {method: "turn/completed", params: {threadId, turn: {id: row().codex_turn_id, status: "failed", error: {message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: code}}}}
  ]);
  const waiting = () => {
    const dir = row().codex_task_dir;
    return dir && fs.readFileSync(path.join(dir, "codex.stdout.jsonl"), "utf8").split("\n").filter(line => line.includes('"status":"waiting"')).length;
  };
  const approval = (id: string, command = "git push origin task") => emit([{id, method: "item/commandExecution/requestApproval", params: {threadId, turnId: row().codex_turn_id, itemId: id, command, cwd: root, reason: "fixture approval"}}]);
  return {store, root, delivered, add, row, records, emit, fail, waiting, approval,
    async ready() { add(1); await until(() => row().codex_turn_id === "turn-1"); },
    async complete(turnId = row().codex_turn_id) {
      await emit([
        {method: "item/completed", params: {threadId, turnId, item: {id: "final", type: "agentMessage", phase: "final_answer", text: "已核对完成。"}}},
        {method: "turn/completed", params: {threadId, turn: {id: turnId, status: "completed"}}}
      ]);
      await until(() => row().codex_status === "answered");
    },
    async close() {
      stopLarkCodexResponder();
      await immediate();
      store.close();
      if (previousCodex === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousCodex;
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      fs.rmSync(root, {recursive: true, force: true});
    }
  };
}

test("capacity failure resumes the same thread with compact input, pinned model and a fresh approval scope", async t => {
  const f = fixture();
  try {
    await f.ready();
    await f.approval("approval-old");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE status='pending'").get()));
    const old = f.store.db.prepare("SELECT token FROM lark_execution_approvals WHERE status='pending'").get() as {token: string};
    assert.equal(decideLarkExecutionApproval(old.token, "approve-turn").ok, true);
    t.mock.timers.enable({apis: ["setTimeout"]});
    await f.fail(); await until(() => f.waiting() === 1);
    setAppSettingValue("codexModel", "different-model");
    setAppSettingValue("codexReasoningEffort", "high");
    t.mock.timers.tick(36_001);
    await until(() => f.row().codex_turn_id === "turn-2");
    const turns = f.records().filter(r => r.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.equal(turns[0].params.threadId, turns[1].params.threadId);
    assert.equal(turns[1].params.model, "gpt-6.1-sol");
    assert.equal(turns[1].params.effort, turns[0].params.effort);
    assert.equal(turns[1].params.approvalPolicy, "on-request");
    const snapshots = parseLarkExecutionConfigs(fs.readFileSync(path.join(f.row().codex_task_dir, "execution-configs.jsonl"), "utf8"));
    assert.deepEqual(snapshots.map(item => item.turnId), ["turn-1", "turn-2"]);
    assert.equal(snapshots[1].model, snapshots[0].model);
    assert.equal(snapshots[1].reasoningEffort, snapshots[0].reasoningEffort);
    const input = JSON.stringify(turns[1].params.input);
    assert(input.length < 400);
    assert.match(input, /时间\(\+08:00\)/);
    assert.doesNotMatch(input, /唯一原始请求|群聊上下文|权限范围/);
    await f.approval("approval-new");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get()));
    assert.equal(f.records().some(r => r.id === "approval-new" && r.result?.decision === "accept"), false);
    const next = f.store.db.prepare("SELECT token FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get() as {token: string};
    assert.equal(decideLarkExecutionApproval(next.token, "approve-turn").ok, true);
    await f.complete();
    assert.deepEqual(f.delivered, ["已核对完成。"]);
    assert.match(fs.readFileSync(path.join(f.row().codex_task_dir, "codex.stderr.log"), "utf8"), /Selected model is at capacity/);
  } finally { await f.close(); }
});

test("authentication recovery retains turn snapshots and requires a fresh turn approval", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.approval("auth-old");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE status='pending'").get()));
    const old = f.store.db.prepare("SELECT token FROM lark_execution_approvals WHERE status='pending'").get() as {token: string};
    assert.equal(decideLarkExecutionApproval(old.token, "approve-turn").ok, true);
    setAppSettingValue("codexModel", "after-auth-model");
    setAppSettingValue("codexReasoningEffort", "high");
    await f.emit([{method: "turn/completed", params: {turn: {id: "turn-1", status: "failed", error: {message: "HTTP 401 token_invalidated", codexErrorInfo: "Unauthorized"}}}}]);
    await until(() => f.row().codex_turn_id === "turn-2");
    const snapshots = parseLarkExecutionConfigs(fs.readFileSync(path.join(f.row().codex_task_dir, "execution-configs.jsonl"), "utf8"));
    assert.deepEqual(snapshots.map(item => item.turnId), ["turn-1", "turn-2"]);
    assert.deepEqual(snapshots.map(item => item.model), ["gpt-6.1-sol", "after-auth-model"]);
    assert.equal(snapshots[1].reasoningEffort, "high");
    assert.equal(snapshots[1].sandbox, "read-only");
    await f.approval("auth-new");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get()));
    assert.equal(f.records().some(r => r.id === "auth-new" && r.result?.decision === "accept"), false);
    const next = f.store.db.prepare("SELECT token FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get() as {token: string};
    assert.equal(decideLarkExecutionApproval(next.token, "approve-turn").ok, true);
    await f.complete();
  } finally { await f.close(); }
});

test("authentication failures do not replay turns with tool activity or pending approval", async () => {
  for (const state of ["tool", "approval"] as const) {
    const f = fixture();
    try {
      await f.ready();
      if (state === "tool") {
        await f.emit([{method: "item/started", params: {turnId: "turn-1", item: {id: "write", type: "commandExecution"}}}]);
      } else {
        await f.approval("auth-pending");
        await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE status='pending'").get()));
      }
      await f.emit([{method: "turn/completed", params: {turn: {id: "turn-1", status: "failed", error: {message: "HTTP 401 token_invalidated", codexErrorInfo: "Unauthorized"}}}}]);
      await until(() => f.row().codex_status === "failed");
      assert.equal(f.records().filter(r => r.method === "turn/start").length, 1, state);
    } finally { await f.close(); }
  }
});

test("an interrupted automatic approval cannot grant or create cards for a recovered turn", async () => {
  const f = fixture();
  let release = () => {};
  configureTurnApprovalReviewer(() => new Promise(resolve => { release = () => resolve({decision: "approve_turn", reason: "fixture approved"}); }));
  try {
    await f.ready();
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    await f.approval("review-old", "kubectl get pods");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_turn_auto_reviews WHERE decision='reviewing'").get()));
    await f.emit([{method: "turn/completed", params: {turn: {id: "turn-1", status: "failed", error: {message: "HTTP 401 token_invalidated", codexErrorInfo: "Unauthorized"}}}}]);
    await until(() => f.row().codex_turn_id === "turn-2");
    release();
    await immediate();
    assert.equal(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals").get(), undefined);
    assert.equal(f.records().some(r => r.id === "review-old" && r.result?.decision === "accept"), false);
    setAppSettingValue("turnAutoApprovalEnabled", "false");
    await f.approval("review-new");
    await until(() => Boolean(f.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get()));
    assert.equal(f.records().some(r => r.id === "review-new" && r.result?.decision === "accept"), false);
    const next = f.store.db.prepare("SELECT token FROM lark_execution_approvals WHERE turn_id='turn-2' AND status='pending'").get() as {token: string};
    assert.equal(decideLarkExecutionApproval(next.token, "approve-turn").ok, true);
    await f.complete();
  } finally { release(); configureTurnApprovalReviewer(); await f.close(); }
});

test("capacity recovery stops after three retries and leaves the failure visible", async t => {
  const f = fixture();
  try {
    await f.ready(); t.mock.timers.enable({apis: ["setTimeout"]});
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.fail(); await until(() => f.waiting() === attempt);
      t.mock.timers.tick(144_001);
      await until(() => f.row().codex_turn_id === `turn-${attempt + 1}`);
    }
    await f.fail(); await until(() => f.row().codex_status === "failed");
    t.mock.timers.tick(1_000_000); await immediate();
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 4);
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0], /执行失败/);
    assert.doesNotMatch(f.delivered[0], /Selected model is at capacity/);
  } finally { await f.close(); }
});

test("new messages wait for capacity recovery instead of steering the failed turn", async t => {
  const f = fixture();
  try {
    await f.ready(); t.mock.timers.enable({apis: ["setTimeout"]});
    await f.fail(); await until(() => f.waiting() === 1);
    f.add(2, "补充最新条件"); await immediate();
    assert.equal(f.records().some(r => r.method === "turn/steer"), false);
    t.mock.timers.tick(36_001);
    await until(() => f.records().some(r => r.method === "turn/steer"));
    const steer = f.records().find(r => r.method === "turn/steer");
    assert.equal(steer.params.expectedTurnId, "turn-2");
    assert.match(JSON.stringify(steer.params.input), /补充最新条件/);
    assert.match(JSON.stringify(steer.params.input), /时间\(\+08:00\)/);
    await until(() => f.row(2).codex_turn_id === "turn-2");
    await f.complete();
  } finally { await f.close(); }
});

test("capacity recovery does not replay a turn after a tool has started", async () => {
  const f = fixture();
  try {
    await f.ready();
    await f.emit([{method: "item/started", params: {turnId: "turn-1", item: {id: "fixture-tool", type: "commandExecution"}}}]);
    await f.fail(); await until(() => f.row().codex_status === "failed");
    assert.equal(f.waiting(), 0);
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("quota errors are not treated as transient model capacity failures", async () => {
  const f = fixture();
  try {
    await f.ready(); await f.fail("UsageLimitExceeded"); await until(() => f.row().codex_status === "failed");
    assert.equal(f.waiting(), 0);
  } finally { await f.close(); }
});

test("shutdown cancels a pending capacity retry", async t => {
  const f = fixture();
  try {
    await f.ready(); t.mock.timers.enable({apis: ["setTimeout"]});
    await f.fail(); await until(() => f.waiting() === 1);
    stopLarkCodexResponder(); t.mock.timers.tick(144_001); await immediate();
    assert.equal(f.row().codex_status, "failed");
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
  } finally { await f.close(); }
});
