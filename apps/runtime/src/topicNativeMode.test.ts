import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { config, isNativeTopicConversation, recordOutboundLarkMessage, saveConversationPersona, setAppSettingValue, setExternalMessageHandler } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { createRuntime } from "./index.js";

async function until(check: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!check()) { assert(performance.now() < deadline, "topic fixture timed out"); await immediate(); }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-native-topic-"));
  const log = path.join(root, "rpc.jsonl"), executable = path.join(root, "codex.mjs"), lookupGate = path.join(root, "hold-lookup");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n'),loaded=new Set(),archived=new Set(),turns=new Map();let n=0,t=0,heldLookup=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(m.method==='thread/start'||m.method==='thread/resume'){const id=m.params.threadId??'topic-thread-'+(++n);loaded.add(id);send({id:m.id,result:{thread:{id}}});}
 else if(m.method==='thread/loaded/list'){if(fs.existsSync(${JSON.stringify(lookupGate)}))heldLookup=m;else send({id:m.id,result:{data:[...loaded],nextCursor:null}});}
 else if(m.method==='fixture/release'){if(heldLookup)send({id:heldLookup.id,result:{data:[...loaded],nextCursor:null}});heldLookup=null;send({id:m.id,result:{}});}
 else if(m.method==='thread/list')send({id:m.id,result:{data:[...(m.params.archived?archived:loaded)].map(id=>({id})),nextCursor:null}});
 else if(m.method==='thread/archive'){archived.add(m.params.threadId);loaded.delete(m.params.threadId);send({id:m.id,result:{}});}
 else if(m.method==='thread/unarchive'){archived.delete(m.params.threadId);send({id:m.id,result:{}});}
 else if(m.method==='turn/start'||m.method==='turn/steer'){
  const id=m.method==='turn/start'?'topic-turn-'+(++t):turns.get(m.params.threadId);turns.set(m.params.threadId,id);
  send({id:m.id,result:m.method==='turn/start'?{turn:{id,status:'inProgress'}}:{turnId:id}});
  send({method:'item/completed',params:{threadId:m.params.threadId,turnId:id,item:{type:'userMessage',clientId:m.params.clientUserMessageId}}});
 }else if(m.method==='fixture/emit'){send({id:m.id,result:{}});for(const item of m.params.notifications)send(item);}
 else if(m.method)send({id:m.id,result:{}});
});`);
  fs.chmodSync(executable, 0o755);
  const cli = path.join(root, "lark-cli");
  fs.writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,identities:{bot:{openId:'ou_bot'}},data:{messages:[]}}));\n`);
  fs.chmodSync(cli, 0o755);
  const oldPath = process.env.PATH, oldCodex = process.env.CODEX_EXECUTABLE;
  process.env.PATH = `${root}:${oldPath ?? ""}`; process.env.CODEX_EXECUTABLE = executable;
  const options = { databasePath: path.join(root, "test.sqlite"), mode: "active" as const, workspaceRoot: root,
    trustedSenderIds: ["ou_owner"], approverId: "ou_owner", runtimeToken: "fixture-token",
    reactionSender: () => ({ ok: true as const }), textReplySender: () => ({ ok: true as const, messageId: "om_out_" + (++out), chatId: "oc_fixture", messageAt: null, messageType: "text" }) };
  let out = 0, sequence = 0, runtime = createRuntime(options);
  for (const [key, value] of Object.entries({ stickerUsageMode: "off", interimRepliesEnabled: "false", executionReceiptsEnabled: "false", trustedExecutionEnabled: "true" })) setAppSettingValue(key, value);
  const row = (id: string) => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE message_id=?").get(id) as any;
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const settings = (payload: Record<string, unknown>) => runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload });
  return { root, row, calls, settings, runtime: () => runtime,
    holdLookup() { fs.writeFileSync(lookupGate, "hold"); },
    async releaseLookup() { fs.rmSync(lookupGate); await codexAppServer.request("fixture/release", {}); },
    async message(extra: Record<string, unknown> = {}) {
      const id = `om_in_${++sequence}`;
      const event = { event_id: `event_${sequence}`, message_id: id, chat_id: "oc_fixture", chat_type: "group", sender_id: "ou_owner", sender_type: "user", message_type: "text",
        content: "continue the investigation", root_id: "om_root", thread_id: "omt_fixture", mentions: [], ...extra };
      const result = await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: event });
      assert.equal(result.statusCode, 200, result.body);
      return { id, event, row: () => row(id), async started() { await until(() => Boolean(row(id)?.codex_turn_id)); return row(id); } };
    },
    async complete(id: string, text = "fixture answer") {
      const current = row(id); assert(current.codex_turn_id);
      await codexAppServer.request("fixture/emit", { notifications: [
        { method: "item/completed", params: { threadId: current.codex_session_id, turnId: current.codex_turn_id, item: { id: "answer", type: "agentMessage", phase: "final_answer", text } } },
        { method: "turn/completed", params: { threadId: current.codex_session_id, turn: { id: current.codex_turn_id, status: "completed" } } }
      ] });
      await until(() => !["running", "queued"].includes(row(id).codex_status));
    },
    async restart() { await runtime.app.close(); runtime.stop(); await immediate(); runtime = createRuntime(options); },
    async close() {
      setExternalMessageHandler(null); await runtime.app.close(); runtime.stop(); await immediate();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCodex === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldCodex;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
const mention = [{ id: { open_id: "ou_bot" } }];

test("default off retains mention-only topic behavior; enabling does not enroll historical threads", async () => {
  const f = fixture(); try {
    assert.equal((await f.runtime().app.inject({ url: "/v1/settings" })).json().topicNativeModeEnabled, false);
    const skipped = await f.message(); assert.equal(skipped.row().codex_status, "skipped");
    const first = await f.message({ mentions: mention }); await first.started(); await f.complete(first.id);
    assert.equal((await f.message()).row().codex_status, "skipped");
    assert.equal((await f.settings({ topicNativeModeEnabled: true })).statusCode, 200);
    assert.equal((await f.message()).row().codex_status, "skipped");
    assert.equal(f.calls().filter(c => c.method === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("enrolled topic resumes native thread with compact deltas, citations, attachments and no echoed native answers", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const first = await f.message({ mentions: mention, content: "investigate the fixture" }); await first.started(); await f.complete(first.id, "previous native answer");
    recordOutboundLarkMessage({ messageId: "om_delivery_notice", chatId: "oc_fixture", chatType: "group", recipientId: "ou_owner",
      content: "附件未能送达，请重试。", replyToMessageId: first.id, source: "reply" });
    const next = await f.message({ content: "what is the next step?", reply_to: first.id }); await next.started();
    assert.equal(next.row().reply_trigger, "topic"); assert.equal(next.row().mentioned, 0);
    assert.equal(next.row().codex_session_id, first.row().codex_session_id);
    const prompt = fs.readFileSync(path.join(next.row().codex_task_dir, "prompt.md"), "utf8");
    assert.match(prompt, /话题续聊/); assert.match(prompt, /what is the next step/); assert.match(prompt, /回复(?:窗口外的)? L\d+/);
    assert.match(prompt, /sender_id=ou_owner/); assert.match(prompt, /时间\(\+08:00\)/);
    assert.match(prompt, /context_token=[A-Za-z0-9_-]{32}/); assert.match(prompt, /attach_files/);
    assert.doesNotMatch(prompt, /消息元数据：|previous native answer|这是同一飞书 Codex 会话中的新增消息/);
    assert.match(prompt, /附件未能送达，请重试/);
    assert(prompt.length < fs.readFileSync(path.join(first.row().codex_task_dir, "prompt.md"), "utf8").length);
    await f.complete(next.id);
    const steered = await f.message(); await steered.started();
    const follow = await f.message({ content: "also check the fixture detail" }); await follow.started();
    assert.equal(follow.row().codex_session_id, steered.row().codex_session_id);
    assert.equal(follow.row().codex_turn_id, steered.row().codex_turn_id);
    assert(f.calls().some(c => c.method === "turn/steer"));
    await f.settings({ topicNativeModeEnabled: false }); await f.complete(follow.id);
    assert.equal(follow.row().codex_status, "answered");
    assert.equal(f.calls().some(c => c.method === "turn/interrupt"), false);
  } finally { await f.close(); }
});

test("native topic enrollment survives restart but off/on requires a new mention and never replays old input", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const first = await f.message({ mentions: mention }); await first.started(); await f.complete(first.id);
    await f.restart(); assert(isNativeTopicConversation(first.row()));
    const next = await f.message(); await next.started(); await f.complete(next.id);
    await f.settings({ topicNativeModeEnabled: false });
    const snapshot = { ...next.row() };
    await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: next.event });
    assert.deepEqual(next.row(), snapshot);
    assert.equal((await f.message()).row().codex_status, "skipped");
    await f.settings({ topicNativeModeEnabled: true });
    assert.equal((await f.message()).row().codex_status, "skipped");
    const rejoin = await f.message({ mentions: mention }); await rejoin.started(); await f.complete(rejoin.id);
    const resumed = await f.message(); await resumed.started(); await f.complete(resumed.id);
    assert.equal(resumed.row().codex_session_id, first.row().codex_session_id);
  } finally { await f.close(); }
});

test("compact topic turns refresh persona, approval and media guidance after changes and native compaction", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const first = await f.message({ mentions: mention, sender_id: "ou_member" }); await first.started(); await f.complete(first.id);
    saveConversationPersona("oc_fixture", { mode: "custom", name: "Fixture", instructions: "Use the updated fixture persona." });
    await f.settings({ stickerUsageMode: "always" });
    const next = await f.message({ sender_id: "ou_member" }); await next.started();
    const prompt = fs.readFileSync(path.join(next.row().codex_task_dir, "prompt.md"), "utf8");
    assert.match(prompt, /updated fixture persona/); assert.match(prompt, /只读查询执行授权/);
    assert.match(prompt, /history_images_search/); assert.match(prompt, /attach_files/); assert.match(prompt, /表情包（每次回复）/);
    await f.complete(next.id);
    await codexAppServer.request("fixture/emit", { notifications: [{ method: "thread/compacted", params: { threadId: next.row().codex_session_id } }] });
    const after = await f.message({ sender_id: "ou_member" }); await after.started();
    const refreshed = fs.readFileSync(path.join(after.row().codex_task_dir, "prompt.md"), "utf8");
    assert.match(refreshed, /updated fixture persona/); assert.match(refreshed, /只读查询执行授权/); assert.match(refreshed, /history_images_search/);
    await f.complete(after.id);
  } finally { await f.close(); }
});

test("root mention enrolls a later native topic; leave is local, idempotent and preserves history", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const root = await f.message({ root_id: null, thread_id: null, mentions: mention }); await root.started(); await f.complete(root.id);
    const child = await f.message({ root_id: root.id }); await child.started(); await f.complete(child.id);
    assert.notEqual(child.row().codex_session_id, root.row().codex_session_id);
    const leave = await f.message({ root_id: root.id, mentions: mention, content: "@_user_1 /topic leave" });
    assert.equal(leave.row().codex_status, "skipped");
    assert.equal((await f.message({ root_id: root.id })).row().codex_status, "skipped");
    await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: root.event });
    assert.equal((await f.message({ root_id: root.id })).row().codex_status, "skipped");
    assert.equal(root.row().codex_status, "answered"); assert.equal(child.row().codex_status, "answered");
    const rejoin = await f.message({ root_id: root.id, mentions: mention }); await rejoin.started(); await f.complete(rejoin.id);
    assert.equal(rejoin.row().codex_session_id, child.row().codex_session_id);
    await f.message({ root_id: root.id, mentions: mention, content: "/topic leave" });
    const rootRejoin = await f.message({ root_id: root.id, thread_id: null, mentions: mention }); await rootRejoin.started(); await f.complete(rootRejoin.id);
    const afterLeave = await f.message({ root_id: root.id }); await afterLeave.started(); await f.complete(afterLeave.id);
    await f.settings({ topicNativeModeEnabled: false }); await f.settings({ topicNativeModeEnabled: true });
    const newRoot = await f.message({ root_id: root.id, thread_id: null, mentions: mention }); await newRoot.started(); await f.complete(newRoot.id);
    const afterToggle = await f.message({ root_id: root.id }); await afterToggle.started(); await f.complete(afterToggle.id);
    assert.equal(afterToggle.row().codex_session_id, child.row().codex_session_id);
  } finally { await f.close(); }
});

test("disabling mode while native lookup is in flight skips an unaccepted automatic follow-up", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const first = await f.message({ mentions: mention }); await first.started(); await f.complete(first.id);
    f.holdLookup(); const previous = f.calls().filter(c => c.method === "thread/loaded/list").length;
    const next = await f.message(); await until(() => f.calls().filter(c => c.method === "thread/loaded/list").length > previous);
    await f.settings({ topicNativeModeEnabled: false }); await f.releaseLookup();
    await until(() => next.row().codex_status === "skipped");
    assert.equal(next.row().reply_status, "skipped");
    assert.equal(f.calls().filter(c => c.method === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("topic continuation preserves trust separation, bot exclusion, unrelated topics, privacy and owner-assist routing", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const first = await f.message({ mentions: mention }); await first.started(); await f.complete(first.id);
    for (const extra of [{ thread_id: "omt_other", root_id: "om_other" }, { thread_id: null, root_id: null }, { chat_id: "oc_other" }, { sender_type: "bot", sender_id: "ou_bot" }]) {
      assert.equal((await f.message(extra)).row().codex_status, "skipped");
    }
    const untrusted = await f.message({ sender_id: "ou_member" }); await untrusted.started();
    assert.notEqual(untrusted.row().codex_session_id, first.row().codex_session_id);
    const request = f.calls().find(c => c.method === "thread/start" && c.params.sandbox === "read-only"); assert(request);
    assert.equal(request.params.approvalPolicy, "on-request"); await f.complete(untrusted.id);
    config.groupPrivacyEnforced = true;
    assert.equal((await f.message()).row().codex_status, "skipped"); config.groupPrivacyEnforced = false;
    setExternalMessageHandler(() => true);
    assert.equal((await f.message()).row().codex_status, "skipped"); setExternalMessageHandler(null);
    setAppSettingValue("ownerMentionAssistEnabled", "true");
    const owner = await f.message({ sender_id: "ou_member", mentions: [{ id: { open_id: "ou_owner" } }] }); await owner.started();
    assert.equal(owner.row().reply_trigger, "owner_mention");
    assert.notEqual(owner.row().codex_session_id, untrusted.row().codex_session_id); await f.complete(owner.id, "<lark-no-reply/>");
  } finally { await f.close(); }
});
