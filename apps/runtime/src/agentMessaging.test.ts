import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { AgentMessaging, registerAgentMessagingRoutes, type AgentMessage } from "./agentMessaging.js";
import type { AgentReplyBridge } from "./agentReplyBridge.js";
const a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
const message:AgentMessage={messageId:"om_reply",chatId:"oc_chat",chatType:"p2p",senderId:"ou_peer",senderName:"同事",chatName:"",content:"可以",sourceTime:new Date().toISOString(),messageType:"text"};
async function fixture(run:(f:{router:AgentMessaging;store:SqliteAgentStore;bridge:AgentReplyBridge;delivered:{threadId:string;payload:any}[];send:(thread:string,key:string)=>Promise<any>;calls:string[][]})=>Promise<void>){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-agent-routing-")),store=new SqliteAgentStore(path.join(root,"test.sqlite"));
 const delivered:{threadId:string;payload:any}[]=[],calls:string[][]=[];
 const bridge:AgentReplyBridge={inspect:async id=>({id,cwd:root,status:{type:"idle"}}),deliver:async(threadId,payload)=>{delivered.push({threadId,payload});return "turn_1";}};
 const router=new AgentMessaging(store,{ownerId:()=>"ou_owner",bridge,cli:async(args)=>{calls.push(args);return {data:{message_id:`om_sent${calls.length}`,chat_id:"oc_chat"}};}});
 const send=(thread:string,key:string)=>router.send({sourceThreadId:thread,sourceCwd:root,sourceLabel:thread===a?"方案":"排期",recipientId:"ou_peer",requestKey:key,text:"测试协作"});
 try{await run({router,store,bridge,delivered,send,calls});}finally{await router.stop();store.close();fs.rmSync(root,{recursive:true,force:true});}
}
test("two Agents contact one colleague; explicit replies return only to their originating threads and deduplicate",async()=>fixture(async({router,send,delivered})=>{
 const first=await send(a,"request_a"),second=await send(b,"request_b");
 assert.equal(router.ingest({...message,replyTo:second.messageId},"bot"),true);
 router.ingest({...message,replyTo:second.messageId},"bot");
 router.ingest({...message,messageId:"om_reply2",replyTo:first.messageId},"bot");
 await router.tick();await router.tick();assert.deepEqual(delivered.map(row=>row.threadId),[b,a]);
 assert.equal(delivered[0].payload.message.content,"可以");assert.equal((router.snapshot().replies as any[]).length,2);
}));
test("unquoted reply requires owner assignment; stale or foreign assignments fail",async()=>fixture(async({router,send,delivered})=>{
 const first=await send(a,"request_a"),second=await send(b,"request_b");router.ingest(message,"bot");await router.tick();assert.equal(delivered.length,0);
 const row=(router.snapshot().replies as any[])[0];assert.equal(row.status,"needs_owner");
 assert.throws(()=>router.decide(row.id,{outreachId:second.id,version:row.version-1}),/刷新/);
 assert.throws(()=>router.decide(row.id,{outreachId:"unknown",version:row.version}),/候选/);
 router.decide(row.id,{outreachId:first.id,version:row.version});await router.tick();assert.equal(delivered[0].threadId,a);
}));
test("routing is isolated by sender, chat and identity; closed requests do not capture messages",async()=>fixture(async({router,send})=>{
 const first=await send(a,"request_a");assert.equal(router.ingest({...message,senderId:"ou_other",replyTo:first.messageId},"bot"),false);
 assert.equal(router.ingest({...message,chatId:"oc_other",replyTo:first.messageId},"bot"),false);assert.equal(router.ingest(message,"user"),false);
 router.close(first.id);assert.equal(router.ingest(message,"bot"),false);
}));
test("send retries are idempotent; reused key cannot change source, recipient or body",async()=>fixture(async({send,router,calls})=>{
 const row=await send(a,"request_a");assert.equal((await send(a,"request_a")).id,row.id);assert.equal(calls.length,1);
 await assert.rejects(send(b,"request_a"),/不能复用/);
}));
test("ambiguous send response is retained and never automatically resent",async()=>fixture(async({router,send,calls})=>{
 // A source is verified before sending, and concurrent identical requests cannot send twice.
 const [one,two]=await Promise.allSettled([send(a,"request_a"),send(a,"request_a")]);
 assert.equal([one,two].filter(row=>row.status==="fulfilled").length,1);assert.equal(calls.length,1);await router.tick();assert.equal(calls.length,1);
}));
test("notLoaded source is never resumed by another process; original Agent claims and acknowledges its own messages",async()=>fixture(async({router,send,bridge,delivered})=>{
 const row=await send(a,"request_a");bridge.inspect=async id=>({id,cwd:row.sourceCwd,status:{type:"notLoaded"}});
 router.ingest({...message,replyTo:row.messageId},"bot");await router.tick();assert.equal(delivered.length,0);
 assert.equal(router.receive(b).length,0);const claimed=router.claim(a);assert.equal(claimed.length,1);assert.equal(claimed[0].status,"claimed");assert.equal(router.claim(a).length,0);
 router.acknowledge(b,[claimed[0].id]);assert.equal((router.snapshot().replies as any[])[0].status,"claimed");
 router.acknowledge(a,[claimed[0].id]);assert.equal((router.snapshot().replies as any[])[0].status,"delivered");
}));
test("a lost delivery response is not retried; owner can explicitly decide to redeliver",async()=>fixture(async({router,send,bridge,delivered})=>{
 const row=await send(a,"request_a");let count=0;bridge.deliver=async()=>{count++;throw new Error("response lost");};
 router.ingest({...message,replyTo:row.messageId},"bot");await router.tick();await router.tick();assert.equal(count,1);
 const reply=(router.snapshot().replies as any[])[0];assert.equal(reply.status,"delivery_unknown");
 router.decide(reply.id,{outreachId:row.id,version:reply.version});bridge.deliver=async(threadId,payload)=>{delivered.push({threadId,payload});return "turn_ok";};await router.tick();assert.equal(delivered.length,1);
}));
test("reply chain resolves to original Agent and conflicting parent/root asks owner",async()=>fixture(async({router,send,delivered})=>{
 const first=await send(a,"request_a"),second=await send(b,"request_b");
 router.ingest({...message,replyTo:first.messageId},"bot");await router.tick();
 router.ingest({...message,messageId:"om_chain",replyTo:message.messageId},"bot");await router.tick();assert.deepEqual(delivered.map(row=>row.threadId),[a,a]);
 router.ingest({...message,messageId:"om_conflict",replyTo:first.messageId,rootId:second.messageId},"bot");await router.tick();assert.equal(delivered.length,2);assert.equal((router.snapshot().replies as any[])[0].status,"needs_owner");
}));
test("protected messaging API rejects unauthenticated reads and sends",async()=>fixture(async({router})=>{
 const app=Fastify();registerAgentMessagingRoutes(app,router,req=>req.headers.authorization==="Bearer test");
 try{assert.equal((await app.inject({method:"GET",url:"/v1/agent-messaging"})).statusCode,401);assert.equal((await app.inject({method:"POST",url:"/v1/agent-messaging/send",payload:{}})).statusCode,401);assert.equal((await app.inject({method:"GET",url:"/v1/agent-messaging",headers:{authorization:"Bearer test"}})).statusCode,200);}finally{await app.close();}
}));

test("an unquoted personal reply with one source returns automatically, including recovery of previously held rows",async()=>fixture(async({router,send,store,delivered})=>{
 const sent=await send(a,"request_a");router.ingest(message,"bot");
 assert.equal((router.snapshot().replies as any[])[0].status,"queued");
 store.db.prepare("UPDATE agent_replies SET status='needs_owner',outreachId=NULL").run();
 await router.tick();assert.equal(delivered.length,1);assert.equal(delivered[0].threadId,a);
 assert.equal((router.snapshot().replies as any[])[0].outreachId,sent.id);
}));
test("single-source fallback refuses unrelated quotes, groups, and history older than the request",async()=>fixture(async({router,send,delivered})=>{
 await send(a,"request_a");
 router.ingest({...message,replyTo:"om_other"},"bot");
 router.ingest({...message,messageId:"om_group",chatType:"group"},"bot");
 router.ingest({...message,messageId:"om_old",sourceTime:new Date(Date.now()-3600000).toISOString()},"bot");
 await router.tick();assert.equal(delivered.length,0);assert.ok((router.snapshot().replies as any[]).every(row=>row.status==="needs_owner"));
}));
test("closing a competing source never retroactively auto-assigns an ambiguous reply",async()=>fixture(async({router,send,delivered})=>{
 await send(a,"request_a");const second=await send(b,"request_b");router.ingest(message,"bot");router.close(second.id);await router.tick();assert.equal(delivered.length,0);
}));

test("direct group send cannot bypass privacy approval even with an authenticated source",async()=>fixture(async({router,send,bridge,calls})=>{
 await assert.rejects(router.send({sourceThreadId:a,sourceCwd:(await bridge.inspect(a)).cwd,sourceLabel:"群发测试",recipientId:"ou_peer",chatId:"oc_group",requestKey:"group_request",text:"直接发群"}),/无法确认目标会话类型|隐私审批/);
 assert.equal(calls.some(row=>row.includes("+messages-send")),false);
}));

test("a confirmed group target is queued and receives a routing receipt only after owner publication",async()=>fixture(async({store,bridge})=>{
 const proposals:any[]=[],sent:string[][]=[];
 const guarded=new AgentMessaging(store,{ownerId:()=>"ou_owner",bridge,cli:async args=>{if(args[1]==="chats")return {data:{chat_mode:"group"}};sent.push(args);return {data:{message_id:"om_should_not_send",chat_id:"oc_group"}};},queueGroup:input=>{proposals.push(input);return 1;}});
 try{const result=await guarded.send({sourceThreadId:a,sourceCwd:(await bridge.inspect(a)).cwd,sourceLabel:"群协作",recipientId:"ou_peer",chatId:"oc_group",requestKey:"real_group_queue",text:"群消息草稿"});assert.equal(result?.status,"awaiting_approval");assert.equal(sent.length,0);assert.equal(proposals.length,1);guarded.approvedGroupReceipt(result!.id,"om_approved","oc_group");assert.equal((guarded.snapshot().outreaches as any[])[0].status,"open");}finally{await guarded.stop();}
}));
