import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideLarkExecutionApprovalFromCard, enqueueLarkCodexReply, setAppSettingValue } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("App Server approval requests grant the current turn and do not leak to the next turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-command-auto-"));
  const executable = path.join(root, "codex.mjs");
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value)+"\\n");
let number = 0; let turn = "";
function approve(step) { send({id:"approval-"+turn+"-"+step, method:"item/commandExecution/requestApproval",params:{threadId:"thread-test",turnId:turn,itemId:"cmd-"+step,command:"node scripts/record-task.mjs review",cwd:${JSON.stringify(root)},reason:"record PR review"}}); }
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start" || m.method==="thread/resume") send({id:m.id,result:{thread:{id:"thread-test"},model:m.params.model}});
 else if(m.method==="thread/loaded/list") send({id:m.id,result:{data:["thread-test"]}});
 else if(m.method==="turn/start") { turn="turn-"+(++number);send({id:m.id,result:{turn:{id:turn,status:"inProgress"}}});send({method:"turn/started",params:{threadId:"thread-test",turn:{id:turn,status:"inProgress"}}});setTimeout(()=>{if(number>1)send({id:"stale-"+number,method:"item/commandExecution/requestApproval",params:{threadId:"thread-test",turnId:"turn-"+(number-1),itemId:"stale",command:"node old-task.mjs",cwd:${JSON.stringify(root)}}});approve(1);},20); }
 else if(m.method) send({id:m.id,result:{}});
 else if(String(m.id).startsWith("stale-") && m.result?.decision==="accept") send({method:"turn/completed",params:{threadId:"thread-test",turn:{id:turn,status:"failed",error:{message:"stale approval was accepted"},items:[]}}});
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
    turnApprovalReviewer: async () => {
      reviews++;
      if (reviews === 3) throw new Error("model unavailable");
      if (reviews === 4) setAppSettingValue("turnAutoApprovalEnabled", "false");
      return { decision: "approve_turn", reason: "PR review" };
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
      for (let i = 0; i < 100; i++) {
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
    assert.equal(approvals.length, 10); assert(approvals.every((row) => row.status === "approved" && row.approval_scope === "turn"));
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

test("real command approval routing does not expand inspection grants into deployment or another service",async()=>{
  for(const scenario of [
    {request:"检查 demo-api 当前服务状态",target:"demo-api",manual:true},
    {request:"查询 demo-api 部署状态",target:"demo-api",manual:true},
    {request:"部署 demo-api 并检查状态",target:"demo-api",manual:false},
    {request:"部署 demo-api",target:"demo-worker",manual:true}
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
      turnApprovalReviewer:async()=>{reviews++;return {decision:"approve_turn",reason:"首个操作在请求范围内"};},
      textReplySender:()=>({ok:true,messageId:"om_reply",chatId:"oc_test",messageAt:new Date().toISOString(),messageType:"text"})});
    try {
      await runtime.app.inject({method:"PATCH",url:"/v1/settings",payload:{turnAutoApprovalEnabled:true,executionReceiptsEnabled:false,interimRepliesEnabled:false}});
      const now=new Date().toISOString();runtime.store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES (1,'om_test','oc_test','p2p','ou_sender','text',?,1,'p2p','skipped','failed','{}',?,?)").run(scenario.request,now,now);
      assert.equal(enqueueLarkCodexReply(1),true);
      let status="";
      for(let i=0;i<140;i++){
        await new Promise(resolve=>setTimeout(resolve,25));
        const pending=runtime.store.db.prepare("SELECT token,card_message_id FROM lark_execution_approvals WHERE status='pending' LIMIT 1").get() as {token:string;card_message_id:string}|undefined;
        if(pending){humanCards++;assert.equal(decideLarkExecutionApprovalFromCard({token:pending.token,decision:"reject",operatorId:"ou_owner",messageId:pending.card_message_id}).ok,true);}
        status=(runtime.store.db.prepare("SELECT codex_status FROM lark_messages WHERE id=1").get() as {codex_status:string}).codex_status;
        if(["answered","failed"].includes(status))break;
      }
      assert.equal(status,"answered",scenario.request);assert.equal(reviews,1);assert.equal(humanCards,scenario.manual?1:0);
      const decisions=fs.readFileSync(decisionsFile,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {decision:string});
      assert.equal(decisions[0].decision,"accept");assert.equal(decisions[1].decision,scenario.manual?"decline":"accept");
    } finally {
      await runtime.app.close();runtime.stop();if(previousExecutable===undefined)delete process.env.CODEX_EXECUTABLE;else process.env.CODEX_EXECUTABLE=previousExecutable;process.env.PATH=previousPath;fs.rmSync(root,{recursive:true,force:true});
    }
  }
});
