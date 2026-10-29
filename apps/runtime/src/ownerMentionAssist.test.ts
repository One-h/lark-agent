import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { createRuntime } from "./index.js";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { ingestLarkEvent, isOwnerMentionAssistMessage, ownerAssistMayExecute, ownerAssistRow, retryOwnerAssistNotifications,
  retryPendingLarkTextReplies, setAppSettingValue, decideLarkExecutionApprovalFromCard, reconcileOwnerMentionAssists,
  activeOwnerAssistRequests, drainOwnerAssistNotifications } from "@lark-agent/conversation-runtime";

async function until(check: () => boolean) {
  const end = performance.now() + 5000;
  while (!check()) { assert(performance.now() < end, "owner assistance fixture timed out"); await immediate(); }
}

function fixture(trustedMember = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-owner-assist-"));
  const executable = path.join(root, "codex.mjs"), log = path.join(root, "rpc.jsonl");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";import readline from "node:readline";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");let next=0;const threads=new Map();
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+"\\n");
if(m.method==="thread/start"){const id="thread-"+(threads.size+1);threads.set(id,null);send({id:m.id,result:{thread:{id}}});}
else if(m.method==="thread/resume")send({id:m.id,result:{thread:{id:m.params.threadId}}});
else if(m.method==="thread/loaded/list")send({id:m.id,result:{data:[...threads.keys()],nextCursor:null}});
else if(m.method==="thread/list")send({id:m.id,result:{data:m.params.archived?[]:[...threads.keys()].map(id=>({id})),nextCursor:null}});
else if(m.method==="turn/start"){const turn={id:"turn-"+(++next),status:"inProgress"};threads.set(m.params.threadId,turn);send({id:m.id,result:{turn}});}
else if(m.method==="thread/read")send({id:m.id,result:{thread:{id:m.params.threadId,status:{type:threads.get(m.params.threadId)?.status==="inProgress"?"active":"idle"}}}});
else if(m.method==="thread/turns/list")send({id:m.id,result:{data:[threads.get(m.params.threadId)].filter(Boolean)}});
else if(m.method==="fixture/approval"){send({id:m.id,result:{}});send(m.params.request);}
else if(m.method==="fixture/emit"){send({id:m.id,result:{}});for(const item of m.params.notifications){if(item.method==="turn/completed")threads.set(item.params.threadId,item.params.turn);send(item);}}
else if(m.method)send({id:m.id,result:{}});
});`);
  fs.chmodSync(executable, 0o755);
  const cli = path.join(root, "lark-cli");
  fs.writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,identities:{bot:{openId:"ou_bot"}},data:{message_id:"om_card",messages:[]}}));\n`); fs.chmodSync(cli, 0o755);
  const previous = { executable: process.env.CODEX_EXECUTABLE, path: process.env.PATH };
  process.env.CODEX_EXECUTABLE = executable; process.env.PATH = `${root}:${previous.path ?? ""}`;
  const sent: string[] = [], notices: Array<{recipient: string; text: string; key: string}> = [];
  let membership: boolean | null = true, failText = false, failNotice = false, missingNoticeReceipt = false;
  let membershipGate: Promise<void> | null = null;
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root,
    runtimeToken: "fixture-token", trustedSenderIds: trustedMember ? ["ou_owner","ou_member"] : ["ou_owner"], approverId: "ou_owner", ownerMentionAssistDelayMs: 0,
    ownerMentionAssistMembershipProbe: async () => { if(membershipGate)await membershipGate; return membership; },
    proactiveMessageSender: (recipient, text, key) => { notices.push({recipient,text,key}); return failNotice ? {ok:false,error:"fixture notice failed"} : {ok:true,messageId:missingNoticeReceipt?null:"om_notice",chatId:"oc_private",messageAt:null,messageType:"text"}; },
    reactionSender: () => ({ok:true}), textReplySender: (_id, text) => { if (failText) return {ok:false,error:"fixture delivery failed"}; sent.push(text); return {ok:true,messageId:`om_sent${sent.length}`,chatId:"oc_group",messageAt:null,messageType:"text"}; }
  });
  for (const [key,value] of Object.entries({ownerMentionAssistEnabled:"true",stickerUsageMode:"off",interimRepliesEnabled:"false",executionReceiptsEnabled:"false",trustedExecutionEnabled:"true"})) setAppSettingValue(key,value);
  const headers = { authorization: "Bearer fixture-token" };
  const records = () => fs.existsSync(log) ? fs.readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)) : [];
  const row = (messageId: string) => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE message_id=?").get(messageId) as any;
  const event = (messageId: string, extra: Record<string,unknown> = {}) => ({ event_id:`event-${messageId}`,message_id:messageId,chat_id:"oc_group",chat_type:"group",sender_id:"ou_member",sender_type:"user",message_type:"text",content:"请核查任务失败原因",mentions:[{id:{open_id:"ou_owner"}}],...extra });
  const complete = async (messageId: string, answer = "fixture final") => {
    const source = row(messageId);
    await codexAppServer.request("fixture/emit",{notifications:[
      {method:"item/completed",params:{threadId:source.codex_session_id,turnId:source.codex_turn_id,item:{type:"agentMessage",id:`answer-${messageId}`,phase:"final_answer",text:answer}}},
      {method:"turn/completed",params:{threadId:source.codex_session_id,turn:{id:source.codex_turn_id,status:"completed"}}}
    ]});
    await until(()=>["answered","no_reply"].includes(row(messageId).codex_status));
  };
  const start = async (messageId = "om_question", extra: Record<string,unknown> = {}) => {
    ingestLarkEvent(event(messageId,extra)); await until(()=>Boolean(row(messageId)?.codex_turn_id)); return row(messageId);
  };
  const contextAcks = new Map<string,number>();
  const decision = async (messageId: string, action: string, extra: Record<string,unknown> = {}) => {
    const source = row(messageId), prompt = fs.readFileSync(path.join(source.codex_task_dir,"prompt.md"),"utf8");
    const contextToken = prompt.match(/context_token=([A-Za-z0-9_-]{32})/)![1];
    const response = await runtime.app.inject({method:"POST",url:"/v1/internal/owner-assist/decision",headers,
      payload:{contextToken,input:{action,reason:"fixture decision",...(contextAcks.has(messageId)?{owner_context_cursor:contextAcks.get(messageId)}:{}),...extra}}});
    assert.equal(response.statusCode,200,response.body);
    const value=JSON.parse(response.json().contentItems[0].text);
    if(value.state==="owner_context_updated")contextAcks.set(messageId,value.owner_context_cursor);
    return value;
  };
  return {root,runtime,headers,sent,notices,event,row,records,start,decision,complete,
    membership(value:boolean|null){membership=value;},failText(value:boolean){failText=value;},failNotice(value:boolean){failNotice=value;},missingNoticeReceipt(value:boolean){missingNoticeReceipt=value;},
    holdMembership(){let release!:()=>void;membershipGate=new Promise<void>(resolve=>{release=resolve;});return()=>{membershipGate=null;release();};},
    async close(){await runtime.app.close();runtime.stop();if(previous.executable===undefined)delete process.env.CODEX_EXECUTABLE;else process.env.CODEX_EXECUTABLE=previous.executable;process.env.PATH=previous.path;fs.rmSync(root,{recursive:true,force:true});}
  };
}

test("owner assistance global/group settings validate, inherit and do not affect ordinary mentions", async()=>{
  const f=fixture();try{
    setAppSettingValue("ownerMentionAssistEnabled","false");
    assert.equal(isOwnerMentionAssistMessage(f.event("om_a")),false);
    const url="/v1/chats/oc_group/settings";
    assert.equal((await f.runtime.app.inject({method:"PATCH",url,headers:f.headers,payload:{ownerMentionAssistMode:"on"}})).json().ownerMentionAssist.effectiveEnabled,true);
    assert.equal(isOwnerMentionAssistMessage(f.event("om_a")),true);
    for(const extra of [{mentions:[]},{mentions:[{id:{open_id:"all"}}]},{sender_id:"ou_owner"},{sender_type:"bot"},{chat_type:"p2p"}])assert.equal(isOwnerMentionAssistMessage(f.event("om_a",extra)),false);
    const invalid=await f.runtime.app.inject({method:"PATCH",url,headers:f.headers,payload:{stickerUsageMode:"always",ownerMentionAssistMode:"bad"}});
    assert.equal(invalid.statusCode,400);
    assert.equal((await f.runtime.app.inject({url,headers:f.headers})).json().stickerUsage.mode,"global");
    await f.runtime.app.inject({method:"PATCH",url,headers:f.headers,payload:{ownerMentionAssistMode:"off"}});
    await f.runtime.app.inject({method:"PATCH",url:"/v1/settings",headers:f.headers,payload:{ownerMentionAssistEnabled:true,ownerMentionAssistOwnerId:"ou_owner"}});
    assert.equal((await f.runtime.app.inject({url,headers:f.headers})).json().ownerMentionAssist.effectiveEnabled,false);
    assert.equal((await f.runtime.app.inject({method:"PATCH",url:"/v1/settings",headers:f.headers,payload:{ownerMentionAssistOwnerId:"invalid"}})).statusCode,400);
    await f.runtime.app.inject({method:"PATCH",url:"/v1/settings",headers:f.headers,payload:{approverId:"",ownerMentionAssistOwnerId:"",ownerMentionAssistEnabled:false}});
    assert.equal((await f.runtime.app.inject({method:"PATCH",url,headers:f.headers,payload:{ownerMentionAssistMode:"on"}})).statusCode,400);
  }finally{await f.close();}
});

test("owner and bot mentions dispatch once; accepted work retains the actual sender permissions",async()=>{
  const f=fixture();try{
    const source=await f.start("om_question",{mentions:[{id:{open_id:"ou_owner"}},{id:{open_id:"ou_bot"}}]});
    assert.equal(source.reply_trigger,"owner_mention");assert.equal(ownerAssistMayExecute(source.id),false);
    const params=f.records().find(r=>r.method==="thread/start").params;
    assert.equal(params.sandbox,"read-only");
    assert.equal((await f.decision("om_question","handle")).state,"handle");assert.equal(ownerAssistMayExecute(source.id),true);
    assert.equal((await f.decision("om_question","handle",{reply:"已核实，补充两个事实。"})).state,"ready");
    await f.complete("om_question");assert.equal(f.sent.length,1);assert.match(f.sent[0],/已核实，补充两个事实/);
    assert.equal(ingestLarkEvent(f.event("om_question")).duplicate,true);
    assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
    assert.equal(ownerAssistRow(source.id)?.status,"sent");
  }finally{await f.close();}
});

test("owner replies are appended to the running turn and returned for supplementation instead of cancelling the draft",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle");
    ingestLarkEvent(f.event("om_ownerreply",{sender_id:"ou_owner",mentions:[],content:"我查到原因 A 了，你补充其他原因。",reply_to:"om_question"}));
    await until(()=>f.records().some(r=>r.method==="turn/steer"));
    assert.equal(f.row("om_ownerreply").codex_status,"skipped");
    const first=await f.decision("om_question","handle",{reply:"已经准备的 A 和 B 两点说明。"});
    assert.equal(first.state,"owner_context_updated");assert.equal(first.ownerResponses.length,1);
    assert.match(first.ownerResponses[0].content,/原因 A/);assert.match(ownerAssistRow(source.id)!.draft,/已经准备/);
    assert.equal(f.sent.length,0);
    assert.equal((await f.decision("om_question","handle",{reply:"我补充原因 B 和修复结果。"})).state,"ready");
    await f.complete("om_question");assert.equal(f.sent.length,1);assert.match(f.sent[0],/我补充原因 B/);
    assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
  }finally{await f.close();}
});

test("owner context stays within the original group/topic and is incremental",async()=>{
  const f=fixture();try{
    await f.start("om_question",{thread_id:"omt_topic"});await f.decision("om_question","handle");
    for(const [id,extra] of [["om_private",{chat_type:"p2p"}],["om_othergroup",{chat_id:"oc_other"}],["om_othertopic",{thread_id:"omt_other"}]] as const)
      ingestLarkEvent(f.event(id,{sender_id:"ou_owner",mentions:[],content:"unrelated",...extra}));
    assert.equal((await f.decision("om_question","handle",{reply:"topic result"})).state,"ready");
    ingestLarkEvent(f.event("om_update1",{sender_id:"ou_owner",mentions:[],thread_id:"omt_topic",content:"第一点已经说明"}));
    assert.equal((await f.decision("om_question","handle",{reply:"draft"})).ownerResponses.length,1);
    ingestLarkEvent(f.event("om_update2",{sender_id:"ou_owner",mentions:[],thread_id:"omt_topic",content:"又补充了一点"}));
    const latest=await f.decision("om_question","handle",{reply:"draft"});assert.equal(latest.ownerResponses.length,1);assert.equal(latest.ownerResponses[0].message_id,"om_update2");
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");assert.deepEqual(f.sent,[]);
  }finally{await f.close();}
});

test("owner_required sends only a private draft; explicit review publishes as bot without granting execution",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","owner_required",{reply:"供本人确认的草稿",question:"是否同意？"});
    await f.complete("om_question","模型试图直接公开草稿");assert.deepEqual(f.sent,[]);
    assert.equal(f.notices.length,1);assert.equal(f.notices[0].recipient,"ou_owner");
    const listing=await f.runtime.app.inject({url:"/v1/owner-mention-assists",headers:f.headers});
    const item=listing.json().items[0];assert.equal(item.draft,"供本人确认的草稿");assert.equal(item.enabled,true);
    const approve=await f.runtime.app.inject({method:"POST",url:`/v1/owner-mention-assists/${source.id}/decision`,headers:f.headers,payload:{action:"send",version:item.version,text:"本人审核后，机器人补充的事实。"}});
    assert.equal(approve.statusCode,200,approve.body);assert.equal(f.sent.length,1);
    assert.equal(ownerAssistMayExecute(source.id),false);assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_capability_invocations").get() as any).n,0);
    assert.equal((await f.runtime.app.inject({method:"POST",url:`/v1/owner-mention-assists/${source.id}/decision`,headers:f.headers,payload:{action:"send",version:item.version,text:"duplicate"}})).statusCode,409);
  }finally{await f.close();}
});

test("ignore and missing model decisions never publish; missing protocol retains the prepared draft privately",async()=>{
  for(const action of ["ignore",null]){
    const f=fixture();try{
      const source=await f.start();if(action)await f.decision("om_question",action);
      await f.complete("om_question","未提交最终协议的候选回答");assert.deepEqual(f.sent,[]);
      assert.equal(ownerAssistRow(source.id)?.status,action?"ignored":"needs_owner");
      assert.equal(f.notices.length,action?0:1);
      if(!action)assert.match(ownerAssistRow(source.id)!.draft,/候选回答/);
    }finally{await f.close();}
  }
});

test("unknown membership, policy changes and late owner updates preserve drafts instead of posting stale answers",async()=>{
  for(const scenario of ["membership","disabled","late-context"]){
    const f=fixture();try{
      const source=await f.start();await f.decision("om_question","handle");
      if(scenario==="membership")f.membership(null);
      const result=await f.decision("om_question","handle",{reply:"保留这份草稿"});
      assert.equal(result.state,scenario==="membership"?"owner_required":"ready");
      if(scenario==="disabled")setAppSettingValue("ownerMentionAssistEnabled","false");
      if(scenario==="late-context")ingestLarkEvent(f.event("om_late",{sender_id:"ou_owner",mentions:[],content:"我又补充了新情况"}));
      await f.complete("om_question");assert.deepEqual(f.sent,[]);assert.match(ownerAssistRow(source.id)!.draft,/保留这份草稿/);
    }finally{await f.close();}
  }
});

test("text retry is idempotent, but a new owner reply moves undelivered text to private review",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle",{reply:"queued result"});f.failText(true);await f.complete("om_question");
    assert.equal(f.row("om_question").reply_status,"pending");
    ingestLarkEvent(f.event("om_afterfailure",{sender_id:"ou_owner",mentions:[],content:"已有新的结论"}));
    f.failText(false);f.runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE id=?").run(source.id);
    retryPendingLarkTextReplies();assert.deepEqual(f.sent,[]);assert.equal(ownerAssistRow(source.id)?.status,"needs_owner");
  }finally{await f.close();}
});

test("private notices have bounded stable-key retries and do not invalidate the owner's review version",async()=>{
  const f=fixture();try{
    const source=await f.start();f.failNotice(true);await f.decision("om_question","owner_required",{reply:"private draft"});
    const version=ownerAssistRow(source.id)!.version;
    await retryOwnerAssistNotifications();
    for(let i=0;i<7;i++){f.runtime.store.db.prepare("UPDATE lark_owner_mention_assists SET notify_after='1970-01-01'").run();await retryOwnerAssistNotifications();}
    assert.equal(f.notices.length,5);assert.equal(new Set(f.notices.map(x=>x.key)).size,1);assert.equal(ownerAssistRow(source.id)!.version,version);
    await f.complete("om_question","<lark-no-reply/>");assert.deepEqual(f.sent,[]);
  }finally{await f.close();}
});

test("owner assist endpoints reject unauthenticated, foreign-context and malformed decisions",async()=>{
  const f=fixture();try{
    assert.equal((await f.runtime.app.inject({url:"/v1/owner-mention-assists"})).statusCode,401);
    assert.equal((await f.runtime.app.inject({method:"POST",url:"/v1/internal/owner-assist/decision",payload:{}})).statusCode,403);
    await f.start();
    assert.equal((await f.runtime.app.inject({method:"POST",url:"/v1/internal/owner-assist/decision",headers:f.headers,payload:{contextToken:"x".repeat(32),input:{action:"handle",reason:"bad"}}})).statusCode,409);
    assert.equal((await f.runtime.app.inject({method:"POST",url:"/v1/owner-mention-assists/1/decision",headers:f.headers,payload:{action:"send",version:1,text:"x",ownerId:"ou_other"}})).statusCode,400);
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
  }finally{await f.close();}
});

test("trusted owner-assist senders still start read-only and undecided execution requests are declined",async()=>{
  const f=fixture(true);try{
    const source=await f.start();
    const thread=f.records().find(r=>r.method==="thread/start").params,turn=f.records().find(r=>r.method==="turn/start").params;
    assert.equal(thread.sandbox,"read-only");assert.equal(thread.approvalPolicy,"on-request");assert.deepEqual(turn.sandboxPolicy,{type:"readOnly",networkAccess:false});
    await codexAppServer.request("fixture/approval",{request:{id:"approval-before",method:"item/commandExecution/requestApproval",params:{threadId:source.codex_session_id,turnId:source.codex_turn_id,itemId:"cmd",command:"touch file.txt",cwd:f.root}}});
    await until(()=>f.records().some(r=>r.id==="approval-before"&&r.result));
    assert.equal(f.records().find(r=>r.id==="approval-before"&&r.result).result.decision,"decline");
    await f.decision("om_question","handle");
    await codexAppServer.request("fixture/approval",{request:{id:"whole-permissions",method:"item/permissions/requestApproval",params:{threadId:source.codex_session_id,turnId:source.codex_turn_id,itemId:"permissions",permissions:{network:{enabled:true}}}}});
    await until(()=>f.records().some(r=>r.id==="whole-permissions"&&r.result));
    assert.deepEqual(f.records().find(r=>r.id==="whole-permissions"&&r.result).result.permissions,{});
    await codexAppServer.request("fixture/approval",{request:{id:"legacy-permissions",method:"execCommandApproval",params:{conversationId:source.codex_session_id,callId:"legacy",command:["touch","file.txt"],cwd:f.root}}});
    await until(()=>f.records().some(r=>r.id==="legacy-permissions"&&r.result));
    assert.equal(f.records().find(r=>r.id==="legacy-permissions"&&r.result).result,"decline");
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
    await f.start("om_direct",{mentions:[{id:{open_id:"ou_bot"}}]});
    assert.equal(f.records().filter(r=>r.method==="thread/start").at(-1).params.sandbox,"danger-full-access");
    await f.complete("om_direct");
  }finally{await f.close();}
});

test("pending native approvals are revoked on owner context, private handoff and group policy changes",async()=>{
  for(const scenario of ["context","owner_required","off"]){
    const f=fixture();try{
      const source=await f.start();await f.decision("om_question","handle");
      await codexAppServer.request("fixture/approval",{request:{id:"approval-pending",method:"item/commandExecution/requestApproval",params:{threadId:source.codex_session_id,turnId:source.codex_turn_id,itemId:"cmd",command:"touch file.txt",cwd:f.root}}});
      await until(()=>Boolean(f.runtime.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE status='pending'").get()));
      const approval=f.runtime.store.db.prepare("SELECT * FROM lark_execution_approvals WHERE status='pending'").get() as any;
      if(scenario==="context")ingestLarkEvent(f.event("om_stop",{sender_id:"ou_owner",mentions:[],content:"先不要执行，先补充依据"}));
      else if(scenario==="owner_required")await f.decision("om_question","owner_required",{reply:"请本人确认"});
      else assert.equal((await f.runtime.app.inject({method:"PATCH",url:"/v1/chats/oc_group/settings",headers:f.headers,payload:{ownerMentionAssistMode:"off"}})).statusCode,200);
      assert.equal(ownerAssistMayExecute(source.id),false);
      const accepted=decideLarkExecutionApprovalFromCard({token:approval.token,decision:"approve-turn",operatorId:"ou_owner",messageId:approval.card_message_id});
      assert.equal(accepted.ok,false);
      await until(()=>f.records().some(r=>r.id==="approval-pending"&&r.result));
      assert.equal(f.records().find(r=>r.id==="approval-pending"&&r.result).result.decision,"decline");
      await f.complete("om_question","<lark-no-reply/>");
    }finally{await f.close();}
  }
});

test("owner context freezes pending host calls before they can execute after approval",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle");
    const invoked=f.runtime.app.inject({method:"POST",url:"/v1/capabilities/lark.message.send/invoke",headers:f.headers,
      payload:{input:{recipient:"ou_other",text:"must not send"},context:{larkMessageId:source.id,chatId:source.chat_id,trustScope:"untrusted",turnId:source.codex_turn_id}}});
    await until(()=>Boolean(f.runtime.store.db.prepare("SELECT 1 FROM lark_capability_approvals WHERE status='pending'").get()));
    ingestLarkEvent(f.event("om_handoff",{sender_id:"ou_owner",mentions:[],content:"先不要执行这个操作"}));
    assert.equal((await invoked).statusCode,409);
    assert.equal(f.notices.filter(n=>n.recipient==="ou_other").length,0);
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_capability_approvals WHERE status='approved'").get() as any).n,0);
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
  }finally{await f.close();}
});

test("a lost context-update response cannot approve the old draft without acknowledging the owner revision",async()=>{
  const f=fixture();try{
    await f.start();await f.decision("om_question","handle");
    ingestLarkEvent(f.event("om_revision",{sender_id:"ou_owner",mentions:[],content:"补充新的事实"}));
    assert.equal((await f.decision("om_question","handle",{reply:"old draft"})).state,"owner_context_updated");
    assert.equal((await f.decision("om_question","handle",{reply:"old draft",owner_context_cursor:undefined})).state,"owner_context_updated");
    assert.equal((await f.decision("om_question","handle",{reply:"updated draft"})).state,"ready");
    await f.complete("om_question");assert.match(f.sent[0],/updated draft/);
  }finally{await f.close();}
});

test("exhausted delivery and restart retain reviewable drafts and restart private notification without replaying work",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle",{reply:"durable draft"});f.failText(true);await f.complete("om_question");
    for(let i=0;i<9;i++){f.runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE id=?").run(source.id);retryPendingLarkTextReplies();}
    assert.equal(ownerAssistRow(source.id)?.status,"needs_owner");
    let item=ownerAssistRow(source.id)!;
    const reviewed=await f.runtime.app.inject({method:"POST",url:`/v1/owner-mention-assists/${source.id}/decision`,headers:f.headers,payload:{action:"send",version:item.version,text:"reviewed draft"}});
    assert.equal(reviewed.statusCode,200,reviewed.body);assert.equal(ownerAssistRow(source.id)?.status,"ready");
    reconcileOwnerMentionAssists();item=ownerAssistRow(source.id)!;
    assert.equal(item.status,"needs_owner");assert.equal(item.manual_approved,0);assert.equal(item.notified,0);assert.match(item.draft,/reviewed draft/);
    await retryOwnerAssistNotifications();assert.equal(ownerAssistRow(source.id)?.notified,1);
    assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
  }finally{await f.close();}
});

test("private notification without an actual receipt is not marked delivered",async()=>{
  const f=fixture();try{
    const source=await f.start();f.missingNoticeReceipt(true);await f.decision("om_question","owner_required",{reply:"retained private draft"});
    assert.equal(ownerAssistRow(source.id)?.notified,0);assert.equal(ownerAssistRow(source.id)?.notify_attempts,1);
    await f.complete("om_question","<lark-no-reply/>");
  }finally{await f.close();}
});

test("unconfirmed or absent group membership never forwards group contents in a private notice",async()=>{
  for(const membership of [null,false]){
    const f=fixture();try{
      await f.start();f.membership(membership);
      await f.decision("om_question","owner_required",{reply:"保密的群内草稿"});await retryOwnerAssistNotifications();
      if(membership===false)assert.equal(f.notices.length,0);
      else {assert.equal(f.notices.length,1);assert.doesNotMatch(f.notices[0].text,/保密的群内草稿|请核查任务失败原因/);}
      await f.complete("om_question","<lark-no-reply/>");assert.deepEqual(f.sent,[]);
    }finally{await f.close();}
  }
});

test("private notification work remains visible and drains after the native turn has ended",async()=>{
  const f=fixture();let release:(()=>void)|undefined;try{
    await f.start();release=f.holdMembership();
    await f.decision("om_question","owner_required",{reply:"private draft"});
    await f.complete("om_question","<lark-no-reply/>");assert.ok(activeOwnerAssistRequests()>0);
    let drained=false;const waiting=drainOwnerAssistNotifications().then(()=>{drained=true;});await immediate();assert.equal(drained,false);
    release();release=undefined;await waiting;assert.equal(activeOwnerAssistRequests(),0);assert.equal(f.notices.length,1);
  }finally{release?.();await f.close();}
});

test("off then on does not revive the old handling decision without a fresh model confirmation",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle");assert.equal(ownerAssistMayExecute(source.id),true);
    for(const enabled of [false,true])assert.equal((await f.runtime.app.inject({method:"PATCH",url:"/v1/settings",headers:f.headers,payload:{ownerMentionAssistEnabled:enabled}})).statusCode,200);
    assert.equal(ownerAssistMayExecute(source.id),false);assert.equal(ownerAssistRow(source.id)?.decision_turn_id,null);
    assert.equal((await f.decision("om_question","handle")).state,"owner_context_updated");assert.equal(ownerAssistMayExecute(source.id),false);
    assert.equal((await f.decision("om_question","handle")).state,"handle");assert.equal(ownerAssistMayExecute(source.id),true);
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
  }finally{await f.close();}
});

test("backend turn permission remains scoped to the original turn and still checks the refreshed owner decision",async()=>{
  const f=fixture();try{
    const source=await f.start();await f.decision("om_question","handle");
    const request=(id:string)=>codexAppServer.request("fixture/approval",{request:{id,method:"item/commandExecution/requestApproval",params:{threadId:source.codex_session_id,turnId:source.codex_turn_id,itemId:id,command:"node check-original-task.mjs",cwd:f.root}}});
    await request("command-A");await until(()=>Boolean(f.runtime.store.db.prepare("SELECT 1 FROM lark_execution_approvals WHERE status='pending'").get()));
    const approval=f.runtime.store.db.prepare("SELECT * FROM lark_execution_approvals WHERE status='pending'").get() as any;
    assert.equal(decideLarkExecutionApprovalFromCard({token:approval.token,decision:"approve-turn",operatorId:"ou_owner",messageId:approval.card_message_id}).ok,true);
    await until(()=>f.records().some(r=>r.id==="command-A"&&r.result));
    ingestLarkEvent(f.event("om_ownerfacts",{sender_id:"ou_owner",mentions:[],content:"补充一个事实，仍核查原任务"}));
    await request("command-B-before-review");await until(()=>f.records().some(r=>r.id==="command-B-before-review"&&r.result));
    assert.equal(f.records().find(r=>r.id==="command-B-before-review"&&r.result).result.decision,"decline");
    assert.equal((await f.decision("om_question","handle")).state,"owner_context_updated");
    assert.equal((await f.decision("om_question","handle")).state,"handle");
    await request("command-B-refreshed");await until(()=>f.records().some(r=>r.id==="command-B-refreshed"&&r.result));
    assert.equal(f.records().find(r=>r.id==="command-B-refreshed"&&r.result).result.decision,"accept");
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_execution_approvals WHERE status='pending'").get() as any).n,0);
    assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
    await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
  }finally{await f.close();}
});

test("a legacy callback from an earlier owner-assist turn cannot borrow the next turn on the reused thread",async()=>{
  const f=fixture();try{
    const first=await f.start();await f.decision("om_question","ignore");await f.complete("om_question","<lark-no-reply/>");
    const next=await f.start("om_next");assert.equal(first.codex_session_id,next.codex_session_id);assert.notEqual(first.codex_turn_id,next.codex_turn_id);
    await f.decision("om_next","handle");
    await codexAppServer.request("fixture/approval",{request:{id:"old-turn-callback",method:"execCommandApproval",params:{conversationId:first.codex_session_id,callId:"old-command",command:["touch","old-task.txt"],cwd:f.root}}});
    await until(()=>f.records().some(r=>r.id==="old-turn-callback"&&r.result));assert.equal(f.records().find(r=>r.id==="old-turn-callback"&&r.result).result,"decline");
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_execution_approvals WHERE status='pending'").get() as any).n,0);
    await f.decision("om_next","ignore");await f.complete("om_next","<lark-no-reply/>");
  }finally{await f.close();}
});

test("off then on cannot silently resume undelivered automatic or human-confirmed text after the native turn ends",async()=>{
  for(const manual of [false,true]){
    const f=fixture();try{
      const source=await f.start();f.failText(true);
      if(manual){
        await f.decision("om_question","owner_required",{reply:"private draft"});await f.complete("om_question","<lark-no-reply/>");
        const row=ownerAssistRow(source.id)!;
        assert.equal((await f.runtime.app.inject({method:"POST",url:`/v1/owner-mention-assists/${source.id}/decision`,headers:f.headers,payload:{action:"send",version:row.version,text:"confirmed draft"}})).statusCode,200);
      }else{
        await f.decision("om_question","handle",{reply:"automatic draft"});await f.complete("om_question");
      }
      assert.equal(ownerAssistRow(source.id)?.status,"ready");
      for(const enabled of [false,true])assert.equal((await f.runtime.app.inject({method:"PATCH",url:"/v1/settings",headers:f.headers,payload:{ownerMentionAssistEnabled:enabled}})).statusCode,200);
      assert.equal(ownerAssistRow(source.id)?.status,"needs_owner");assert.equal(ownerAssistRow(source.id)?.manual_approved,0);
      f.failText(false);f.runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE id=?").run(source.id);retryPendingLarkTextReplies();
      assert.deepEqual(f.sent,[]);assert.equal(f.records().filter(r=>r.method==="turn/start").length,1);
    }finally{await f.close();}
  }
});
