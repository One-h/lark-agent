import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { buildLarkAutoApprovalCard } from "@lark-agent/adapter-lark-cli";
import { configureConversationRuntime } from "./context.js";
import { markTurnAutoApprovalApplied } from "./turnAutoApproval.js";
import { retryPendingLarkMediaReplies } from "./responder.js";
import { configureAutoApprovalNotificationSender,queueTurnAutoApprovalNotification,retryPendingAutoApprovalNotifications } from "./turnApprovalNotifications.js";

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-auto-notification-"));
  const file=path.join(root,"test.sqlite");
  let store=new SqliteAgentStore(file);
  const configure=()=>configureConversationRuntime({database:store.db,mode:"shadow",larkStickerDirectory:root,repoRoot:root});
  configure();
  const now=new Date().toISOString();
  store.db.prepare("INSERT INTO lark_messages(id,sender_id,content,raw_json,received_at,created_at) VALUES (1,'ou_requester','部署 demo-api','{}',?,?)").run(now,now);
  store.db.prepare(`INSERT INTO lark_turn_auto_reviews(id,lark_message_id,turn_id,requester_id,approver_id,source,decision,reason,model,created_at,completed_at)
    VALUES (1,1,'turn','ou_requester','ou_owner','model','approved','常规指定服务部署','gpt-6.1-sol',?,?)`).run(now,now);
  return {get store(){return store;},reopen(){store.close();store=new SqliteAgentStore(file);configure();},close(){configureAutoApprovalNotificationSender();store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test("automatic authorization notification is durable, once per review, and sent only to the approver",async()=>{
  const f=fixture(); const calls:Array<{recipient:string;key:string}>=[];
  configureAutoApprovalNotificationSender(async(recipient,card,key)=>{
    calls.push({recipient,key});assert.equal(card.reviewId,1);assert.equal(card.messageId,1);
    return calls.length===1?{ok:false,error:"temporary send failure"}:{ok:true,messageId:"om_notification",chatId:null,messageAt:null,messageType:"interactive"};
  });
  try {
    queueTurnAutoApprovalNotification(1);assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox").get() as {n:number}).n,0);
    markTurnAutoApprovalApplied(1);markTurnAutoApprovalApplied(1);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox").get() as {n:number}).n,1);
    assert.equal(retryPendingLarkMediaReplies(),0);
    await retryPendingAutoApprovalNotifications();
    assert.equal((f.store.db.prepare("SELECT status FROM lark_delivery_outbox").get() as {status:string}).status,"pending");
    f.reopen();f.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='2000-01-01'").run();
    await retryPendingAutoApprovalNotifications();await retryPendingAutoApprovalNotifications();
    assert.equal(calls.length,2);assert(calls.every(call=>call.recipient==="ou_owner"));assert.equal(calls[0].key,calls[1].key);
    assert.equal((f.store.db.prepare("SELECT status FROM lark_delivery_outbox").get() as {status:string}).status,"sent");
    markTurnAutoApprovalApplied(1);assert.equal(await retryPendingAutoApprovalNotifications(),0);
    const card=buildLarkAutoApprovalCard({reviewId:1,messageId:1,requester:"<at user_id=\"all\">同事</at>",request:"部署 demo-api",source:"model",reason:"符合请求",model:"gpt-6.1-sol",matchedApprovalId:null,appliedAt:new Date().toISOString()});
    const serialized=JSON.stringify(card);
    assert.match(serialized,/授权已生效/);assert.match(serialized,/不代表任务或部署已完成/);assert.doesNotMatch(serialized,/"tag":"button"|approval_token|"tag":"lark_md"/);
  } finally {f.close();}
});

test("concurrent notification retries send once and manual decisions never notify",async()=>{
  const f=fixture();let calls=0;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  configureAutoApprovalNotificationSender(async()=>{calls++;await gate;return {ok:true,messageId:"om_one",chatId:null,messageAt:null,messageType:"interactive"};});
  try {
    f.store.db.prepare("UPDATE lark_turn_auto_reviews SET decision='manual'").run();markTurnAutoApprovalApplied(1);
    assert.equal((f.store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox").get() as {n:number}).n,0);
    f.store.db.prepare("UPDATE lark_turn_auto_reviews SET decision='approved'").run();markTurnAutoApprovalApplied(1);
    const first=retryPendingAutoApprovalNotifications();
    assert.equal(await retryPendingAutoApprovalNotifications(),0);assert.equal(calls,1);release();await first;
  } finally {release();f.close();}
});

test("notification failures stop after bounded retries without changing the requester reply",async()=>{
  const f=fixture();configureAutoApprovalNotificationSender(async()=>({ok:false,error:"unavailable"}));
  try {
    markTurnAutoApprovalApplied(1);
    for(let i=0;i<8;i++){f.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='2000-01-01'").run();await retryPendingAutoApprovalNotifications();}
    assert.deepEqual(f.store.db.prepare("SELECT status,attempts FROM lark_delivery_outbox").get(),{status:"failed",attempts:8});
    assert.equal(await retryPendingAutoApprovalNotifications(),0);
    assert.equal((f.store.db.prepare("SELECT reply_error FROM lark_messages WHERE id=1").get() as {reply_error:string|null}).reply_error,null);
  } finally {f.close();}
});

test("overlapping retry batches recheck a row sent by another batch",async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const calls:number[]=[];
  configureAutoApprovalNotificationSender(async(_recipient,card)=>{calls.push(card.reviewId);if(card.reviewId===1)await gate;return {ok:true,messageId:`om_${card.reviewId}`,chatId:null,messageAt:null,messageType:"interactive"};});
  try {
    f.store.db.prepare(`INSERT INTO lark_turn_auto_reviews(id,lark_message_id,turn_id,requester_id,approver_id,source,decision,reason,model,created_at,completed_at)
      SELECT 2,lark_message_id,'second-turn',requester_id,approver_id,source,decision,reason,model,created_at,completed_at FROM lark_turn_auto_reviews WHERE id=1`).run();
    markTurnAutoApprovalApplied(1);markTurnAutoApprovalApplied(2);
    const first=retryPendingAutoApprovalNotifications();await retryPendingAutoApprovalNotifications();release();await first;
    assert.deepEqual(calls,[1,2]);
  } finally {release();f.close();}
});
