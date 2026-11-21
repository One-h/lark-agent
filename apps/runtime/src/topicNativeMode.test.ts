import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { claimLarkCodexReply, config, isNativeTopicConversation, larkCodexAppServerStatus, recordOutboundLarkMessage, saveConversationPersona, setAppSettingValue, setExternalMessageHandler } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { createRuntime, type RuntimeConfig } from "./index.js";
import { configuredNativeAcpEngines, createNativeAcpExecutionEngine, larkExecutionPolicy, reconcileLarkProgressCards, type ExecutionEngine, type ExecutionTurnResult, type LarkExecutionPolicy } from "@lark-agent/conversation-runtime";

const originalCodexExecutable = process.env.CODEX_EXECUTABLE;
// Each fixture installs its own peer. No late callback should start the real CLI.
test.before(() => { process.env.CODEX_EXECUTABLE = process.execPath; });
test.after(() => {
  if (originalCodexExecutable === undefined) delete process.env.CODEX_EXECUTABLE;
  else process.env.CODEX_EXECUTABLE = originalCodexExecutable;
});

async function until(check: () => boolean, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) { assert(performance.now() < deadline, "topic fixture timed out"); await immediate(); }
}

function fixture(executionEngines: ExecutionEngine[] = [], overrides: Partial<RuntimeConfig> = {}) {
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
  const options: RuntimeConfig = { databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, executionEngines,
    trustedSenderIds: ["ou_owner"], approverId: "ou_owner", runtimeToken: "fixture-token",
    progressSender: async () => ({ ok: true as const, messageId: "om_fixture_progress", chatId: "oc_fixture", messageAt: null, messageType: "interactive" }),
    progressUpdater: async () => ({ ok: true as const }),
    reactionSender: () => ({ ok: true as const }), textReplySender: (_id, _text, _key, presentation) =>
      ({ ok: true, messageId: "om_out_" + (++out), chatId: "oc_fixture", messageAt: null, messageType: presentation?.msgType ?? "text" }), ...overrides };
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
      const result = await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: event, headers: { authorization: "Bearer fixture-token" } });
      assert.equal(result.statusCode, 200, result.body);
      return { id, event, row: () => row(id), async started() {
        // The row gets a turn ID before the native steer request is acknowledged.
        await until(() => {
          const current = row(id);
          return Boolean(current?.codex_turn_id && current.codex_task_dir
            && fs.existsSync(path.join(current.codex_task_dir, "resume-session.json")));
        });
        return row(id);
      } };
    },
    async complete(id: string, text = "fixture answer") {
      const current = row(id); assert(current.codex_turn_id);
      await codexAppServer.request("fixture/emit", { notifications: [
        { method: "item/completed", params: { threadId: current.codex_session_id, turnId: current.codex_turn_id, item: { id: "answer", type: "agentMessage", phase: "final_answer", text } } },
        { method: "turn/completed", params: { threadId: current.codex_session_id, turn: { id: current.codex_turn_id, status: "completed" } } }
      ] });
      await until(() => !["running", "queued"].includes(row(id).codex_status));
    },
    async restart() {
      await until(() => larkCodexAppServerStatus().activeTurns === 0);
      await runtime.app.close(); runtime.stop(); await immediate(); runtime = createRuntime(options);
    },
    async close() {
      setExternalMessageHandler(null); await runtime.app.close(); runtime.stop(); await immediate();
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCodex === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldCodex;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
const mention = [{ id: { open_id: "ou_bot" } }];

test("group and direct chat execution settings share the registry without mixing sessions or bypassing policy", async () => {
  const opened: Array<{ engineId: string; sessionId: string | null; model: string | null; policy: LarkExecutionPolicy }> = [];
  const prompts: string[] = [];
  let release: (() => void) | undefined;
  const engine = (id: string): ExecutionEngine => ({
    descriptor: { id, label: id, models: [`${id}-model[1m]`] },
    supportsPolicy: policy => policy.trustScope === "trusted",
    async open({ sessionId, model, policy }) {
      opened.push({ engineId: id, sessionId, model, policy });
      return {
        id: sessionId ?? `${id}-session-${opened.length}`,
        async run(text) {
          prompts.push(text);
          if (text.endsWith("hold the turn")) await new Promise<void>(resolve => { release = resolve; });
          return { status: "completed", text: "fixture answer" };
        },
        close() {}
      };
    }
  });
  const f = fixture([engine("fixture"), engine("another")]);
  const group = "oc_group", direct = "oc_direct";
  const url = (chat: string, topic?: string) => `/v1/chats/${chat}${topic ? `/topics/${topic}` : ""}/execution`;
  const headers = { authorization: "Bearer fixture-token" };
  const read = (chat: string, topic?: string) => f.runtime().app.inject({ url: url(chat, topic), headers });
  const select = (chat: string, override: { engineId: string; model: string | null } | null, topic?: string) =>
    f.runtime().app.inject({ method: "PUT", url: url(chat, topic), headers, payload: { override } });
  const send = (chat: string, content: string, extra: Record<string, unknown> = {}) => f.message({
    chat_id: chat, chat_type: chat === direct ? "p2p" : "group", thread_id: null, root_id: null,
    mentions: chat === direct ? [] : mention, content, ...extra
  });
  const waitForReply = (message: { row(): any }) => until(() => message.row()?.codex_status === "answered");
  try {
    saveConversationPersona(group, { mode: "custom", name: "Fixture", instructions: "Use only the fixture style." });
    assert.equal((await f.runtime().app.inject({ url: url(group) })).statusCode, 401);
    assert.equal((await select(group, { engineId: "fixture", model: null })).statusCode, 404);
    const historical = await send(group, "historical group message", { mentions: [] });
    const oldDirect = await send(direct, "existing Codex direct conversation");
    await oldDirect.started(); await f.complete(oldDirect.id);
    assert.equal((await read(group)).json().effective.engineId, "codex");
    assert.equal((await select(group, { engineId: "codex", model: "fixture-original-codex" })).statusCode, 200);
    assert.equal((await select(group, { engineId: "fixture", model: "unlisted" })).statusCode, 409);
    assert.equal((await select(group, { engineId: "fixture", model: "fixture-model[1m]" })).statusCode, 200);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: historical.event })).statusCode, 401);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/messages/${historical.row().id}/retry`, headers })).statusCode, 409);
    const blocked = await send(group, "cannot run", { sender_id: "ou_member" });
    await until(() => blocked.row().codex_status === "failed");
    assert.equal(opened.length, 0);
    const first = await send(group, "hold the turn");
    await until(() => Boolean(release));
    assert.equal((await select(group, null)).statusCode, 409);
    release!(); await waitForReply(first);
    assert.match(prompts[0], /Use only the fixture style/);
    assert.doesNotMatch(prompts[0], /historical group message/);
    assert.deepEqual(opened[0], { engineId: "fixture", sessionId: null, model: "fixture-model[1m]", policy: larkExecutionPolicy(f.root, true) });

    assert.equal((await select(direct, { engineId: "another", model: null })).statusCode, 200);
    const dm = await send(direct, "first external direct turn");
    await waitForReply(dm);
    assert.equal(opened.at(-1)?.engineId, "another"); assert.equal(opened.at(-1)?.sessionId, null);
    await f.restart();
    const replyAfterRestart = await send(group, "resume group");
    await waitForReply(replyAfterRestart);
    assert.equal(opened.at(-1)?.sessionId, "fixture-session-1");
    const topic = "omt_child";
    const inherited = await send(group, "independent topic", { thread_id: topic });
    await waitForReply(inherited);
    assert.equal(opened.at(-1)?.sessionId, null);
    assert.equal((await read(group, topic)).json().effective.engineId, "fixture");
    assert.equal((await select(group, { engineId: "codex", model: null }, topic)).json().effective.model, "fixture-original-codex");
    const overridden = await send(group, "use Codex in this topic", { thread_id: topic });
    await overridden.started(); await f.complete(overridden.id);
    assert.equal(f.calls().filter(call => call.method === "turn/start").at(-1)?.params.model, "fixture-original-codex");
    assert.equal((await select(group, null, topic)).json().effective.engineId, "fixture");
    assert.equal((await select(direct, null)).json().effective.engineId, "codex");
    const restored = await send(direct, "continue original Codex conversation");
    assert.equal((await restored.started()).codex_session_id, oldDirect.row().codex_session_id);
    await f.complete(restored.id);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/messages/${dm.row().id}/retry`, headers })).statusCode, 409);
    assert.equal((await select(direct, { engineId: "another", model: null })).statusCode, 200);
    const resumedDirect = await send(direct, "continue the original external direct conversation");
    await waitForReply(resumedDirect);
    assert.equal(opened.at(-1)?.sessionId, "another-session-2");
  } finally { release?.(); await f.close(); }
});

test("topic engine routes are protected, isolated and persistent; live steering does not run a second prompt", async () => {
  const opened: Array<{ sessionId: string | null; model: string | null; policy: LarkExecutionPolicy }> = [];
  const prompts: string[] = [], steered: string[] = [];
  let complete: ((value: ExecutionTurnResult) => void) | undefined;
  let startSearch: (() => void) | undefined;
  const engine: ExecutionEngine = {
    descriptor: { id: "fixture", label: "Fixture", models: ["fixture-model", "fixture-next"] },
    supportsPolicy: policy => policy.trustScope === "trusted",
    async open({ sessionId, model, policy }) {
      opened.push({ sessionId, model, policy });
      return {
        id: sessionId ?? `fixture-session-${opened.length}`,
        run(text, signal, onEvent) {
          prompts.push(text);
          onEvent?.({ type: "text-delta", text: "Internal interim narrative" });
          onEvent?.({ type: "work", stage: "read" });
          startSearch = () => onEvent?.({ type: "work", stage: "search" });
          return new Promise(resolve => {
            complete = resolve;
            signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
          });
        },
        async steer(text) { steered.push(text); return "injected"; },
        close() {}
      };
    }
  };
  const f = fixture([engine]);
  const progressDelay = config.larkCodexInterimReplyDelayMs;
  try {
    const topicPath = "/v1/chats/oc_fixture/topics/omt_fixture/execution";
    const headers = { authorization: "Bearer fixture-token" };
    const select = (model: string) => f.runtime().app.inject({ method: "PUT", url: topicPath, headers, payload: { override: { engineId: "fixture", model } } });
    assert.equal((await f.runtime().app.inject({ url: topicPath })).statusCode, 401);
    const before = await f.message({ content: "private history not sent to the new engine" });
    assert.equal((await select("not-registered")).statusCode, 409);
    assert.equal((await select("fixture-model")).statusCode, 200);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: before.event })).statusCode, 401);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/messages/${before.row().id}/retry`, headers })).statusCode, 409);
    const outside = await f.message({ thread_id: "omt_other", root_id: "om_other", mentions: mention });
    await outside.started(); await f.complete(outside.id);
    assert.deepEqual(opened, []);
    await f.settings({ topicNativeModeEnabled: true }); await topicCommand(f, "join");
    const untrusted = await f.message({ sender_id: "ou_member", content: "must not reach the provider" });
    await until(() => untrusted.row().codex_status === "failed");
    assert.match(untrusted.row().codex_reply, /未启动任务/);
    assert.deepEqual(opened, []);
    config.larkCodexInterimReplyDelayMs = 30_000;
    await f.settings({ interimRepliesEnabled: true });
    const first = await f.message({ content: "start external turn" });
    await until(() => prompts.length === 1);
    const progress = (id = first.row().id) => f.runtime().store.db.prepare("SELECT state,entries_json,card_message_id FROM lark_progress_cards WHERE lark_message_id=?").get(id) as
      { state: string; entries_json: string; card_message_id: string | null } | undefined;
    await until(() => Boolean(progress()?.card_message_id), 12_000);
    assert.match(progress()!.entries_json, /正在读取资料/);
    assert.doesNotMatch(progress()!.entries_json, /Internal interim narrative/);
    const progressCardId = progress()!.card_message_id;
    startSearch!();
    startSearch!();
    assert.equal(progress()!.card_message_id, progressCardId);
    assert.deepEqual(JSON.parse(progress()!.entries_json).map((entry: { id: string }) => entry.id), ["work:read", "work:search"]);
    reconcileLarkProgressCards();
    assert.equal(progress()?.state, "running");
    assert.equal((await select("fixture-next")).statusCode, 409);
    const follow = await f.message({ content: "steer current external turn" });
    await until(() => follow.row().codex_status === "running");
    assert.deepEqual(steered, ["steer current external turn"]);
    assert.deepEqual(prompts, ["start external turn"]);
    const table = "## Fixture result\n\n| Name | Count |\n| --- | --- |\n| Example | 2 |";
    complete!({ status: "completed", text: table });
    await until(() => first.row().codex_status === "answered" && follow.row().codex_status === "answered");
    assert.equal(first.row().codex_session_id, null);
    assert.equal(first.row().codex_reply, table);
    const card = JSON.parse(first.row().reply_delivery_payload);
    assert.equal(card.msgType, "interactive");
    assert(card.content.body.elements.some((element: { tag: string }) => element.tag === "table"));
    assert.equal(follow.row().reply_status, "skipped");
    assert.equal(progress()?.state, "completed");
    await f.restart();
    assert.equal((await select("fixture-next")).statusCode, 200);
    const next = await f.message({ content: "continue after restart" });
    await until(() => prompts.length === 2);
    const policy = larkExecutionPolicy(f.root, true);
    assert.deepEqual(opened, [{ sessionId: null, model: "fixture-model", policy }, { sessionId: "fixture-session-1", model: "fixture-next", policy }]);
    const cancellation = await f.runtime().app.inject({ method: "POST", url: `${topicPath}/cancel`, headers });
    assert.deepEqual(cancellation.json(), { requested: 1 });
    await until(() => next.row().codex_status === "failed");
    assert.match(next.row().codex_reply, /已确认取消/);
    const moved = path.join(f.root, "new-workspace");
    fs.mkdirSync(moved);
    assert.equal((await f.settings({ workspaceRoot: moved })).statusCode, 200);
    const afterMove = await f.message({ content: "continue in the newly configured directory" });
    await until(() => prompts.length === 3);
    assert.deepEqual(opened.at(-1), { sessionId: null, model: "fixture-next", policy: larkExecutionPolicy(moved, true) });
    complete!({ status: "completed", text: "## New workspace\n\n**Ready**.\n\n- Checked" });
    await until(() => afterMove.row().codex_status === "answered");
    const post = JSON.parse(afterMove.row().reply_delivery_payload);
    assert.equal(post.msgType, "post");
    assert.match(JSON.stringify(post.content.zh_cn), /New workspace/);
    assert.equal(progress(afterMove.row().id), undefined);
    const cleared = await f.runtime().app.inject({ method: "PUT", url: topicPath, headers, payload: { override: null } });
    assert.equal(cleared.json().effective.engineId, "codex");
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/messages/${next.row().id}/retry`, headers })).statusCode, 409);
  } finally { config.larkCodexInterimReplyDelayMs = progressDelay; await f.close(); }
});

async function topicCommand(f: ReturnType<typeof fixture>, command: "join" | "leave", extra: Record<string, unknown> = {}) {
  const m = await f.message({ mentions: mention, content: `@_user_1 /topic ${command}`, ...extra });
  assert.equal(m.row().reply_trigger, "topic_command");
  assert.equal(m.row().codex_status, "skipped");
  assert.equal(m.row().reply_status, "sent");
  assert.match(m.row().reply_delivery_text, command === "join" ? /已开启本话题续聊/ : /已退出本话题续聊/);
  return m;
}

const restrictedApprovalCases = [
  ...(["dsh", "claude", "opencode", "agy"] as const).map(provider => ({ provider, automaticReview: false })),
  { provider: "dsh" as const, automaticReview: true }
];
for (const { provider, automaticReview } of restrictedApprovalCases) test(`restricted ACP opens a turn approval without a plan for ${provider} (${automaticReview ? "review" : "manual"})`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-approval-"));
  const launch = path.join(dir, "restricted.mjs"), trusted = path.join(dir, "trusted.mjs");
  const gate = path.join(dir, "allow-fixture"), log = path.join(dir, "outcomes.jsonl");
  fs.writeFileSync(trusted, "#!/bin/sh\nexit 91\n", { mode: 0o700 });
  const toolName = { dsh: "write", claude: "Write", opencode: "edit", agy: "write_to_file" }[provider];
  fs.writeFileSync(launch, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const provider=${JSON.stringify(provider)},toolName=${JSON.stringify(toolName)};
if((provider==="dsh"&&process.env.DSH_PERMISSION_MODE!=="read-only")
  ||(provider==="agy"&&!process.argv.includes("--sandbox"))||process.env.LARK_AGENT_RUNTIME_TOKEN)throw Error("incorrect launch policy");
const sessionId="fixture-restricted";
const send=x=>console.log(JSON.stringify({jsonrpc:"2.0",...x}));
const reply=(id,result)=>send({id,result});
const update=update=>send({method:"session/update",params:{sessionId,update}});
const decisions=new Map();
let prompt,timer,step=0;
const request=(id,callId,rawInput)=>send({id,method:"session/request_permission",params:{sessionId,toolCall:{toolCallId:callId,...(rawInput?{title:toolName,rawInput}:{})},
 options:[{optionId:"once",name:"Once",kind:"allow_once"},{optionId:"always",name:"Always",kind:"allow_always"}]}});
const next=()=>{
 if(step===5){update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture finished."}});reply(prompt,{stopReason:"end_turn"});return;}
 const callId=step===3?"call-1":"call-"+step;
 const file=step===1?"first.txt":step===2?"second.txt":step===4?"late.txt":"ignored.txt";
 const id=1000+step;
 if(step!==3)update({sessionUpdate:"tool_call",toolCallId:callId,
  title:provider==="dsh"?toolName:"Write a fixture file",
  ...(provider==="claude"?{_meta:{claudeCode:{toolName}}}:provider!=="dsh"?{name:toolName}:{}),
  kind:"edit",status:"in_progress",rawInput:{file_path:file,content:"fixture"}});
 decisions.set(id,step);
 request(id,callId,step===0?{file_path:"changed",content:"fixture"}:provider==="dsh"?undefined:{file_path:file,content:"fixture"});
};
createInterface({input:process.stdin}).on("line",l=>{
 const m=JSON.parse(l);
 if(m.method==="initialize")reply(m.id,{protocolVersion:1,agentInfo:{name:provider,version:"0.0.1"},agentCapabilities:{sessionCapabilities:{close:{},resume:{}}}});
 else if(m.method==="session/new"){
  if(provider==="claude"&&m.params._meta?.claudeCode?.options?.allowDangerouslySkipPermissions!==false)throw Error("Claude bypass not disabled");
  reply(m.id,{sessionId,modes:{currentModeId:"default",availableModes:[{id:"default",name:"Default"}]}});
 }
 else if(m.method==="session/prompt"){
  prompt=m.id;timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);next()}},15);
 }else if(m.method==="session/cancel"){
  clearInterval(timer);reply(prompt,{stopReason:"cancelled"});
 }else if(m.method==="session/close")reply(m.id,{});
 else if(decisions.has(m.id)){
  appendFileSync(${JSON.stringify(log)},JSON.stringify({step:decisions.get(m.id),option:m.result?.outcome?.optionId??null})+"\\n");
  decisions.delete(m.id);
  if(step<4){step++;next();}
 }
});`, { mode: 0o700 });
  const engine = createNativeAcpExecutionEngine(provider, { launcher: trusted, restrictedLauncher: launch, models: [] });
  const cards: Array<{ approvalId: number; originalMessage: string; taskPlan?: string }> = [];
  let reviews = 0;
  const f = fixture([engine], { turnApprovalReviewer: async () => { reviews++; return { decision: "manual", reason: "Fixture task requires review" }; }, approvalCardSender: (_who, card) => {
    cards.push({ approvalId: card.approvalId, originalMessage: card.originalMessage ?? "", taskPlan: card.taskPlan });
    return { ok: true, messageId: `om_card_${card.approvalId}` };
  }, approvalCardUpdater: () => {} });
  const headers = { authorization: "Bearer fixture-token" };
  const topic = "/v1/chats/oc_fixture/topics/omt_fixture/execution";
  const readDecisions = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  try {
    assert.throws(() => createNativeAcpExecutionEngine(provider, { launcher: trusted, restrictedLauncher: trusted, models: [] }), /distinct/);
    await f.settings({ turnAutoApprovalEnabled: automaticReview });
    assert.equal((await f.message({ content: "observe fixture topic before selecting an engine" })).row().codex_status, "skipped");
    assert.equal((await f.runtime().app.inject({ method: "PUT", url: topic, headers, payload: { override: { engineId: provider, model: null } } })).statusCode, 200);
    const message = await f.message({ sender_id: "ou_member", content: "Create two sample files", mentions: mention });
    await until(() => message.row().codex_status === "running" && Boolean(message.row().codex_turn_id));
    fs.writeFileSync(gate, "");
    await until(() => cards.length === 1);
    assert.deepEqual(readDecisions(), [{ step: 0, option: null }]);
    assert.equal(cards[0].originalMessage, "Create two sample files");
    assert.equal(cards[0].taskPlan, undefined);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/approvals/${cards[0].approvalId}/approve`, headers })).statusCode, 409);
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/approvals/${cards[0].approvalId}/approve-turn`, headers })).statusCode, 200);
    await until(() => readDecisions().length === 5);
    const decisions = [{ step: 0, option: null }, { step: 1, option: "once" }, { step: 2, option: "once" }, { step: 3, option: null }];
    assert.deepEqual(readDecisions(), [...decisions, { step: 4, option: "once" }]);
    assert.equal(cards.length, 1);
    assert.equal(reviews, automaticReview ? 1 : 0);
    assert.deepEqual((await f.runtime().app.inject({ method: "POST", url: topic+"/cancel", headers })).json(), { requested: 1 });
    await until(() => message.row().codex_status === "failed");
    assert.equal((await f.runtime().app.inject({ method: "POST", url: `/v1/approvals/${cards[0].approvalId}/approve-turn`, headers })).statusCode, 409);
  } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("restricted Claude refuses an unsafe startup mode and stops on an unsafe runtime mode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-mode-fence-"));
  try {
    const trusted = path.join(root, "trusted");
    fs.writeFileSync(trusted, "#!/bin/sh\nexit 91\n", { mode: 0o700 });
    for (const mode of ["bypassPermissions", "default"]) {
      const restricted = path.join(root, `restricted-${mode}.mjs`);
      fs.writeFileSync(restricted, `#!${process.execPath}
import { createInterface } from "node:readline";
const send = value => console.log(JSON.stringify({jsonrpc:"2.0",...value}));
const mode = ${JSON.stringify(mode)};
createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="initialize")send({id:m.id,result:{protocolVersion:1,agentInfo:{name:"claude",version:"0.108.1"}}});
 else if(m.method==="session/new")send({id:m.id,result:{sessionId:"fixture",modes:{currentModeId:mode,availableModes:[{id:mode,name:mode}]}}});
 else if(m.method==="session/prompt"){
   send({method:"session/update",params:{sessionId:"fixture",update:{sessionUpdate:"current_mode_update",currentModeId:"acceptEdits"}}});
   send({id:m.id,result:{stopReason:"end_turn"}});
 }
});`, { mode: 0o700 });
      const engine = createNativeAcpExecutionEngine("claude", { launcher: trusted, restrictedLauncher: restricted, models: [] });
      const open = engine.open({ sessionId: null, model: null, policy: larkExecutionPolicy(root, false), signal: new AbortController().signal,
        authorizeNative: async () => assert.fail("mode changes must not be treated as tool approvals") });
      if (mode === "bypassPermissions") await assert.rejects(open, /did not confirm the restricted permission mode/);
      else {
        const session = await open;
        try { await assert.rejects(session.run("test", new AbortController().signal)); }
        finally { await session.close(); }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude, DSH, OpenCode and AGY share the Lark workflow over ACP stdio", async () => {
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lark-native-acp-"));
  const launcher = path.join(launcherRoot, "peer.mjs"), log = path.join(launcherRoot, "methods.jsonl");
  fs.writeFileSync(launcher, `#!${process.execPath}
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2);
const engine=JSON.stringify(args)===JSON.stringify(['--profile','acp'])?'dsh':
  JSON.stringify(args)===JSON.stringify(['acp','--disable-telemetry'])?'agy':
  JSON.stringify(args)===JSON.stringify(['acp'])?'opencode':args.length===0?'claude':null;
if(!engine || process.env.LARK_AGENT_RUNTIME_TOKEN || process.env.LARK_AGENT_MCP_TOKEN) throw Error('Invalid launcher environment');
const id='session-'+engine;
const send=body=>console.log(JSON.stringify({jsonrpc:'2.0',...body}));
const respond=(id,result)=>send({id,result});
const update=value=>send({method:'session/update',params:{sessionId:id,update:value}});
const chunk=(text,messageId,annotations)=>update({sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text,annotations}});
const config=model=>[{id:'provider-model',name:'Model',category:'model',type:'select',currentValue:model,options:[{value:model,name:model}]}];
let currentPrompt,gate;
createInterface({input:process.stdin}).on('line',line=>{
 const {id:rpc,method,params,result}=JSON.parse(line);
 if(method) appendFileSync(${JSON.stringify(log)}, JSON.stringify({engine,method,model:params?.value})+'\\n');
 if(method==='initialize'){
  if(!params.clientCapabilities.session.notices)throw Error('Notices would leak into transcript');
  respond(rpc,{protocolVersion:1,agentInfo:{name:engine,version:'0.108.1'},agentCapabilities:{
   ...(engine==='dsh'?{}:{loadSession:true}),sessionCapabilities:{resume:{},close:{}}},_meta:{steering:{supported:engine!=='claude'}}});
 }else if(method==='session/new'||method==='session/resume'||method==='session/load'){
  if(realpathSync(params.cwd)!==process.cwd()||params.mcpServers.map(server=>server.name).join(',')!=='lark_tools,lark_stickers'
    ||params.mcpServers.some(server=>server.env.some(item=>item.name==='LARK_AGENT_RUNTIME_TOKEN')))throw Error('Shared workspace or MCP missing');
  if(method!=='session/new'&&params.sessionId!==id)throw Error('Wrong saved conversation');
  if(method!=='session/new')chunk('Old transcript', 'replay');
  respond(rpc,{...(method==='session/new'?{sessionId:id}:{}),configOptions:config('default')});
 }else if(method==='session/set_config_option'){
  if(params.sessionId!==id||params.configId!=='provider-model')throw Error('Wrong model selector');
  respond(rpc,{configOptions:config(params.value)});
 }else if(method==='session/prompt'){
  const text=params.prompt[0].text;
  if(params.sessionId!==id)throw Error('Prompt addressed to wrong session');
  if(text.includes('cancel fixture')){currentPrompt=rpc;return;}
  if(text.includes('short fixture')){
   chunk('**Short answer**','short');respond(rpc,{stopReason:'end_turn'});return;
  }
  currentPrompt=rpc;
  chunk('Internal preliminary commentary','preface');
  update({sessionUpdate:'tool_call',toolCallId:'read-1',kind:'read',title:'Private tool details'});
  if(engine==='opencode')send({id:98,method:'session/request_permission',params:{sessionId:id,toolCall:{toolCallId:'child-read',_meta:{'opencode/child-session':{id:'child'}}},options:[{optionId:'once',kind:'allow_once',name:'Once'}]}});
  send({id:97,method:'session/request_permission',params:{sessionId:id,toolCall:{toolCallId:'read-1'},options:[
   {optionId:'permanent',kind:'allow_always',name:'Always'},{optionId:'once',kind:'allow_once',name:'Once'}]}});
 }else if(rpc===98){
  if(result.outcome?.outcome!=='cancelled')throw Error('Unexpected child authorization');
 }else if(rpc===97){
  if(result.outcome?.optionId!=='once')throw Error('Unexpected authorization');
  gate=setInterval(()=>{
   if(!existsSync(${JSON.stringify(launcherRoot)}+'/'+engine+'-finish'))return;
   clearInterval(gate);
   update({sessionUpdate:'notice',severity:'warning',title:'Adapter diagnostic'});
   chunk('Private assistant-only detail','private',['assistant']);
   chunk('| Value | Count |\\n| --- | --- |\\n| Fixture | ','answer');
   chunk('2 |','answer');
   if(engine==='opencode')update({sessionUpdate:'agent_message_chunk',messageId:'child-answer',content:{type:'text',text:'Private child output'},_meta:{'opencode/child-session':{id:'child'}}});
   respond(currentPrompt,{stopReason:'end_turn'});
  },20);
 }else if(method==='session/cancel'){
  clearInterval(gate);respond(currentPrompt,{stopReason:'cancelled'});
 }else if(method==='session/close'){
  respond(rpc,{});
 }else if(method){
  throw Error('Unexpected ACP method '+method);
 }
});`, { mode: 0o700 });
  const ids = ["claude", "dsh", "opencode", "agy"];
  const env = Object.fromEntries(ids.flatMap(id => [
    [`LARK_AGENT_${id.toUpperCase()}_ACP_NATIVE_LAUNCHER`, launcher],
    [`LARK_AGENT_${id.toUpperCase()}_ACP_MODELS`, " fixture-model,fixture-model "]
  ]));
  const failures: string[] = [];
  configuredNativeAcpEngines({ ...env, LARK_AGENT_CLAUDE_ACP_NATIVE_LAUNCHER: "invalid-relative-launcher" }, id => failures.push(id));
  assert.deepEqual(configuredNativeAcpEngines({}, () => assert.fail("unexpected enabled engine")), []);
  assert.deepEqual(failures, ["claude"]);
  const engines = configuredNativeAcpEngines(env, id => assert.fail(`unexpected invalid launcher for ${id}`));
  assert.deepEqual(engines.map(e => [e.descriptor.id, e.descriptor.models]), ids.map(id => [id, ["fixture-model"]]));
  const f = fixture(engines);
  const delay = config.larkCodexInterimReplyDelayMs;
  const oldToken = process.env.LARK_AGENT_RUNTIME_TOKEN;
  process.env.LARK_AGENT_RUNTIME_TOKEN = "host-token-not-for-engine";
  const headers = { authorization: "Bearer fixture-token" };
  const topic = "/v1/chats/oc_fixture/topics/omt_fixture/execution";
  const methods = (engine: string): Array<{ method: string; model?: string }> => fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.engine === engine) : [];
  const progress = (id: number) => f.runtime().store.db.prepare("SELECT state,entries_json FROM lark_progress_cards WHERE lark_message_id=?").get(id) as
    { state: string; entries_json: string } | undefined;
  try {
    await f.settings({ topicNativeModeEnabled: true, interimRepliesEnabled: true });
    await topicCommand(f, "join");
    config.larkCodexInterimReplyDelayMs = 100;
    for (const id of ids) {
      const route = await f.runtime().app.inject({ method: "PUT", url: topic, headers, payload: { override: { engineId: id, model: "fixture-model" } } });
      assert.equal(route.statusCode, 200, route.body);
      assert.deepEqual(route.json().effective, { engineId: id, model: "fixture-model" });
      const denied = await f.message({ sender_id: "ou_member", content: "untrusted fixture" });
      await until(() => denied.row().codex_status === "failed");
      assert.equal(methods(id).length, 0, `${id} started an untrusted engine`);
      const first = await f.message({ content: "use fixture tool" });
      await until(() => progress(first.row().id)?.state === "running");
      assert.match(progress(first.row().id)!.entries_json, /正在读取资料/);
      assert.doesNotMatch(progress(first.row().id)!.entries_json, /Private|Internal/);
      const follow = await f.message({ content: "short fixture" });
      assert.equal(methods(id).filter(row => row.method === "session/prompt").length, 1);
      fs.writeFileSync(path.join(launcherRoot, `${id}-finish`), "");
      await until(() => follow.row().reply_status === "sent");
      assert.equal(progress(first.row().id)?.state, "completed");
      assert.equal(progress(follow.row().id), undefined);
      assert.equal(first.row().codex_reply, "| Value | Count |\n| --- | --- |\n| Fixture | 2 |");
      assert.equal(JSON.parse(first.row().reply_delivery_payload).msgType, "interactive");
      assert.equal(follow.row().codex_reply, "**Short answer**");
      assert.equal(JSON.parse(follow.row().reply_delivery_payload).msgType, "post");
      const cancelled = await f.message({ content: "cancel fixture" });
      await until(() => methods(id).filter(row => row.method === "session/prompt").length === 3);
      assert.deepEqual((await f.runtime().app.inject({ method: "POST", url: topic+"/cancel", headers })).json(), { requested: 1 });
      await until(() => cancelled.row().codex_status === "failed");
      assert.match(cancelled.row().codex_reply, /已确认取消/);
      const events = methods(id);
      assert.equal(events.filter(row => row.method === "session/new").length, 1);
      assert.equal(events.filter(row => row.method === "session/resume").length, id === "claude" ? 0 : 2);
      assert.equal(events.filter(row => row.method === "session/load").length, id === "claude" ? 2 : 0);
      assert.equal(events.filter(row => row.method === "session/close").length, id === "claude" ? 0 : 3);
      assert.equal(events.filter(row => row.model === "fixture-model").length, 3);
      assert(!events.some(row => row.method === "_session/steering"));
    }
  } finally {
    config.larkCodexInterimReplyDelayMs = delay;
    if (oldToken === undefined) delete process.env.LARK_AGENT_RUNTIME_TOKEN;
    else process.env.LARK_AGENT_RUNTIME_TOKEN = oldToken;
    await f.close();
    fs.rmSync(launcherRoot, { recursive: true, force: true });
  }
});

test("off retains ordinary mentions; turning on does not enroll historical or newly mentioned topics", async () => {
  const f = fixture(); try {
    assert.equal((await f.runtime().app.inject({ url: "/v1/settings" })).json().topicNativeModeEnabled, false);
    const disabled = await f.message({ mentions: mention, content: "/topic join" });
    assert.match(disabled.row().reply_delivery_text, /全局关闭/);
    assert.equal(disabled.row().codex_status, "skipped");
    const skipped = await f.message(); assert.equal(skipped.row().codex_status, "skipped");
    const first = await f.message({ mentions: mention }); await first.started(); await f.complete(first.id);
    assert.equal((await f.message()).row().codex_status, "skipped");
    assert.equal((await f.settings({ topicNativeModeEnabled: true })).statusCode, 200);
    assert.equal((await f.message()).row().codex_status, "skipped");
    const ordinary = await f.message({ mentions: mention }); await ordinary.started(); await f.complete(ordinary.id);
    assert.equal(ordinary.row().reply_trigger, "mention");
    assert.equal((await f.message()).row().codex_status, "skipped");
    assert.equal(f.calls().filter(c => c.method === "turn/start").length, 2);
  } finally { await f.close(); }
});

test("enrolled topic resumes native thread with compact deltas, citations, attachments and no echoed native answers", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    await topicCommand(f, "join");
    assert.equal(f.calls().length, 0);
    const first = await f.message({ content: "investigate the fixture" }); await first.started(); await f.complete(first.id, "previous native answer");
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

test("explicit enrollment survives restart but off/on requires a new join and never replays old input", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    await topicCommand(f, "join");
    const first = await f.message(); await first.started(); await f.complete(first.id);
    await f.restart(); assert(isNativeTopicConversation(first.row()));
    const next = await f.message(); await next.started(); await f.complete(next.id);
    await f.settings({ topicNativeModeEnabled: false });
    const snapshot = { ...next.row() };
    await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: next.event });
    assert.deepEqual(next.row(), snapshot);
    assert.equal((await f.message()).row().codex_status, "skipped");
    await f.settings({ topicNativeModeEnabled: true });
    assert.equal((await f.message()).row().codex_status, "skipped");
    await topicCommand(f, "join");
    const resumed = await f.message(); await resumed.started(); await f.complete(resumed.id);
    assert.equal(resumed.row().codex_session_id, first.row().codex_session_id);
  } finally { await f.close(); }
});

test("compact topic turns refresh persona, approval and media guidance after changes and native compaction", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    await topicCommand(f, "join", { sender_id: "ou_member" });
    const first = await f.message({ sender_id: "ou_member" }); await first.started(); await f.complete(first.id);
    saveConversationPersona("oc_fixture", { mode: "custom", name: "Fixture", instructions: "Use the updated fixture persona." });
    await f.settings({ stickerUsageMode: "always" });
    const next = await f.message({ sender_id: "ou_member" }); await next.started();
    const prompt = fs.readFileSync(path.join(next.row().codex_task_dir, "prompt.md"), "utf8");
    assert.match(prompt, /updated fixture persona/); assert.match(prompt, /受限模式工具调用/);
    assert.match(prompt, /history_images_search/); assert.match(prompt, /attach_files/); assert.match(prompt, /表情包（每次回复）/);
    await f.complete(next.id);
    await codexAppServer.request("fixture/emit", { notifications: [{ method: "thread/compacted", params: { threadId: next.row().codex_session_id } }] });
    const after = await f.message({ sender_id: "ou_member" }); await after.started();
    const refreshed = fs.readFileSync(path.join(after.row().codex_task_dir, "prompt.md"), "utf8");
    assert.match(refreshed, /updated fixture persona/); assert.match(refreshed, /受限模式工具调用/); assert.match(refreshed, /history_images_search/);
    await f.complete(after.id);
  } finally { await f.close(); }
});

test("legacy enrollment is ignored; commands are scoped and redelivery does not change state", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    const epoch = f.runtime().store.setting("topicNativeModeEpoch", "");
    assert(epoch);
    const legacy = JSON.stringify({ epoch, enabled: true, revision: 1 });
    setAppSettingValue('topicNativeEnrollment:["oc_fixture","thread","omt_fixture"]', legacy);
    setAppSettingValue('topicNativeEnrollment:["oc_fixture","root","om_root"]', legacy);
    const outside = await f.message({ thread_id: null, root_id: null, mentions: mention, content: "/topic join" });
    assert.match(outside.row().reply_delivery_text, /请在飞书话题内使用/);
    assert.equal((await f.message()).row().codex_status, "skipped");
    assert.equal((await f.message({ content: "/topic join" })).row().codex_status, "skipped");
    const join = await topicCommand(f, "join");
    assert.equal(claimLarkCodexReply(join.row().id), false);
    assert.equal((await f.message({ thread_id: "omt_other" })).row().codex_status, "skipped");
    const first = await f.message(); await first.started(); await f.complete(first.id);
    const leave = await topicCommand(f, "leave");
    await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: join.event });
    assert.equal((await f.message()).row().codex_status, "skipped");
    const ordinary = await f.message({ mentions: mention }); await ordinary.started(); await f.complete(ordinary.id);
    assert.equal((await f.message()).row().codex_status, "skipped");
    await topicCommand(f, "join", { content: '<at user_id="ou_bot">Bot</at> /topic join' });
    await f.runtime().app.inject({ method: "POST", url: "/v1/messages", payload: leave.event });
    const resumed = await f.message(); await resumed.started(); await f.complete(resumed.id);
    assert.equal(resumed.row().codex_session_id, first.row().codex_session_id);
    assert.equal(f.runtime().store.db.prepare("SELECT COUNT(*) FROM lark_messages WHERE direction='outbound' AND reply_to_message_id=?").pluck().get(join.id), 1);
  } finally { await f.close(); }
});

test("leaving while native lookup is in flight skips an unaccepted automatic follow-up", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    await topicCommand(f, "join");
    const first = await f.message(); await first.started(); await f.complete(first.id);
    f.holdLookup(); const previous = f.calls().filter(c => c.method === "thread/loaded/list").length;
    const next = await f.message(); await until(() => f.calls().filter(c => c.method === "thread/loaded/list").length > previous);
    await topicCommand(f, "leave"); await f.releaseLookup();
    await until(() => next.row().codex_status === "skipped");
    assert.equal(next.row().reply_status, "skipped");
    assert.equal(f.calls().filter(c => c.method === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("topic continuation preserves trust separation, bot exclusion, unrelated topics, privacy and owner-assist routing", async () => {
  const f = fixture(); try {
    await f.settings({ topicNativeModeEnabled: true });
    await topicCommand(f, "join");
    const first = await f.message(); await first.started(); await f.complete(first.id);
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
