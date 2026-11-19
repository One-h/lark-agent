import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeExecutionEngine } from "./claudeExecutionEngine.js";
import { larkExecutionPolicy, type ExecutionEngineEvent, type ExecutionEngineSession } from "./executionEngines.js";

test("Claude uses the shared workspace and permits only the active trusted turn's single requests", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lark-claude-acp-"));
  const launcher = path.join(cwd, "fixture.mjs");
  fs.writeFileSync(launcher, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
if(process.env.LARK_AGENT_RUNTIME_TOKEN) throw Error('forwarded a host token');
if(process.env.LARK_AGENT_MCP_TOKEN) throw Error('MCP token must not be inherited by the engine shell');
const write = m => console.log(JSON.stringify({jsonrpc:'2.0', ...m}));
const result = (id, data) => write({id, result:data});
const config = currentValue => [{id:'model', category:'model', name:'Model', type:'select',
 currentValue, options:[{value:'fixture',name:'Fixture'},{value:'default',name:'Default'}]}];
const once={optionId:'allow',name:'Allow',kind:'allow_once'};
const permanent={optionId:'always',name:'Always',kind:'allow_always'};
const permission=(id,sessionId,options)=>write({id,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'fixture'},options}});
const update=(update,sessionId='fixture-session')=>write({method:'session/update',params:{sessionId,update}});
const text=(text,messageId,_meta)=>update({sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text},_meta});
let pending, initial, late, verified=0;
const verifyMcp = servers => {
 if(servers.length!==1||servers[0].name!=='lark_tools'||servers[0].env[0]?.name!=='LARK_AGENT_MCP_TOKEN') throw Error('shared MCP not configured');
};
createInterface({input:process.stdin}).on('line', line => {
 const {id,method,params,...response} = JSON.parse(line);
 if(method==='initialize') {
   if(!params.clientCapabilities.session?.notices) throw Error('notices must not be folded into messages');
   result(id,{protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'fixture',version:'0.108.1'},_meta:{steering:{supported:true}}});
 }
 if(method==='session/new') {
   if(realpathSync(params.cwd)!==process.cwd()) throw Error('unexpected workspace');
   verifyMcp(params.mcpServers);
   initial=id;
   permission(997,'fixture-session',[once]);
 }
 if(id===997) {
   if(response.result?.outcome?.outcome!=='cancelled') throw Error('granted before active turn');
   result(initial,{sessionId:'fixture-session',configOptions:config('default')});
 }
 if(method==='session/load') {
   if(params.sessionId!=='fixture-session') throw Error('wrong resume id');
   verifyMcp(params.mcpServers);
   result(id,{configOptions:config('default')});
 }
 if(method==='session/set_config_option') result(id,{configOptions:config(params.value)});
 if(method==='session/prompt') {
  if(params.prompt[0].text==='legacy fixture') {
    text('Reading first.');
    update({sessionUpdate:'tool_call',toolCallId:'legacy-read',kind:'read'});
    text('A short ');
    text('answer without IDs.');
    result(id,{stopReason:'end_turn'});
    return;
  }
  pending=id;
  permission(999,params.sessionId,[permanent,once]);
  permission(998,params.sessionId,[permanent]);
  permission(995,'different-session',[once]);
 }
 if([999,998,995].includes(id) && !method && pending!==undefined) {
   const out=response.result?.outcome;
   if(id===999 ? out?.outcome!=='selected'||out?.optionId!=='allow' : out?.outcome!=='cancelled') throw Error('incorrect permission decision');
   if(++verified===3) {
     update({sessionUpdate:'notice',severity:'warning',title:'Internal adapter warning'});
     text('I will look first.', 'preface');
     update({sessionUpdate:'tool_call',toolCallId:'test-read',kind:'read',status:'in_progress',title:'private file name',rawInput:{path:'/local/private'}});
     text('**Final', 'answer');
     text('late preface', 'preface');
     text('fallback warning', undefined, {claudeCode:{kind:'informational',level:'warning'}});
     text('subagent text', 'child', {claudeCode:{parentToolUseId:'child-tool'}});
     update({sessionUpdate:'tool_call_update',toolCallId:'test-read',status:'completed',rawOutput:'private tool output'});
     text(' answer**', 'answer');
     update({sessionUpdate:'notice',severity:'info',title:'Trailing adapter notice'});
   }
 }
 if(method==='_session/steering') {
  if(params._meta?.steering?.idleBehavior!=='promptRequired') throw Error('unsafe idle fallback');
  if(pending===undefined) { late=id; permission(996,'fixture-session',[once]); }
  else {
   result(id,{outcome:'injected'});
   result(pending,{stopReason:'end_turn'});pending=undefined;
  }
 }
 if(id===996) {
   if(response.result?.outcome?.outcome!=='cancelled') throw Error('granted after the turn');
   result(late,{outcome:'promptRequired'});
 }
 if(method==='session/cancel' && pending!==undefined) { result(pending,{stopReason:'cancelled'});pending=undefined; }
});
`, { mode: 0o700 });
  const controller = new AbortController();
  const engine = createClaudeExecutionEngine({ launcher, models: ["fixture"] });
  const policy = larkExecutionPolicy(cwd, true);
  const previousToken = process.env.LARK_AGENT_RUNTIME_TOKEN;
  const previousMcp = process.env.LARK_AGENT_MCP_TOKEN;
  process.env.LARK_AGENT_RUNTIME_TOKEN = "fixture-host-token";
  process.env.LARK_AGENT_MCP_TOKEN = "fixture-mcp-token";
  const mcpServers = [{ name: "lark_tools", command: process.execPath, args: ["fixture"], env: [{ name: "LARK_AGENT_MCP_TOKEN", value: "fixture-mcp-token" }] }];
  let session: ExecutionEngineSession | undefined;
  const deadline = setTimeout(() => session?.close(), 6_000);
  try {
    await assert.rejects(engine.open({ sessionId: null, model: null, policy: larkExecutionPolicy(cwd, false), signal: controller.signal }), /execution policy/);
    session = await engine.open({ sessionId: null, model: "fixture", policy, signal: controller.signal, mcpServers });
    let streamed!: () => void;
    const chunk = new Promise<void>(resolve => { streamed = resolve; });
    const events: ExecutionEngineEvent[] = [];
    const run = session.run("test prompt", controller.signal, event => { events.push(event); if (events.length === 4) streamed(); });
    await Promise.race([chunk, run.then(() => { throw new Error("Expected a live streamed update"); })]);
    assert.equal(await session.steer?.("follow-up", controller.signal), "injected");
    assert.deepEqual(await run, { status: "completed", text: "**Final answer**" });
    assert.deepEqual(events, [
      { type: "text-delta", text: "I will look first." }, { type: "work", stage: "read" },
      { type: "text-delta", text: "**Final" }, { type: "text-delta", text: " answer**" }
    ]);
    assert.equal(await session.steer?.("late follow-up", controller.signal), "idle");
    assert.deepEqual(await session.run("legacy fixture", controller.signal),
      { status: "completed", text: "A short answer without IDs." });
    const sessionId = session.id;
    session.close();
    session = await engine.open({ sessionId, model: null, policy, signal: controller.signal, mcpServers });
    const cancelled = session.run("cancel this", controller.signal);
    controller.abort();
    assert.deepEqual(await cancelled, { status: "cancelled" });
  } finally {
    clearTimeout(deadline);
    session?.close();
    if (previousToken === undefined) delete process.env.LARK_AGENT_RUNTIME_TOKEN;
    else process.env.LARK_AGENT_RUNTIME_TOKEN = previousToken;
    if (previousMcp === undefined) delete process.env.LARK_AGENT_MCP_TOKEN;
    else process.env.LARK_AGENT_MCP_TOKEN = previousMcp;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
