import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { config, configureConversationRuntime, setAppSettingValue } from "./context.js";
import { drainLarkProgressCards } from "./progressCards.js";
import type { LarkProgressContent } from "@lark-agent/adapter-lark-cli";
import { codexAppServer } from "./codexRuntime.js";
import { enqueueLarkCodexReply, reconcileLarkCodexStartupWaits, reconcilePendingLarkThreadArchives, retryPendingLarkTextReplies, stopLarkCodexResponder } from "./responder.js";
import { ingestLarkEvent } from "./worker.js";
import { retryPendingLarkCompletionReactions } from "./completionReactions.js";
import { saveConversationPersona } from "./persona.js";

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
let heldArchive=null;
const archived=new Set();
let missingRejections=0;
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line), s=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8"));
 fs.appendFileSync(${JSON.stringify(log)},line+"\\n");
 if(m.method==="thread/loaded/list") {if(s.listError)send({id:m.id,error:{code:-1,message:"fixture list timed out"}});else send({id:m.id,result:{data:s.loaded===false||s.resumeWriterConflict?[]:["thread-fixture"],nextCursor:null}});}
 else if(m.method==="thread/unarchive") {if(s.unarchiveWriterConflict)send({id:m.id,error:{code:-1,message:"thread thread-fixture already has an active writer"}});else{archived.delete(m.params.threadId);send({id:m.id,result:{}});}}
 else if(m.method==="thread/archive") {if(s.archiveError)send({id:m.id,error:{code:-1,message:s.archiveError}});else if(s.deferArchive)heldArchive={id:m.id,threadId:m.params.threadId};else{archived.add(m.params.threadId);send({id:m.id,result:{}});}}
 else if(m.method==="thread/list") {const ids=s.archivedIds??[...archived];if(s.archiveListError)send({id:m.id,error:{code:-1,message:"fixture archive list failure"}});else send({id:m.id,result:s.archiveListMalformed?{}:{data:(m.params.archived?ids:["thread-fixture","thread-fixture-new"].filter(id=>!ids.includes(id))).map(id=>({id})),nextCursor:null}});}
 else if(m.method==="thread/resume" && s.resumeWriterConflict) send({id:m.id,error:{code:-1,message:"thread thread-fixture already has an active writer"}});
 else if(m.method==="thread/start"||m.method==="thread/resume") send({id:m.id,result:{thread:{id:s.resumeWriterConflict?"thread-fixture-new":"thread-fixture"}}});
 else if(m.method==="turn/start" && s.resumeWriterConflict && m.params.threadId!=="thread-fixture-new")send({id:m.id,error:{code:-1,message:"thread not found: thread-fixture"}});
 else if(m.method==="turn/start" && s.missingThread && (s.missingAlways||missingRejections++===0))send({id:m.id,error:{code:-1,message:"thread not found: thread-fixture"}});
 else if(m.method==="turn/start") {if(s.startError)send({id:m.id,error:{code:-1,message:typeof s.startError==="string"?s.startError:"fixture startup error /private/path token=fixture-secret"}});else{fs.writeFileSync(counter,String(++turn));send({id:m.id,result:{turn:{id:${JSON.stringify(path.basename(root) + "-turn-")}+turn,status:"inProgress"}}});}}
 else if(m.method==="thread/read") {const result={thread:{id:m.params.threadId,status:{type:s.threadStatus}}};if(s.readError)send({id:m.id,error:{code:-1,message:"fixture read failure"}});else if(s.defer)held={id:m.id,result};else send({id:m.id,result});}
 else if(m.method==="thread/turns/list") send({id:m.id,result:{data:s.missing?[]:[{id:s.turnId??${JSON.stringify(path.basename(root) + "-turn-")}+turn,status:s.status,error:s.error,items:s.items??[]}]}});
 else if(m.method==="fixture/release") {if(held)send(held);held=null;if(heldArchive){archived.add(heldArchive.threadId);send({id:heldArchive.id,result:{}});}heldArchive=null;send({id:m.id,result:{}});}
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
  const progress: LarkProgressContent[] = [], progressUpdates: LarkProgressContent[] = [];
  let failProgress = false;
  let failDelivery = false;
  configureConversationRuntime({database: store.db, mode: "active", repoRoot: root, workspaceRoot: root, larkStickerDirectory: path.join(root, "stickers"),
    progressSender: async (_id, content) => { progress.push(structuredClone(content)); if (failProgress) throw new Error("fixture progress failed"); return {ok:true,messageId:"om_progress",chatId:"oc_fixture",messageAt:null,messageType:"interactive"}; },
    progressUpdater: async (_id, content) => { progressUpdates.push(structuredClone(content)); return {ok:true}; },
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
  return {root, store, delivered, attempts, reactions, progress, progressUpdates, row, records, state, emit, message, turnId,
    failProgress(value: boolean) { failProgress = value; },
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
    async close() { stopLarkCodexResponder(); await drainLarkProgressCards(); await immediate(); store.close(); if (previous === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previous; if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; fs.rmSync(root, {recursive: true, force: true}); }
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

test("idle archive unload checks native state without retaining a loaded flag", async () => {
  for (const loaded of [false, true]) {
    const f = fixture(); try {
      await f.ready(); await f.complete(); f.state({ loaded, threadStatus: "idle", status: "completed" });
      await immediate();
      await until(() => (f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as { n: number }).n === 1);
      assert.equal(await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString()), 1);
      const calls = f.records();
      assert.equal(calls.filter(r => r.method === "thread/archive").length, 1);
      assert.equal(calls.filter(r => r.method === "thread/loaded/list").length, 1);
      assert.equal(calls.filter(r => r.method === "thread/unsubscribe").length, loaded ? 1 : 0);
      assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as { n: number }).n, 0);
    } finally { await f.close(); }
  }
});

test("bot reuse consults native loaded state even without a close notification", async () => {
  for (const loaded of [false, true]) {
    const f = fixture(); try {
      await f.ready(); await f.complete(); f.state({ loaded, unarchiveWriterConflict: loaded });
      ingestLarkEvent({ ...f.message, event_id: "event-second", message_id: "om_second", content: "second request" });
      const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_second'").get() as any;
      await until(() => Boolean(row()?.codex_turn_id) || row()?.codex_status === "failed");
      assert.equal(row().codex_status, "running", row().codex_error);
      const calls = f.records();
      assert.equal(calls.filter(r => r.method === "thread/loaded/list").length, 1);
      assert.equal(calls.filter(r => r.method === "thread/resume").length, loaded ? 0 : 1);
      assert.equal(calls.filter(r => r.method === "thread/unarchive").length, loaded ? 0 : 1);
      assert.equal(calls.filter(r => r.method === "thread/start").length, 1);
      assert.equal(row().codex_session_id, "thread-fixture");
      await f.complete(row().codex_turn_id);
      await until(() => row().codex_status === "answered");
    } finally { await f.close(); }
  }
});

test("a thread unloaded after native lookup is resumed once with identical input", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); f.state({ loaded: true, missingThread: true });
    ingestLarkEvent({ ...f.message, event_id: "event-second", message_id: "om_second", content: "second request" });
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_second'").get() as any;
    await until(() => Boolean(row()?.codex_turn_id) || row()?.codex_status === "failed");
    assert.equal(row().codex_status, "running", row().codex_error);
    const calls = f.records(), starts = calls.filter(r => r.method === "turn/start");
    assert.equal(starts.length, 3);
    assert.deepEqual(starts[1].params, starts[2].params);
    assert.equal(calls.filter(r => r.method === "thread/resume").length, 1);
    assert.equal(calls.filter(r => r.method === "thread/start").length, 1);
    assert.equal(calls.filter(r => r.method === "turn/interrupt").length, 0);
    assert.equal(row().codex_session_id, "thread-fixture");
    await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered");
    assert.deepEqual(f.delivered, ["fixture done", "fixture done"]);
  } finally { await f.close(); }
});

test("unknown loaded state and ambiguous startup failures do not create or replay turns", async () => {
  for (const state of [{ listError: true }, { startError: "request timed out: turn/start" }, { missingThread: true, missingAlways: true }]) {
    const f = fixture(); try {
      await f.ready(); await f.complete(); f.state(state);
      ingestLarkEvent({ ...f.message, event_id: "event-second", message_id: "om_second", content: "second request" });
      const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_second'").get() as any;
      await until(() => row()?.codex_status === "failed");
      const calls = f.records();
      assert.equal(calls.filter(r => r.method === "turn/start").length, "listError" in state ? 1 : "missingAlways" in state ? 3 : 2);
      assert.equal(calls.filter(r => r.method === "thread/resume").length, "missingAlways" in state ? 1 : 0);
      assert.equal(calls.filter(r => r.method === "thread/start").length, 1);
      assert.equal(row().reply_status, "sent");
      assert.match(f.delivered.at(-1)!, /本次 Codex 执行失败/);
    } finally { await f.close(); }
  }
});

test("unloaded bot thread owned by another writer starts a new full-context conversation", async () => {
 const f=fixture();try{
  await f.ready();await f.complete();
  await f.emit([{method:"thread/closed",params:{threadId:"thread-fixture"}}]);
  f.state({resumeWriterConflict:true});
  ingestLarkEvent({...f.message,event_id:"event-second",message_id:"om_second",content:"second request"});
  const row=()=>f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_second'").get() as any;
  await until(()=>Boolean(row()?.codex_turn_id)||row()?.codex_status==="failed");
  assert.equal(row().codex_status,"running",row().codex_error);
  assert.equal(row().codex_session_id,"thread-fixture-new");
  const turns=f.records().filter(r=>r.method==="turn/start");assert.equal(turns.length,2);assert.equal(turns[1].params.threadId,"thread-fixture-new");
  assert.ok(f.records().some(r=>r.method==="thread/resume"));
  await f.emit([{method:"item/completed",params:{threadId:"thread-fixture-new",turnId:row().codex_turn_id,item:{id:"answer",type:"agentMessage",phase:"final_answer",text:"fixture recovered"}}},{method:"turn/completed",params:{threadId:"thread-fixture-new",turn:{id:row().codex_turn_id,status:"completed"}}}]);
  await until(()=>row().codex_status==="answered");assert.equal(f.delivered.at(-1),"fixture recovered");
 }finally{await f.close();}
});

test("archive intent survives successful reuse and waits for the new native turn to end", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete();
    await until(() => (f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n === 1);
    f.state({ loaded: true, unarchiveWriterConflict: true });
    ingestLarkEvent({ ...f.message, event_id: "event-next", message_id: "om_next", content: "next request" });
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_next'").get() as any;
    await until(() => Boolean(row()?.codex_turn_id));
    await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 1);
    assert.equal(f.records().filter(r => r.method === "thread/archive").length, 0);
    await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered"); await immediate();
    f.state({ threadStatus: "idle", status: "completed" });
    await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    assert.equal(f.records().filter(r => r.method === "thread/archive").length, 1);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 0);
  } finally { await f.close(); }
});

test("fallback keeps the old thread archive independent from the replacement active thread", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ resumeWriterConflict: true, threadStatus: "active", status: "inProgress" });
    ingestLarkEvent({ ...f.message, event_id: "event-new", message_id: "om_new", content: "replacement request" });
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_new'").get() as any;
    await until(() => row()?.codex_session_id === "thread-fixture-new" && Boolean(row()?.codex_turn_id)); await immediate();
    const reconcile = () => reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    await reconcile();
    assert.equal(f.records().filter(r => r.method === "thread/archive").length, 0);
    assert.equal((f.store.db.prepare("SELECT attempts FROM lark_codex_archive_queue WHERE thread_id='thread-fixture'").get() as any).attempts, 0);
    f.state({ resumeWriterConflict: true, threadStatus: "idle", status: "completed" });
    await reconcile();
    assert.deepEqual(f.records().filter(r => r.method === "thread/archive").map(r => r.params.threadId), ["thread-fixture"]);
    assert.equal(row().codex_status, "running");
    await f.emit([{ method: "turn/completed", params: { threadId: "thread-fixture-new", turn: { id: row().codex_turn_id, status: "completed" } } }]);
    await until(() => row().codex_status === "no_reply"); await immediate();
    assert.ok(f.store.db.prepare("SELECT 1 FROM lark_codex_archive_queue WHERE thread_id='thread-fixture-new'").get());
    await reconcile();
    assert.deepEqual(f.records().filter(r => r.method === "thread/archive").map(r => r.params.threadId), ["thread-fixture", "thread-fixture-new"]);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 0);
    assert.equal(f.records().some(r => r.method === "turn/interrupt"), false);
  } finally { await f.close(); }
});

test("archive probes retain intent on active, inconsistent, missing and unavailable native state", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    for (const state of [
      { threadStatus: "active", status: "completed" }, { threadStatus: "idle", status: "inProgress" },
      { threadStatus: "idle", missing: true }, { threadStatus: "systemError" }, { readError: true }
    ]) {
      f.state(state);
      await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
      const row = f.store.db.prepare("SELECT attempts FROM lark_codex_archive_queue").get() as any;
      assert.equal(row.attempts, 0);
      assert.equal(f.records().filter(r => r.method === "thread/archive" || r.method === "thread/unsubscribe" || r.method === "turn/interrupt").length, 0);
    }
    f.state({ threadStatus: "notLoaded", status: "completed" });
    await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 0);
  } finally { await f.close(); }
});

test("already archived native threads reconcile errors and exhausted rows without more archive writes", async () => {
  for (const exhausted of [false, true]) {
    const f = fixture(); try {
      await f.ready(); await f.complete(); await immediate();
      if (exhausted) f.store.db.prepare("UPDATE lark_codex_archive_queue SET attempts=5").run();
      f.state({ threadStatus: "idle", status: "completed", archiveError: "no rollout found for thread id thread-fixture", archivedIds: ["thread-fixture"] });
      await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
      assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 0);
      assert.equal(f.records().filter(r => r.method === "thread/archive").length, exhausted ? 0 : 1);
      assert.equal(f.records().filter(r => r.method === "thread/unsubscribe").length, 0);
    } finally { await f.close(); }
  }
});

test("archive write failures are bounded and exhausted intent is only rechecked at low frequency", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ threadStatus: "idle", status: "completed", archiveError: "writer unavailable", archivedIds: [] });
    const future = new Date(Date.now() + 700_000).toISOString();
    for (let n = 0; n < 6; n++) await reconcilePendingLarkThreadArchives(future);
    assert.equal(f.records().filter(r => r.method === "thread/archive").length, 5);
    const row = f.store.db.prepare("SELECT * FROM lark_codex_archive_queue").get() as any;
    assert.equal(row.attempts, 5); assert.ok(Date.parse(row.due_at) >= Date.now() + 590_000);
    assert.equal(await reconcilePendingLarkThreadArchives(), 0);
    f.state({ archivedIds: ["thread-fixture"] });
    await reconcilePendingLarkThreadArchives(future);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_codex_archive_queue").get() as any).n, 0);
  } finally { await f.close(); }
});

test("incoming reuse waits for an in-flight archive before it can start a new turn", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ threadStatus: "idle", status: "completed", deferArchive: true });
    const checking = reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    await until(() => f.records().some(r => r.method === "thread/archive"));
    ingestLarkEvent({ ...f.message, event_id: "event-after", message_id: "om_after", content: "after archive" });
    await immediate(); await immediate();
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
    await codexAppServer.request("fixture/release", {}); await checking;
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_after'").get() as any;
    await until(() => Boolean(row()?.codex_turn_id));
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 2);
    await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered");
  } finally { await f.close(); }
});

test("an incoming dispatch during the native idle probe prevents archiving its reused thread", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ threadStatus: "idle", status: "completed", defer: true });
    const checking = reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    await until(() => f.records().some(r => r.method === "thread/read"));
    ingestLarkEvent({ ...f.message, event_id: "event-probe", message_id: "om_probe", content: "new request during probe" });
    await immediate();
    await codexAppServer.request("fixture/release", {}); await checking;
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_probe'").get() as any;
    await until(() => Boolean(row()?.codex_turn_id));
    assert.equal(f.records().filter(r => r.method === "thread/archive").length, 0);
    await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered");
    assert.ok(f.store.db.prepare("SELECT 1 FROM lark_codex_archive_queue").get());
  } finally { await f.close(); }
});

test("an archived thread still loaded during unsubscribe grace is restored before reuse", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ threadStatus: "idle", status: "completed", loaded: true });
    await reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    ingestLarkEvent({ ...f.message, event_id: "event-restored", message_id: "om_restored", content: "restore archived conversation" });
    const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_restored'").get() as any;
    await until(() => Boolean(row()?.codex_turn_id));
    assert.equal(row().codex_session_id, "thread-fixture");
    assert.equal(f.records().filter(r => r.method === "thread/unarchive").length, 1);
    assert.equal(f.records().filter(r => r.method === "thread/resume").length, 0);
    await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered");
  } finally { await f.close(); }
});

test("unknown archive membership cannot trigger restore, fallback or replay of a loaded thread", async () => {
  for (const state of [{ archiveListError: true }, { archiveListMalformed: true }]) {
    const f = fixture(); try {
      await f.ready(); await f.complete(); await immediate(); f.state(state);
      ingestLarkEvent({ ...f.message, event_id: "event-unknown", message_id: "om_unknown", content: "unknown membership" });
      const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_unknown'").get() as any;
      await until(() => row()?.codex_status === "failed");
      assert.equal(f.records().filter(r => r.method === "thread/start").length, 1);
      assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
      assert.equal(f.records().filter(r => r.method === "thread/unarchive" || r.method === "turn/interrupt").length, 0);
      assert.ok(f.store.db.prepare("SELECT 1 FROM lark_codex_archive_queue").get());
    } finally { await f.close(); }
  }
});

test("stale archive completion cannot delete or overwrite a newer thread cleanup token", async () => {
  const f = fixture(); try {
    await f.ready(); await f.complete(); await immediate();
    f.state({ threadStatus: "idle", status: "completed", deferArchive: true });
    const checking = reconcilePendingLarkThreadArchives(new Date(Date.now() + 31_000).toISOString());
    await until(() => f.records().some(r => r.method === "thread/archive"));
    f.store.db.prepare("UPDATE lark_codex_archive_queue SET token='newer-token', attempts=2").run();
    await codexAppServer.request("fixture/release", {}); await checking;
    const row = f.store.db.prepare("SELECT token,attempts FROM lark_codex_archive_queue").get() as any;
    assert.deepEqual(row, { token: "newer-token", attempts: 2 });
    assert.equal(f.records().some(r => r.method === "thread/unsubscribe"), false);
  } finally { await f.close(); }
});

test("short tasks send only final text even when commentary matches the final answer", async () => {
  const f = fixture();
  try {
    setAppSettingValue("interimRepliesEnabled", "true"); await f.ready();
    const turnId = f.row().codex_turn_id;
    await f.emit([
      {method:"item/started",params:{threadId:"thread-fixture",turnId,item:{id:"work",type:"commandExecution"}}},
      {method:"item/completed",params:{threadId:"thread-fixture",turnId,item:{id:"progress",type:"agentMessage",phase:"commentary",text:"fixture done"}}}
    ]);
    await f.complete(); await drainLarkProgressCards();
    assert.deepEqual(f.delivered, ["fixture done"]); assert.equal(f.progress.length, 0);
  } finally { await f.close(); }
});

test("long tasks and steer keep one progress card, then send the final answer once even with identical text", async () => {
  const f = fixture(), delay = config.larkCodexInterimReplyDelayMs;
  try {
    config.larkCodexInterimReplyDelayMs = 0;
    setAppSettingValue("interimRepliesEnabled", "true"); await f.ready();
    const turnId = f.row().codex_turn_id;
    const progress = (id: string, text: string) => f.emit([{method:"item/completed",params:{threadId:"thread-fixture",turnId,item:{id,type:"agentMessage",phase:"commentary",text}}}]);
    await f.emit([{method:"item/started",params:{threadId:"thread-fixture",turnId,item:{id:"work",type:"commandExecution"}}}]);
    await progress("step-one", "first step"); await drainLarkProgressCards();
    assert.equal(f.progress.length, 1); assert.equal(f.delivered.length, 0); assert.equal(f.row().reply_status, "pending");
    ingestLarkEvent({...f.message,event_id:"event-steer",message_id:"om_steer",content:"how is it going"});
    const steered = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_steer'").get() as any;
    await until(() => steered()?.codex_turn_id === turnId);
    await f.emit([{method:"item/completed",params:{threadId:"thread-fixture",turnId,item:{type:"userMessage",clientId:"om_steer"}}}]);
    await progress("step-two", "second step"); await progress("step-three", "fixture done");
    f.store.db.prepare("UPDATE lark_progress_cards SET next_attempt_at='2000-01-01T00:00:00Z'").run(); await drainLarkProgressCards();
    await f.complete(); await drainLarkProgressCards();
    assert.equal(f.progress.length, 1); assert.equal(f.progressUpdates.at(-1)!.state, "completed");
    assert.ok(f.progressUpdates.at(-1)!.entries.some(e => e.text === "second step"));
    assert.deepEqual(f.delivered, ["fixture done"]); assert.equal(steered().reply_status, "sent");
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
    assert.equal(f.records().filter(r => r.method === "turn/steer").length, 1);
  } finally { config.larkCodexInterimReplyDelayMs = delay; await f.close(); }
});

test("progress delivery failure never blocks or duplicates final text", async () => {
  const f = fixture(), delay = config.larkCodexInterimReplyDelayMs;
  try {
    config.larkCodexInterimReplyDelayMs = 0; f.failProgress(true);
    setAppSettingValue("interimRepliesEnabled", "true"); await f.ready();
    await f.emit([{method:"item/started",params:{threadId:"thread-fixture",turnId:f.row().codex_turn_id,item:{id:"work",type:"commandExecution"}}}]);
    await drainLarkProgressCards(); await f.complete(); await drainLarkProgressCards();
    assert.deepEqual(f.delivered, ["fixture done"]); assert.equal(f.row().reply_status, "sent");
    const card = f.store.db.prepare("SELECT state,last_error FROM lark_progress_cards").get() as any;
    assert.equal(card.state, "completed"); assert.match(card.last_error, /fixture progress failed/);
  } finally { config.larkCodexInterimReplyDelayMs = delay; await f.close(); }
});

test("an isolated progress storage failure cannot prevent the native task from completing and replying", async () => {
  const f = fixture(), delay = config.larkCodexInterimReplyDelayMs;
  try {
    config.larkCodexInterimReplyDelayMs = 0;
    f.store.db.exec("CREATE TRIGGER reject_progress BEFORE INSERT ON lark_progress_cards BEGIN SELECT RAISE(ABORT,'fixture progress storage failure'); END");
    setAppSettingValue("interimRepliesEnabled", "true"); await f.ready();
    await f.emit([{method:"item/started",params:{threadId:"thread-fixture",turnId:f.row().codex_turn_id,item:{id:"work",type:"commandExecution"}}}]);
    await f.complete(); await drainLarkProgressCards();
    assert.deepEqual(f.delivered, ["fixture done"]); assert.equal(f.row().codex_status, "answered");
  } finally { config.larkCodexInterimReplyDelayMs = delay; await f.close(); }
});

test("native inputs reuse stable instructions but refresh settings, compaction and per-message tool bindings", async () => {
  const f = fixture();
  try {
    setAppSettingValue("prompt.larkAssistant", "GLOBAL_STYLE_ONE");
    setAppSettingValue("stickerUsageMode", "always");
    await f.ready();
    const first = f.records().find(r => r.method === "turn/start").params.input[0].text as string;
    assert.match(first, /GLOBAL_STYLE_ONE/);
    const firstToken = first.match(/context_token=([A-Za-z0-9_-]{32})/)![1];
    setAppSettingValue("prompt.larkAssistant", "GLOBAL_STYLE_TWO");
    const add = async (key: string) => {
      ingestLarkEvent({ ...f.message, event_id: `event-${key}`, message_id: `om_${key}`, content: `request ${key}` });
      const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id=?").get(`om_${key}`) as any;
      await until(() => Boolean(row()?.codex_turn_id) || row()?.codex_status === "failed");
      assert.equal(row().codex_status, "running", row().codex_error);
      return row;
    };
    const second = await add("steered");
    await until(() => f.records().some(r => r.method === "turn/steer"));
    const steered = f.records().find(r => r.method === "turn/steer").params.input[0].text as string;
    assert.doesNotMatch(steered, /GLOBAL_STYLE_ONE|GLOBAL_STYLE_TWO|通用执行与消息规则/);
    assert.match(steered, /每次准备产生可见的最终文字回复时，都必须调用/);
    assert.match(steered, /attach_files|history_images/);
    assert.ok(!steered.includes(firstToken));
    assert.ok(steered.includes(path.join(second().codex_task_dir, "output")));
    await f.complete(); await until(() => second().codex_status === "answered");
    const third = await add("changed");
    const thirdInput = f.records().filter(r => r.method === "turn/start").at(-1).params.input[0].text as string;
    assert.match(thirdInput, /GLOBAL_STYLE_TWO/);
    await f.complete(third().codex_turn_id); await until(() => third().codex_status === "answered");
    await f.emit([{ method: "item/completed", params: { threadId: "thread-fixture", item: { type: "contextCompaction", id: "compact" } } }]);
    const fourth = await add("compacted");
    assert.match(f.records().filter(r => r.method === "turn/start").at(-1).params.input[0].text, /GLOBAL_STYLE_TWO/);
    await f.complete(fourth().codex_turn_id); await until(() => fourth().codex_status === "answered");
    saveConversationPersona("oc_fixture", { mode: "custom", name: "Test persona", instructions: "PERSONA_STYLE_THREE" });
    const fifth = await add("persona");
    assert.match(f.records().filter(r => r.method === "turn/start").at(-1).params.input[0].text, /PERSONA_STYLE_THREE/);
    await f.complete(fifth().codex_turn_id); await until(() => fifth().codex_status === "answered");
    f.state({ loaded: false });
    const sixth = await add("resumed");
    const last = f.records().filter(r => r.method === "turn/start").at(-1).params.input[0].text as string;
    assert.doesNotMatch(last, /PERSONA_STYLE_THREE|通用执行与消息规则/);
    assert.match(last, /每次准备产生可见的最终文字回复时，都必须调用/);
    assert.equal(f.records().filter(r => r.method === "thread/resume").at(-1).params.sandbox, "read-only");
    const artifact = JSON.parse(fs.readFileSync(path.join(sixth().codex_task_dir, "resume-session.json"), "utf8"));
    assert.equal(artifact.stableInstructions, "reused");
    await f.complete(sixth().codex_turn_id); await until(() => sixth().codex_status === "answered");
  } finally { await f.close(); }
});

test("rejected inputs never commit changed instructions and a responder restart refreshes them", async () => {
  const f = fixture();
  try {
    setAppSettingValue("prompt.larkAssistant", "STYLE_BEFORE_FAILURE");
    await f.ready(); await f.complete();
    setAppSettingValue("prompt.larkAssistant", "STYLE_AFTER_FAILURE");
    f.state({ startError: true });
    ingestLarkEvent({ ...f.message, event_id: "event-failed", message_id: "om_failed", content: "rejected input" });
    const failed = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_failed'").get() as any;
    await until(() => failed()?.codex_status === "failed");
    f.state({});
    for (const key of ["retry", "restart"]) {
      if (key === "restart") { stopLarkCodexResponder(); await immediate(); }
      ingestLarkEvent({ ...f.message, event_id: `event-${key}`, message_id: `om_${key}`, content: `request ${key}` });
      const row = () => f.store.db.prepare("SELECT * FROM lark_messages WHERE message_id=?").get(`om_${key}`) as any;
      await until(() => Boolean(row()?.codex_turn_id));
      assert.match(f.records().filter(r => r.method === "turn/start").at(-1).params.input[0].text, /STYLE_AFTER_FAILURE/);
      await f.complete(row().codex_turn_id); await until(() => row().codex_status === "answered");
    }
  } finally { await f.close(); }
});

test("reply delivery keeps business results around private clauses and retains the raw native answer locally", async () => {
  const f = fixture();
  try {
    await f.ready();
    const text = "已核实 3 个服务健康，依据 AGENTS.md 和本机工作区规则。部署尚未执行；等待审批后继续。";
    await f.emit([
      { method: "item/completed", params: { threadId: "thread-fixture", turnId: f.row().codex_turn_id, item: { id: "answer", type: "agentMessage", phase: "final_answer", text } } },
      { method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: f.row().codex_turn_id, status: "completed" } } }
    ]);
    await until(() => f.row().codex_status === "answered");
    assert.equal(f.delivered.length, 1);
    assert.match(f.delivered[0], /已核实 3 个服务健康/);
    assert.match(f.delivered[0], /部署尚未执行；等待审批后继续/);
    assert.doesNotMatch(f.delivered[0], /AGENTS\.md|工作区规则/);
    assert.ok(fs.readFileSync(path.join(f.row().codex_task_dir, "codex.stdout.jsonl"), "utf8").includes(text));
  } finally { await f.close(); }
});

test("optional prompt diagnostics cannot fail or replay an already accepted turn", async () => {
  const f = fixture();
  const append = fs.appendFileSync;
  try {
    fs.appendFileSync = (...args: Parameters<typeof fs.appendFileSync>) => {
      if (String(args[1]).includes('"method":"turn/prompt-context"')) throw new Error("simulated log write failure");
      return append(...args);
    };
    await f.ready();
    fs.appendFileSync = append;
    assert.equal(f.row().codex_status, "running");
    assert.equal(f.records().filter(r => r.method === "turn/start").length, 1);
    await f.complete();
    assert.deepEqual(f.delivered, ["fixture done"]);
  } finally { fs.appendFileSync = append; await f.close(); }
});
