import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeExecutionEngine } from "./claudeExecutionEngine.js";
import type { ExecutionEngineSession } from "./executionEngines.js";

test("Claude ACP adapter restores its session, verifies model, denies permission, and injects or cancels", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lark-claude-acp-"));
  const launcher = path.join(cwd, "fixture.mjs");
  fs.writeFileSync(launcher, `#!${process.execPath}
import { createInterface } from 'node:readline';
const write = m => console.log(JSON.stringify({jsonrpc:'2.0', ...m}));
const result = (id, data) => write({id, result:data});
const config = currentValue => [{id:'model', category:'model', name:'Model', type:'select',
 currentValue, options:[{value:'fixture',name:'Fixture'},{value:'default',name:'Default'}]}];
let pending;
createInterface({input:process.stdin}).on('line', line => {
 const {id,method,params,...response} = JSON.parse(line);
 if(method==='initialize') result(id,{protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'fixture',version:'0.108.1'},_meta:{steering:{supported:true}}});
 if(method==='session/new') result(id,{sessionId:'fixture-session',configOptions:config('default')});
 if(method==='session/load') {
   if(params.sessionId!=='fixture-session') throw Error('wrong resume id');
   result(id,{configOptions:config('default')});
 }
 if(method==='session/set_config_option') result(id,{configOptions:config(params.value)});
 if(method==='session/prompt') {
  pending=id;
  write({id:999,method:'session/request_permission',params:{sessionId:params.sessionId,
   toolCall:{toolCallId:'fixture',title:'Synthetic request'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});
 }
 if(id===999 && response.result?.outcome?.outcome==='cancelled') {
   write({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'permission denied'} } } });
 }
 if(method==='_session/steering') {
  if(params._meta?.steering?.idleBehavior!=='promptRequired') throw Error('unsafe idle fallback');
  if(pending===undefined) result(id,{outcome:'promptRequired'});
  else {
   result(id,{outcome:'injected'});
   result(pending,{stopReason:'end_turn'});pending=undefined;
  }
 }
 if(method==='session/cancel' && pending!==undefined) { result(pending,{stopReason:'cancelled'});pending=undefined; }
});
`, { mode: 0o700 });
  const controller = new AbortController();
  const engine = createClaudeExecutionEngine({ launcher, cwd, models: ["fixture"] });
  let session: ExecutionEngineSession | undefined;
  const deadline = setTimeout(() => session?.close(), 6_000);
  try {
    session = await engine.open({ sessionId: null, model: "fixture", signal: controller.signal });
    let streamed!: () => void;
    const chunk = new Promise<void>(resolve => { streamed = resolve; });
    const run = session.run("test prompt", controller.signal, () => streamed());
    await Promise.race([chunk, run.then(() => { throw new Error("Expected a live streamed update"); })]);
    assert.equal(await session.steer?.("follow-up", controller.signal), "injected");
    assert.deepEqual(await run, { status: "completed", text: "permission denied" });
    assert.equal(await session.steer?.("late follow-up", controller.signal), "idle");
    const sessionId = session.id;
    session.close();
    session = await engine.open({ sessionId, model: null, signal: controller.signal });
    const cancelled = session.run("cancel this", controller.signal);
    controller.abort();
    assert.deepEqual(await cancelled, { status: "cancelled" });
  } finally {
    clearTimeout(deadline);
    session?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
