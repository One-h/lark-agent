import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { deliverLarkOutboxRow, enqueueLarkCodexReply, listLarkMcpTools,
  retryPendingLarkMediaReplies, retryPendingLarkTextReplies, type ExecutionEngine } from "@lark-agent/conversation-runtime";
import { createRuntime } from "../index.js";

const auth = { authorization: "Bearer plugin-fixture" };
const fixture = () => mkdtempSync(path.join(os.tmpdir(), "lark-builtin-integration-"));
const options = (root: string) => ({ mode:"active" as const, runtimeToken:"plugin-fixture", workspaceRoot:root,
  databasePath:path.join(root,"fixture.sqlite"), trustedSenderIds:[], approverId:"ou_owner" });

async function until(predicate: () => boolean) {
  const end = Date.now() + 7000;
  while (!predicate()) { assert(Date.now() < end, "ordinary reply did not finish"); await delay(20); }
}

test("stopping built-in plugins hides their routes and tools, preserves settings, and still allows an ordinary reply", async () => {
  const root = fixture();
  const replies: string[] = [];
  const engine: ExecutionEngine = {
    descriptor:{id:"fixture",label:"Fixture",models:[]}, supportsPolicy:()=>true,
    open:async()=>({id:"fixture-session",run:async()=>({status:"completed",text:"normal reply"}),close() {}})
  };
  const runtime = createRuntime({
    ...options(root), executionEngines:[engine], disabledBuiltinPlugins:[
      "managed-chats", "agent-outreach", "personal-inbox", "owner-assist", "native-topics",
      "progress-cards", "completion-reactions", "stickers"
    ],
    reactionSender:()=>({ok:true}), textReplySender:(_id,text)=>{
      replies.push(text);
      return {ok:true,messageId:"om_reply",chatId:"oc_fixture",messageAt:null,messageType:"text"};
    }
  });
  try {
    const { app,store } = runtime;
    store.setSetting("stickerUsageMode","always");
    store.setSetting("topicNativeModeEnabled","true");
    const pluginRoute = await app.inject({method:"GET",url:"/v1/plugins",headers:auth});
    assert.equal(pluginRoute.statusCode,200);
    const plugins=pluginRoute.json().plugins;
    assert.equal(plugins.length,10);
    assert(plugins.every((p:{enabled:boolean;mounted:boolean})=>!p.enabled&&!p.mounted));
    assert.deepEqual(plugins.find((p:{id:string})=>p.id==="group-question").blockedBy,["agent-outreach"]);
    assert(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lark_orchestration_tasks'").get());
    assert.equal((await app.inject({method:"GET",url:"/v1/plugins"})).statusCode,401);
    for (const target of ["/v1/managed-chats","/v1/agent-messaging","/v1/personal-inbox","/v1/stickers"]) {
      assert.equal((await app.inject({method:"GET",url:target,headers:auth})).statusCode,404,target);
    }
    assert.equal((await app.inject({method:"GET",url:"/v1/group-privacy",headers:auth})).statusCode,200);
    assert.equal(store.setting("stickerUsageMode",""),"always");
    assert.equal(store.setting("topicNativeModeEnabled",""),"true");
    assert.equal((await app.inject("/v1/settings")).json().stickerUsageMode,"off");
    assert.equal((await app.inject("/v1/settings")).json().topicNativeModeEnabled,false);
    // A stale capability registration cannot bypass the disabled owner policy.
    store.registerCapabilities([{id:"lark.chat.create",title:"stale",description:"stale",inputSchema:{},risk:"external-write"}]);
    assert(!listLarkMcpTools(true).some(tool=>tool.name==="lark__chat__create"));
    assert(listLarkMcpTools(true).some(tool=>tool.name==="lark__message__send"));
    const add=store.db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(?,?, 'oc_fixture','p2p','ou_sender','user','text','fixture question',1,'p2p','pending',?,'{}','2026-11-23','2026-11-23')`);
    add.run(1,"om_anchor","answered");
    const changed=await app.inject({method:"PUT",url:"/v1/chats/oc_fixture/execution",headers:auth,payload:{override:{engineId:"fixture",model:null}}});
    assert.equal(changed.statusCode,200);
    add.run(2,"om_ordinary","skipped");assert(enqueueLarkCodexReply(2));
    await until(()=>store.db.prepare("SELECT reply_status FROM lark_messages WHERE id=2").pluck().get()==="sent");
    runtime.tickPlugins();
    assert.deepEqual(replies,["normal reply"]);
    store.db.prepare(`INSERT INTO lark_delivery_outbox(lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at)
      VALUES(2,'media',?,'paused-sticker','2026-11-23','2026-11-23')`).run(JSON.stringify({
      messageId:"om_ordinary",taskDir:root,paths:["sticker.png"],stickerIds:["stk_fixture"]
    }));
    const queued=store.db.prepare("SELECT * FROM lark_delivery_outbox WHERE idempotency_key='paused-sticker'").get() as Parameters<typeof deliverLarkOutboxRow>[0];
    deliverLarkOutboxRow(queued,()=>assert.fail("disabled sticker transport ran"));
    assert.equal(retryPendingLarkMediaReplies(),0);
    assert.equal(store.db.prepare("SELECT status FROM lark_delivery_outbox WHERE id=?").pluck().get(queued.id),"pending");
  } finally { await runtime.app.close(); runtime.stop(); rmSync(root,{recursive:true,force:true}); }
});

test("invalid plugin declarations are rejected before creating a database", () => {
  const root = fixture();
  try {
    assert.throws(()=>createRuntime({...options(root),plugins:[{id:"duplicate"},{id:"duplicate"}]}),/duplicate/);
    assert.throws(()=>createRuntime({...options(root),disabledBuiltinPlugins:["unknown"]}),/Unknown/);
    assert(!existsSync(options(root).databasePath));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("shadow retry workers do not send persisted text or media", async () => {
  const root=fixture();
  const runtime=createRuntime({...options(root),mode:"shadow",textReplySender:()=>assert.fail("shadow sent text")});
  try {
    const db=runtime.store.db;
    db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,raw_json,received_at,created_at,reply_status,
      reply_delivery_key,reply_delivery_text,reply_next_attempt_at,reply_send_stage)
      VALUES(1,'om_fixture','oc_fixture','p2p','{}','2026-11-23','2026-11-23','pending','fixture','text','2026-11-23','queued')`).run();
    db.prepare(`INSERT INTO lark_delivery_outbox(lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at)
      VALUES(1,'media','{}','fixture-media','2026-11-23','2026-11-23')`).run();
    assert.equal(retryPendingLarkTextReplies(),0);
    assert.equal(retryPendingLarkMediaReplies(),0);
    assert.equal(db.prepare("SELECT reply_status FROM lark_messages WHERE id=1").pluck().get(),"pending");
    assert.equal(db.prepare("SELECT status FROM lark_delivery_outbox").pluck().get(),"pending");
  } finally { await runtime.app.close(); runtime.stop(); rmSync(root,{recursive:true,force:true}); }
});
