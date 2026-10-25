import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { codexAppServer } from "./codexRuntime.js";
import { enqueueLarkCodexReply, reconcileLarkCodexStartupWaits, retryPendingLarkTextReplies, stopLarkCodexResponder } from "./responder.js";
import { ingestLarkEvent } from "./worker.js";
import { retryPendingLarkCompletionReactions } from "./completionReactions.js";

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { assert(performance.now() < deadline, "fixture did not reach expected state"); await immediate(); }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-startup-state-"));
  const turnId = (n: number) => `${path.basename(root)}-turn-${n}`;
  const executable = path.join(root, "codex.mjs"), log = path.join(root, "rpc.jsonl"), statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({threadStatus: "active", status: "inProgress"}));
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const send = x => process.stdout.write(JSON.stringify(x)+"\\n");
const counter=${JSON.stringify(path.join(root, "counter"))};
let turn=fs.existsSync(counter)?Number(fs.readFileSync(counter,"utf8")):0;
let held=null;
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line), s=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8"));
 fs.appendFileSync(${JSON.stringify(log)},line+"\\n");
 if(m.method==="thread/start"||m.method==="thread/resume") send({id:m.id,result:{thread:{id:"thread-fixture"}}});
 else if(m.method==="turn/start") {if(s.startError)send({id:m.id,error:{code:-1,message:"fixture startup error /private/path token=fixture-secret"}});else{fs.writeFileSync(counter,String(++turn));send({id:m.id,result:{turn:{id:${JSON.stringify(path.basename(root) + "-turn-")}+turn,status:"inProgress"}}});}}
 else if(m.method==="thread/read") {const result={thread:{id:"thread-fixture",status:{type:s.threadStatus}}};if(s.readError)send({id:m.id,error:{code:-1,message:"fixture read failure"}});else if(s.defer)held={id:m.id,result};else send({id:m.id,result});}
 else if(m.method==="thread/turns/list") send({id:m.id,result:{data:s.missing?[]:[{id:s.turnId??${JSON.stringify(path.basename(root) + "-turn-")}+turn,status:s.status,error:s.error,items:s.items??[]}]}});
 else if(m.method==="fixture/release") {if(held)send(held);held=null;send({id:m.id,result:{}});}
 else if(m.method==="fixture/emit") {send({id:m.id,result:{}});for(const n of m.params.notifications)send(n);}
 else if(m.method==="fixture/crash") {send({id:m.id,result:{}});setImmediate(()=>process.exit(23));}
 else if(m.method) send({id:m.id,result:{}});
});`);
  fs.chmodSync(executable, 0o755);
  const cli = path.join(root, "lark-cli");
  fs.writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,data:{messages:[]}}));\n`);
  fs.chmodSync(cli, 0o755);
  const previous = process.env.CODEX_EXECUTABLE;
  const previousPath = process.env.PATH;
  process.env.CODEX_EXECUTABLE = executable;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const delivered: string[] = [], attempts: Array<{text: string; key: string}> = [], reactions: Array<{messageId: string; emoji: string}> = [];
  let failDelivery = false;
  configureConversationRuntime({database: store.db, mode: "active", repoRoot: root, workspaceRoot: root, larkStickerDirectory: path.join(root, "stickers"),
    reactionSender: (messageId, emoji) => { reactions.push({messageId, emoji}); return {ok: true}; }, textReplySender: (_id, text, key) => {
      attempts.push({text, key});
      if (failDelivery) return {ok: false, error: "fixture transport failure"};
      delivered.push(text); return {ok: true, messageId: `om_out_${delivered.length}`, chatId: "oc_fixture", messageAt: null, messageType: "text"};
    }});
  for (const [key, value] of Object.entries({stickerUsageMode: "off", executionReceiptsEnabled: "false", interimRepliesEnabled: "false"})) setAppSettingValue(key, value);
  const row = () => store.db.prepare("SELECT * FROM lark_messages WHERE id=1").get() as any;
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const state = (value: unknown) => fs.writeFileSync(statePath, JSON.stringify(value));
  const emit = (notifications: unknown[]) => codexAppServer.request("fixture/emit", {notifications});
  const message = {event_id: "event-fixture", message_id: "om_1", chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_sender", sender_type: "user", message_type: "text", content: "fixture request"};
  return {root, store, delivered, attempts, reactions, row, records, state, emit, message, turnId,
    failDelivery(value: boolean) { failDelivery = value; },
    async ready(startError = false) {
      if (startError) state({startError: true});
      const now = new Date().toISOString();
      store.db.prepare("INSERT INTO lark_messages(id,event_id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,message_at,raw_json,received_at,created_at) VALUES(1,'event-fixture','om_1','oc_fixture','p2p','ou_sender','user','text','fixture request',1,'p2p','pending',?,'{}',?,?)").run(now, now, now);
      assert.equal(enqueueLarkCodexReply(1), true);
      await until(() => startError ? row().codex_status === "failed" : Boolean(row().codex_turn_id));
    },
    check(offset = 60_001) { return reconcileLarkCodexStartupWaits(Date.now() + offset); },
    async complete(turnId = row().codex_turn_id) {
      await emit([{method: "item/completed", params: {threadId: "thread-fixture", turnId, item: {id: "answer", type: "agentMessage", phase: "final_answer", text: "fixture done"}}},
        {method: "turn/completed", params: {threadId: "thread-fixture", turn: {id: turnId, status: "completed"}}}]);
      await until(() => row().codex_status === "answered");
    },
    async close() { stopLarkCodexResponder(); await immediate(); store.close(); if (previous === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previous; if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; fs.rmSync(root, {recursive: true, force: true}); }
  };
}

test("quiet active native turn survives startup threshold, throttles probes and later replies normally", async () => {
  const f = fixture(); try {
    await f.ready(); assert.equal(await f.check(), 1); assert.equal(await f.check(), 0);
    assert.equal(f.row().codex_status, "running"); assert.deepEqual(f.delivered, []);
    assert.equal(await f.check(120_100), 1);
    assert.equal(f.records().filter(r => r.method === "thread/read").length, 2);
    assert.equal(f.records().some(r => r.method === "turn/interrupt"), false);
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
    await f.complete(); assert.deepEqual(f.delivered, ["fixture done"]);
    assert.deepEqual(f.reactions, [{messageId: "om_1", emoji: "DONE"}]);
  } finally { await f.close(); }
});

test("confirmed native failure or interruption sends one safe notification despite late terminal events", async () => {
  for (const status of ["failed", "interrupted"]) {
    const f = fixture(); try {
      await f.ready(); f.state({threadStatus: "idle", status, error: {message: "secret /private/path token=fixture-secret"}});
      await f.check(); assert.equal(f.row().codex_status, "failed"); assert.equal(f.row().reply_status, "sent");
      assert.equal(f.delivered.length, 1); assert.match(f.delivered[0], /执行失败|执行已中断/);
      assert.deepEqual(f.reactions, []);
      assert.doesNotMatch(f.delivered[0], /private|fixture-secret|token=/);
      await f.emit([{method: "turn/completed", params: {turn: {id: f.turnId(1), status: "failed"}}}]);
      await f.check(120_100); assert.equal(f.delivered.length, 1);
    } finally { await f.close(); }
  }
});

test("final answer output alone is not completion; failed final text delays DONE until delivery retries", async () => {
  const f = fixture(); try {
    await f.ready(); f.failDelivery(true);
    await f.emit([{method: "item/completed", params: {turnId: f.turnId(1), item: {id: "answer", type: "agentMessage", phase: "final_answer", text: "fixture done"}}}]);
    assert.deepEqual(f.reactions, []); assert.equal(f.row().codex_status, "running");
    await f.complete(); assert.deepEqual(f.reactions, []); assert.equal(f.row().reply_status, "pending");
    f.failDelivery(false); f.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE id=1").run();
    retryPendingLarkTextReplies(); f.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='1970-01-01'").run();
    retryPendingLarkCompletionReactions();
    assert.deepEqual(f.reactions, [{messageId: "om_1", emoji: "DONE"}]);
    await f.complete(); assert.equal(f.reactions.length, 1);
  } finally { await f.close(); }
});

test("native silent completion acknowledges processing without sending a text reply", async () => {
  const f = fixture(); try {
    await f.ready(); await f.emit([{method: "turn/completed", params: {turn: {id: f.turnId(1), status: "completed"}}}]);
    await until(() => f.row().codex_status === "no_reply");
    assert.deepEqual(f.delivered, []); assert.deepEqual(f.reactions, [{messageId: "om_1", emoji: "DONE"}]);
  } finally { await f.close(); }
});

test("one native completion marks all original messages merged through steer", async () => {
  const f = fixture(); try {
    await f.ready();
    const now = new Date().toISOString();
    f.store.db.prepare("INSERT INTO lark_messages(id,event_id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,message_at,raw_json,received_at,created_at) VALUES(2,'event-next','om_2','oc_fixture','p2p','ou_sender','user','text','next request',1,'p2p','pending',?,'{}',?,?)").run(now, now, now);
    assert.equal(enqueueLarkCodexReply(2), true);
    await until(() => f.records().some(r => r.method === "turn/steer"));
    assert.deepEqual(f.reactions, []); await f.complete();
    assert.deepEqual(f.reactions, [{messageId: "om_1", emoji: "DONE"}, {messageId: "om_2", emoji: "DONE"}]);
  } finally { await f.close(); }
});

test("unknown, conflicting and foreign native state never interrupts or replays the task", async () => {
  for (const state of [{readError: true}, {threadStatus: "idle", status: "inProgress"}, {threadStatus: "active", missing: true}, {threadStatus: "active", turnId: "other", status: "failed"}]) {
    const f = fixture(); try {
      await f.ready(); f.state(state); await f.check();
      assert.equal(f.row().codex_status, "running"); assert.deepEqual(f.delivered, []);
      assert.equal(f.records().some(r => r.method === "turn/interrupt"), false);
      assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
    } finally { await f.close(); }
  }
});

test("native completed snapshot restores a missing final notification with optional phase", async () => {
  for (const phase of ["final_answer", undefined]) {
    const f = fixture(); try {
      await f.ready(); f.state({threadStatus: "idle", status: "completed", items: [{id: "restored", type: "agentMessage", phase, text: "recovered done"}]});
      await f.check(); assert.equal(f.row().codex_status, "answered"); assert.deepEqual(f.delivered, ["recovered done"]);
    } finally { await f.close(); }
  }
});

test("native state RPC timeout retains the task instead of treating missing status as failure", async t => {
  const f = fixture(); try {
    await f.ready(); f.state({threadStatus: "active", status: "inProgress", defer: true});
    t.mock.timers.enable({apis: ["setTimeout"]});
    const checking = f.check(); await until(() => f.records().some(r => r.method === "thread/read"));
    t.mock.timers.tick(10_001); await checking;
    assert.equal(f.row().codex_status, "running"); assert.deepEqual(f.delivered, []);
    assert.equal(f.records().some(r => r.method === "turn/interrupt"), false);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("startup probes are single flight and stale snapshots cannot override started work or completed turns", async () => {
  for (const event of ["work", "complete"]) {
    const f = fixture(); try {
      await f.ready(); f.state({threadStatus: "idle", status: "failed", defer: true});
      const checking = f.check(); await until(() => f.records().some(r => r.method === "thread/read"));
      assert.equal(await f.check(120_100), 0);
      if (event === "work") await f.emit([{method: "item/started", params: {turnId: f.turnId(1), item: {id: "reasoning", type: "reasoning"}}}]);
      else await f.complete();
      await codexAppServer.request("fixture/release", {}); await checking;
      assert.equal(f.row().codex_status, event === "work" ? "running" : "answered");
      assert.deepEqual(f.delivered, event === "work" ? [] : ["fixture done"]);
      assert.equal(f.records().filter(r => r.method === "thread/read").length, 1);
    } finally { await f.close(); }
  }
});

test("failure text delivery retries with the same key while execution remains failed", async () => {
  const f = fixture(); try {
    await f.ready(); f.failDelivery(true); f.state({threadStatus: "idle", status: "failed"}); await f.check();
    assert.equal(f.row().codex_status, "failed"); assert.equal(f.row().reply_status, "pending");
    assert.equal(f.attempts.length, 1);
    f.failDelivery(false); f.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at=? WHERE id=1").run("1970-01-01T00:00:00Z");
    assert.equal(retryPendingLarkTextReplies(), 1); assert.equal(f.attempts[0].key, f.attempts[1].key);
    assert.equal(f.row().reply_status, "sent"); assert.equal(f.row().codex_status, "failed"); assert.equal(f.delivered.length, 1);
  } finally { await f.close(); }
});

test("actual native failure, process exit and startup RPC errors notify instead of forwarding old progress", async () => {
  for (const failure of ["event", "process", "startup"]) {
    const f = fixture(); try {
      await f.ready(failure === "startup");
      if (failure === "event") await f.emit([
        {method: "item/completed", params: {turnId: f.turnId(1), item: {id: "progress", type: "agentMessage", phase: "commentary", text: "old progress"}}},
        {method: "turn/completed", params: {turn: {id: f.turnId(1), status: "failed", error: {message: "native secret"}}}}]);
      if (failure === "process") await codexAppServer.request("fixture/crash", {});
      await until(() => f.row().codex_status === "failed");
      assert.equal(f.delivered.length, 1); assert.match(f.delivered[0], /执行失败/); assert.doesNotMatch(f.delivered[0], /old progress|native secret|private|fixture-secret/);
    } finally { await f.close(); }
  }
});

test("duplicate inbound delivery cannot replay failed work, but explicit retry remains available", async () => {
  const f = fixture(); try {
    await f.ready(); f.state({threadStatus: "idle", status: "failed"}); await f.check();
    assert.equal(ingestLarkEvent(f.message).duplicate, true); await immediate(); await immediate();
    assert.equal(f.row().codex_status, "failed"); assert.equal(f.records().filter(r => r.method === "turn/start").length, 1); assert.equal(f.delivered.length, 1);
    assert.equal(enqueueLarkCodexReply(1), true); await until(() => f.row().codex_turn_id === f.turnId(2)); await f.complete();
    assert.equal(f.delivered.length, 2);
  } finally { await f.close(); }
});

test("authentication recovery resets startup tracking for its replacement turn", async () => {
  const f = fixture(); try {
    await f.ready(); await f.emit([{method: "item/started", params: {turnId: f.turnId(1), item: {id: "reasoning", type: "reasoning"}}},
      {method: "turn/completed", params: {turn: {id: f.turnId(1), status: "failed", error: {message: "HTTP 401 token_invalidated"}}}}]);
    await until(() => f.row().codex_turn_id === f.turnId(2)); assert.equal(await f.check(), 1);
    assert.equal(f.row().codex_status, "running"); assert.equal(f.records().filter(r => r.method === "thread/read").length, 1);
    await f.complete();
  } finally { await f.close(); }
});

test("native capacity error readback retains recovery without replaying recovered tool activity", async t => {
  for (const hadTool of [false, true]) {
    const f = fixture(); try {
      await f.ready(); t.mock.timers.enable({apis: ["setTimeout"]});
      f.state({threadStatus: "idle", status: "failed", error: {message: "opaque upstream failure", codexErrorInfo: "serverOverloaded"},
        items: hadTool ? [{id: "write", type: "commandExecution", status: "completed", exitCode: 0}] : []});
      await f.check();
      if (hadTool) {
        assert.equal(f.row().codex_status, "failed"); assert.equal(f.delivered.length, 1);
        assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
      } else {
        assert.equal(f.row().codex_status, "running"); assert.deepEqual(f.delivered, []);
        t.mock.timers.tick(36_001); await until(() => f.row().codex_turn_id === f.turnId(2));
        await f.complete();
      }
    } finally { t.mock.timers.reset(); await f.close(); }
  }
});
