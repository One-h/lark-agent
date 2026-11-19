import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideLarkExecutionApprovalFromCard, enqueueLarkCodexReply, setAppSettingValue } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("read-only query command approvals use the same automatic and manual routing in private and group chats", async () => {
  for (const scenario of [{ chatType: "p2p", manual: false }, { chatType: "group", manual: false }, { chatType: "group", manual: true }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-query-approval-"));
    const executable = path.join(root, "codex.mjs"), log = path.join(root, "rpc.jsonl"), result = path.join(root, "decision.json");
    fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";import fs from "node:fs";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+"\\n");
 if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"query-thread"}}});
 else if(m.method==="turn/start"){
  send({id:m.id,result:{turn:{id:"query-turn",status:"inProgress"}}});
  setTimeout(()=>send({id:"query-approval",method:"item/commandExecution/requestApproval",params:{threadId:"query-thread",turnId:"query-turn",itemId:"query",command:"python3 query-readonly.py check",cwd:${JSON.stringify(root)},reason:"Read-only query requires network and system credentials"}}),20);
 }else if(m.method)send({id:m.id,result:{}});
 else if(m.id==="query-approval"){
  fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({decision:m.result?.decision}));
  send({method:"item/completed",params:{threadId:"query-thread",turnId:"query-turn",item:{type:"commandExecution",id:"query",status:m.result?.decision==="accept"?"completed":"declined"}}});
  const item={type:"agentMessage",id:"answer",phase:"final_answer",text:m.result?.decision==="accept"?"模拟查询完成":"未获授权，未执行查询"};
  send({method:"item/completed",params:{threadId:"query-thread",turnId:"query-turn",item}});
  send({method:"turn/completed",params:{threadId:"query-thread",turn:{id:"query-turn",status:"completed",items:[item]}}});
 }
});`);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(root, "lark-cli"), '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"message_id":"om_fixture_card"}}\'\n', { mode: 0o755 });
    const previousExecutable = process.env.CODEX_EXECUTABLE, previousPath = process.env.PATH;
    process.env.CODEX_EXECUTABLE = executable; process.env.PATH = `${root}:${previousPath ?? ""}`;
    let reviews = 0;
    const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [], approverId: "ou_owner",
      turnApprovalReviewer: async input => {
        reviews++;
        assert.equal(input.operationIntent, "Read-only query requires network and system credentials");
        assert.match(input.operation, /python3 query-readonly\.py check/);
        return { decision: scenario.manual ? "manual" : "approve_turn", reason: "fixture query review" };
      },
      textReplySender: () => ({ ok: true, messageId: "om_fixture_reply", chatId: "oc_query", messageAt: new Date().toISOString(), messageType: "text" }) });
    try {
      await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true, executionReceiptsEnabled: false, interimRepliesEnabled: false } });
      const now = new Date().toISOString();
      runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
        VALUES(1,'om_query','oc_query',?,'ou_sender','text','查询每日分布',1,?,'skipped','failed','{}',?,?)`)
        .run(scenario.chatType, scenario.chatType === "p2p" ? "p2p" : "mention", now, now);
      assert.equal(enqueueLarkCodexReply(1), true);
      let status = "";
      for (let i = 0; i < 160; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const pending = runtime.store.db.prepare("SELECT token,card_message_id FROM lark_execution_approvals WHERE status='pending' AND card_message_id IS NOT NULL LIMIT 1").get() as { token: string; card_message_id: string } | undefined;
        if (pending) {
          assert.equal(scenario.manual, true);
          assert.equal(decideLarkExecutionApprovalFromCard({ token: pending.token, decision: "reject", operatorId: "ou_owner", messageId: pending.card_message_id }).ok, true);
        }
        status = (runtime.store.db.prepare("SELECT codex_status FROM lark_messages WHERE id=1").get() as { codex_status: string }).codex_status;
        if (["answered", "no_reply", "failed"].includes(status)) break;
      }
      assert.notEqual(status, "failed"); assert.notEqual(status, "running"); assert.equal(reviews, 1);
      assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).decision, scenario.manual ? "decline" : "accept");
      const audit = runtime.store.db.prepare("SELECT source,decision,applied_at FROM lark_turn_auto_reviews").get() as { source: string; decision: string; applied_at: string | null };
      assert.equal(audit.source, "model");
      assert.equal(audit.decision, scenario.manual ? "manual" : "approved");
      assert.equal(Boolean(audit.applied_at), !scenario.manual);
      const task=runtime.store.db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id=1").get() as {codex_task_dir:string};
      const events=fs.readFileSync(path.join(task.codex_task_dir,"codex.stdout.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line))
        .filter(event=>event.method==="approval/decision").map(event=>event.params);
      if(scenario.manual){
        assert(events.some(e=>e.source==="auto_review"&&e.outcome==="pending"&&e.reasonCode==="review_requires_manual"));
        assert(events.some(e=>e.source==="manual"&&e.outcome==="declined"&&e.reasonCode==="human_rejected"));
        assert(!events.some(e=>e.source==="auto_review"&&e.outcome==="rejected"));
      }else assert(events.some(e=>e.source==="auto_review"&&e.outcome==="approved"&&e.reviewId));
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const thread = calls.find(call => call.method === "thread/start").params;
      assert.equal(thread.sandbox, "read-only"); assert.equal(thread.approvalPolicy, "on-request");
      assert.match(JSON.stringify(calls.find(call => call.method === "turn/start").params.input), /只读查询执行授权/);
    } finally {
      await runtime.app.close(); runtime.stop();
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousExecutable;
      process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("approved plans reuse only their listed steps in the same turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-command-auto-"));
  const executable = path.join(root, "codex.mjs");
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value)+"\\n");
let number = 0; let turn = "";
function approve(step) { send({id:"approval-"+turn+"-"+step, method:"item/commandExecution/requestApproval",params:{threadId:"thread-test",turnId:turn,itemId:"cmd-"+step,command:"node scripts/record-task.mjs review",cwd:${JSON.stringify(root)},reason:"record PR review"}}); }
function plan() { send({id:"plan-"+turn,method:"item/tool/call",params:{threadId:"thread-test",turnId:turn,tool:"lark_approval_plan",arguments:{
 goal:"Review the requested PR",impact:"Update local review records only",steps:[1,2].map(i=>({intent:"Record review phase "+i,effect:"local-write",kind:"command",operation:"node scripts/record-task.mjs review",cwd:${JSON.stringify(root)}}))}}}); }
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start" || m.method==="thread/resume") send({id:m.id,result:{thread:{id:"thread-test"},model:m.params.model}});
 else if(m.method==="thread/loaded/list") send({id:m.id,result:{data:["thread-test"]}});
 else if(m.method==="thread/list") send({id:m.id,result:{data:m.params.archived?[]:[{id:"thread-test"}],nextCursor:null}});
 else if(m.method==="turn/start") { turn="turn-"+(++number);send({id:m.id,result:{turn:{id:turn,status:"inProgress"}}});send({method:"turn/started",params:{threadId:"thread-test",turn:{id:turn,status:"inProgress"}}});setTimeout(()=>{if(number>1)send({id:"stale-"+number,method:"item/commandExecution/requestApproval",params:{threadId:"thread-test",turnId:"turn-"+(number-1),itemId:"stale",command:"node old-task.mjs",cwd:${JSON.stringify(root)}}});plan();},20); }
 else if(m.method) send({id:m.id,result:{}});
 else if(String(m.id).startsWith("stale-") && m.result?.decision==="accept") send({method:"turn/completed",params:{threadId:"thread-test",turn:{id:turn,status:"failed",error:{message:"stale approval was accepted"},items:[]}}});
 else if(String(m.id).startsWith("plan-") && m.result?.success) approve(1);
 else if(String(m.id).startsWith("approval-")) {
   if(m.result?.decision!=="accept") {send({method:"turn/completed",params:{threadId:"thread-test",turn:{id:turn,status:"failed",error:{message:"not approved"},items:[]}}});return;}
   if(String(m.id).endsWith("-1")) approve(2);
   else { const item={type:"agentMessage",id:"answer-"+turn,text:"评审测试完成",phase:"final_answer"};send({method:"item/completed",params:{threadId:"thread-test",turnId:turn,item}});send({method:"turn/completed",params:{threadId:"thread-test",turn:{id:turn,status:"completed",items:[item]}}}); }
 }
});

`);
  fs.chmodSync(executable, 0o755);
  const previousExecutable = process.env.CODEX_EXECUTABLE;
  const previousPath = process.env.PATH;
  const fakeCli = path.join(root, "lark-cli");
  fs.writeFileSync(fakeCli, '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"message_id":"om_card"}}\'\n');
  fs.chmodSync(fakeCli, 0o755);
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.CODEX_EXECUTABLE = executable;
  let reviews = 0; let replies = 0;
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [], approverId: "ou_owner",
    turnApprovalReviewer: async input => {
      reviews++;
      assert.equal(input.approvalPlan?.goal, "Review the requested PR");
      assert.equal(input.approvalPlan?.steps.length, 2);
      if (reviews === 3) throw new Error("model unavailable");
      if (reviews === 4) setAppSettingValue("turnAutoApprovalEnabled", "false");
      return { decision: "approve_turn", approvedSteps: [1, 2], reason: "Both review record phases match the task" };
    },
    textReplySender: () => ({ ok: true, messageId: `om_reply_${++replies}`, chatId: "oc_test", messageAt: new Date().toISOString(), messageType: "text" })
  });
  try {
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true, executionReceiptsEnabled: false, interimRepliesEnabled: false } });
    for (const id of [10, 20, 30, 40, 50]) {
      const now = new Date().toISOString();
      runtime.store.db.prepare("INSERT INTO lark_messages (id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES (?,?,'oc_test','p2p','ou_sender','text','please review PR',1,'p2p','skipped','failed','{}',?,?)")
        .run(id, `om_test_${id}`, now, now);
      assert.equal(enqueueLarkCodexReply(id), true);
      let status = "";
      for (let i = 0; i < 250; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (id >= 30) {
          const pending = runtime.store.db.prepare("SELECT token,card_message_id FROM lark_execution_approvals WHERE status='pending' LIMIT 1").get() as { token: string; card_message_id: string } | undefined;
          if (pending) assert.equal(decideLarkExecutionApprovalFromCard({ token: pending.token, decision: "approve-turn", operatorId: "ou_owner", messageId: pending.card_message_id }).ok, true);
        }
        status = (runtime.store.db.prepare("SELECT codex_status FROM lark_messages WHERE id=?").get(id) as { codex_status: string }).codex_status;
        if (["answered", "failed"].includes(status)) break;
      }
      assert.equal(status, "answered", JSON.stringify(runtime.store.db.prepare("SELECT codex_error FROM lark_messages WHERE id=?").get(id)));
    }
    assert.equal(reviews, 4); assert.equal(replies, 5);
    const approvals = runtime.store.db.prepare("SELECT status,approval_scope,card_message_id FROM lark_execution_approvals").all() as Array<{ status: string; approval_scope: string; card_message_id: string | null }>;
    assert.equal(approvals.length, 10); assert(approvals.every((row) => row.status === "approved" && row.approval_scope === "once"));
    assert.equal(approvals.filter((row) => row.card_message_id !== null).length, 3);
    const audit = runtime.store.db.prepare("SELECT source,applied_at FROM lark_turn_auto_reviews").all() as Array<{ source: string; applied_at: string | null }>;
    assert.equal(audit.length, 4); assert.equal(audit.filter((row) => row.source === "model" && row.applied_at).length, 2);
    assert(audit.some((row) => row.source === "manual" && row.applied_at === null));
  } finally {
    await runtime.app.close(); runtime.stop();
    if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousExecutable;
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first-step review does not grant an unlisted deployment or a different service",async()=>{
  for(const scenario of [
    {request:"检查 demo-api 当前服务状态",target:"demo-api",manual:true,reviews:1},
    {request:"查询 demo-api 部署状态",target:"demo-api",manual:true,reviews:2},
    {request:"部署 demo-api 并检查状态",target:"demo-api",manual:false,reviews:2},
    {request:"部署 demo-api",target:"demo-worker",manual:true,reviews:1}
  ]) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-deployment-command-"));
    const executable=path.join(root,"codex.mjs");const decisionsFile=path.join(root,"decisions.jsonl");
    const commands=["node deploy-app.mjs --repo demo-api --app demo-api --refresh-only",`node deploy-app.mjs --repo ${scenario.target} --app ${scenario.target} --execute`];
    fs.writeFileSync(executable,`#!${process.execPath}
import readline from "node:readline";import fs from "node:fs";
const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");
const commands=${JSON.stringify(commands)};
function ask(step){send({id:"approval-"+step,method:"item/commandExecution/requestApproval",params:{threadId:"deployment-thread",turnId:"deployment-turn",itemId:"cmd-"+step,command:commands[step-1],cwd:${JSON.stringify(root)}}});}
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"deployment-thread"},model:m.params.model}});
 else if(m.method==="thread/loaded/list")send({id:m.id,result:{data:["deployment-thread"]}});
 else if(m.method==="thread/list")send({id:m.id,result:{data:m.params.archived?[]:[{id:"deployment-thread"}],nextCursor:null}});
 else if(m.method==="turn/start"){send({id:m.id,result:{turn:{id:"deployment-turn",status:"inProgress"}}});send({method:"turn/started",params:{threadId:"deployment-thread",turn:{id:"deployment-turn",status:"inProgress"}}});setTimeout(()=>ask(1),20);}
 else if(m.method)send({id:m.id,result:{}});
 else if(String(m.id).startsWith("approval-")){
  fs.appendFileSync(${JSON.stringify(decisionsFile)},JSON.stringify({step:m.id,decision:m.result?.decision})+"\\n");
  if(m.id==="approval-1"&&m.result?.decision==="accept")ask(2);
  else {const item={id:"answer",type:"agentMessage",phase:"final_answer",text:m.result?.decision==="accept"?"模拟部署完成":"部署未获授权，未执行"};send({method:"item/completed",params:{threadId:"deployment-thread",turnId:"deployment-turn",item}});send({method:"turn/completed",params:{threadId:"deployment-thread",turn:{id:"deployment-turn",status:"completed",items:[item]}}});}
 }
});
`);
    fs.chmodSync(executable,0o755);
    const fakeCli=path.join(root,"lark-cli");fs.writeFileSync(fakeCli,'#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"message_id":"om_card"}}\'\n');fs.chmodSync(fakeCli,0o755);
    const previousExecutable=process.env.CODEX_EXECUTABLE;const previousPath=process.env.PATH;
    process.env.CODEX_EXECUTABLE=executable;process.env.PATH=`${root}:${previousPath ?? ""}`;
    let reviews=0;let humanCards=0;
    const runtime=createRuntime({databasePath:path.join(root,"test.sqlite"),mode:"active",workspaceRoot:root,trustedSenderIds:[],approverId:"ou_owner",
      turnApprovalReviewer:async(input)=>{
        reviews++;
        if (input.operation.endsWith("--execute")) return scenario.manual
          ? {decision:"manual",reason:"实际发布不在此前获准的当前步骤范围"}
          : {decision:"approve_once",reason:"重新核对实际发布与用户请求后，仅允许该次操作"};
        return {decision:"approve_turn",reason:"首个操作在请求范围内"};
      },
      textReplySender:()=>({ok:true,messageId:"om_reply",chatId:"oc_test",messageAt:new Date().toISOString(),messageType:"text"})});
    try {
      await runtime.app.inject({method:"PATCH",url:"/v1/settings",payload:{turnAutoApprovalEnabled:true,executionReceiptsEnabled:false,interimRepliesEnabled:false}});
      const now=new Date().toISOString();runtime.store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES (1,'om_test','oc_test','p2p','ou_sender','text',?,1,'p2p','skipped','failed','{}',?,?)").run(scenario.request,now,now);
      assert.equal(enqueueLarkCodexReply(1),true);
      let status="";
      for(let i=0;i<250;i++){
        await new Promise(resolve=>setTimeout(resolve,25));
        const pending=runtime.store.db.prepare("SELECT token,card_message_id FROM lark_execution_approvals WHERE status='pending' LIMIT 1").get() as {token:string;card_message_id:string}|undefined;
        if(pending){humanCards++;assert.equal(decideLarkExecutionApprovalFromCard({token:pending.token,decision:"reject",operatorId:"ou_owner",messageId:pending.card_message_id}).ok,true);}
        status=(runtime.store.db.prepare("SELECT codex_status FROM lark_messages WHERE id=1").get() as {codex_status:string}).codex_status;
        if(["answered","failed"].includes(status))break;
      }
      assert.equal(status,"answered",scenario.request);assert.equal(reviews,scenario.reviews,scenario.request);assert.equal(humanCards,scenario.manual?1:0);
      const decisions=fs.readFileSync(decisionsFile,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {decision:string});
      assert.equal(decisions[0].decision,"accept");assert.equal(decisions[1].decision,scenario.manual?"decline":"accept");
    } finally {
      await runtime.app.close();runtime.stop();if(previousExecutable===undefined)delete process.env.CODEX_EXECUTABLE;else process.env.CODEX_EXECUTABLE=previousExecutable;process.env.PATH=previousPath;fs.rmSync(root,{recursive:true,force:true});
    }
  }
});

test("the whole experiment plan is shown; one human approval covers only the exact write and readback", async () => {
  for (const scenario of ["exact", "changed-target", "changed-batch"] as const) {
    const changedTarget = scenario === "changed-target", changedBatch = scenario === "changed-batch";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-rollout-approval-"));
    const executable = path.join(root, "codex.mjs"), effects = path.join(root, "effects.jsonl"), cards = path.join(root, "cards.jsonl");
    const commands = ["node record-task.mjs", "node fixture-rollout.mjs --experiment 4 --expected 0 --target 100", "node fixture-status.mjs --experiment 4"];
    const plan = { goal: "Set the verified experiment to 100%", impact: "Change production traffic for experiment 4 only",
      steps: commands.map((operation, i) => ({ kind: "command", cwd: root, operation,
        intent: ["Record task locally", "Set experiment 4 from 0% to 100%", "Read back the result"][i],
        effect: ["local-write", "remote-write", "read"][i] })) };
    fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";import fs from "node:fs";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
const meta={threadId:"rollout-thread",turnId:"rollout-turn"};
const commands=${JSON.stringify(commands)};
function ask(i){send({id:"op-"+i,method:"item/commandExecution/requestApproval",params:{...meta,itemId:"item-"+i,command:i===1&&${changedTarget}?commands[i].replace("experiment 4","experiment 5"):commands[i],cwd:${JSON.stringify(root)},reason:i===0?"Only record the task":"Apply or verify the requested experiment plan"}});}
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start")send({id:m.id,result:{thread:{id:meta.threadId}}});
 else if(m.method==="turn/start"){
  send({id:m.id,result:{turn:{id:meta.turnId,status:"inProgress"}}});
  setTimeout(()=>send({id:"plan",method:"item/tool/call",params:{...meta,tool:"lark_approval_plan",arguments:${JSON.stringify(plan)}}}),30);
 }else if(m.method)send({id:m.id,result:{}});
 else if(m.id==="plan"&&m.result?.success)ask(0);
 else if(String(m.id).startsWith("op-")){
  const step=Number(m.id.slice(3));
  fs.appendFileSync(${JSON.stringify(effects)},JSON.stringify({step,decision:m.result?.decision})+"\\n");
  if(m.result?.decision==="accept"&&step<2){ask(step+1);if(step===0&&${changedBatch})ask(2);}
  else{
   const item={id:"answer",type:"agentMessage",phase:"final_answer",text:"Fixture finished"};
   send({method:"item/completed",params:{...meta,item}});
   send({method:"turn/completed",params:{...meta,turn:{id:meta.turnId,status:"completed",items:[item]}}});
  }
 }
});`, { mode: 0o755 });
    const cli = path.join(root, "lark-cli");
    fs.writeFileSync(cli, `#!${process.execPath}
import fs from "node:fs";
const args=process.argv.slice(2);
if(args.includes("+messages-send")&&args.includes("--content"))fs.appendFileSync(${JSON.stringify(cards)},args[args.indexOf("--content")+1]+"\\n");
console.log(JSON.stringify({data:{message_id:"om_card"}}));`, { mode: 0o755 });
    const previousPath = process.env.PATH, previousExecutable = process.env.CODEX_EXECUTABLE;
    process.env.PATH = `${root}:${previousPath ?? ""}`; process.env.CODEX_EXECUTABLE = executable;
    const reviewed: string[] = [];
    const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [],
      approverId: "ou_owner", turnApprovalReviewer: async input => {
        assert.equal(input.approvalPlan?.goal, plan.goal);
        assert.equal(input.approvalPlan?.impact, plan.impact);
        if (input.operation === commands[0]) assert.equal(input.operationIntent, "Only record the task");
        reviewed.push(input.operation);
        return input.operation === commands[0] ? { decision: "approve_once", reason: "Local task record only" }
          : { decision: "manual", reason: "Production traffic changes require explicit confirmation" };
      }, textReplySender: () => ({ ok: true, messageId: "om_reply", chatId: "oc_fixture", messageAt: null, messageType: "text" }) });
    const effectsOf = () => fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const wait = async <T,>(check: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + 10_000;
      for (;;) { const value = check(); if (value !== undefined) return value; assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25)); }
    };
    try {
      await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true, executionReceiptsEnabled: false, interimRepliesEnabled: false } });
      const now = new Date().toISOString();
      runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
        VALUES(1,'om_fixture','oc_fixture','group','ou_sender','text',?,1,'mention','skipped','failed','{}',?,?)`).run(plan.goal, now, now);
      assert.equal(enqueueLarkCodexReply(1), true);
      const pending = await wait(() => runtime.store.db.prepare("SELECT token,card_message_id FROM lark_execution_approvals WHERE status='pending' AND card_message_id IS NOT NULL")
        .get() as { token: string; card_message_id: string } | undefined);
      if (changedBatch) {
        await wait(() => {
          const count = runtime.store.db.prepare("SELECT count(*) FROM lark_execution_approvals WHERE status='pending'").pluck().get();
          return count === 2 ? true : undefined;
        });
        runtime.store.db.prepare("UPDATE lark_execution_approvals SET status='failed' WHERE item_id='item-2' AND status='pending'").run();
      }
      const card = fs.readFileSync(cards, "utf8");
      assert.match(card, /Set the verified experiment to 100%/);
      assert.match(card, /Change production traffic for experiment 4 only/);
      assert.doesNotMatch(card, /fixture-rollout\.mjs/);
      assert.deepEqual(effectsOf(), [{ step: 0, decision: "accept" }]);
      const decide = (decision: "approve-turn" | "reject") => decideLarkExecutionApprovalFromCard({ token: pending.token, decision,
        operatorId: "ou_owner", messageId: pending.card_message_id });
      assert.equal(decide("approve-turn").ok, scenario === "exact");
      if (changedTarget) assert.equal(decide("reject").ok, true);
      await wait(() => runtime.store.db.prepare("SELECT 1 FROM lark_messages WHERE id=1 AND codex_status='answered'").get());
      assert.equal(reviewed.length, scenario === "exact" ? 1 : 2);
      if (changedBatch) assert.deepEqual(effectsOf().filter(effect => effect.decision === "accept"), [{step:0,decision:"accept"}]);
      else assert.deepEqual(effectsOf(), changedTarget ? [{step:0,decision:"accept"},{step:1,decision:"decline"}]
        : [0,1,2].map(step => ({step,decision:"accept"})));
      assert.equal(runtime.store.db.prepare("SELECT count(*) FROM lark_execution_approvals WHERE card_message_id IS NOT NULL").pluck().get(), 1);
      assert.equal(runtime.store.db.prepare("SELECT count(*) FROM lark_execution_approvals WHERE approval_scope='turn'").pluck().get(), 0);
    } finally {
      await runtime.app.close(); runtime.stop();
      process.env.PATH = previousPath;
      if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousExecutable;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
