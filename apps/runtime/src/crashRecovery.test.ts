import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { claimLarkCodexReply, deliverLarkOutboxRow, resumeQueuedLarkCodexReplies, retryPendingLarkTextReplies, type ExecutionEngine } from "@lark-agent/conversation-runtime";
import { reconcileInterruptedNativeTurns } from "../../../packages/conversation-runtime/src/crashRecovery.js";
import { createRuntime } from "./index.js";

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "recovery did not reach the expected state");
    await setImmediate();
  }
}

const headers = { authorization: "Bearer fixture-recovery" };
const options = (root: string) => ({ databasePath: path.join(root, "test.sqlite"), workspaceRoot: root, mode: "active" as const,
  trustedSenderIds: [], runtimeToken: "fixture-recovery", approverId: "ou_owner" });

test("crash recovery preserves queued input, invalidates approvals and supplements only unattempted delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-crash-recovery-"));
  const dispatched: string[] = [], sent: string[] = [];
  const engine: ExecutionEngine = { descriptor: { id: "fixture", label: "Fixture", models: [] },
    supportsPolicy: () => true, open: async () => ({ id: "fixture-session", run: async text => {
      dispatched.push(text); return { status: "completed", text: "fresh answer" };
    }, close() {} }) };
  const setup = () => createRuntime({ ...options(root), executionEngines: [engine],
    reactionSender: () => ({ ok: true }), textReplySender: (_id, text) => {
      sent.push(text); return { ok: true, messageId: "om_fixture"+sent.length, chatId: "oc_fixture", messageAt: null, messageType: "text" };
    } });
  let runtime = setup();
  const db = () => runtime.store.db;
  const row = (id: number) => db().prepare("SELECT * FROM lark_messages WHERE id=?").get(id) as Record<string, unknown>;
  const add = (id: number, status: string, content: string, chat = "oc_fixture") => db().prepare(`INSERT INTO lark_messages
    (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,mentioned,reply_trigger,reply_status,codex_status,content,raw_json,received_at,created_at)
    VALUES(?, ?, ?, 'p2p','ou_owner','user','text',1,'p2p','pending',?,?,'{}','2026-11-23','2026-11-23')`).run(id, "om_input"+id, chat, status, content);
  try {
    add(1,"answered","anchor");
    assert.equal((await runtime.app.inject({ method: "PUT", url: "/v1/chats/oc_fixture/execution", headers,
      payload: { override: { engineId: "fixture", model: null } } })).statusCode, 200);
    add(2,"skipped","safe queue"); assert(claimLarkCodexReply(2));
    add(3,"skipped","safe preparation"); assert(claimLarkCodexReply(3));
    db().prepare("UPDATE lark_messages SET codex_status='running',codex_dispatch_phase='preparing' WHERE id=3").run();
    add(4,"skipped","do not replay","oc_uncertain"); assert(claimLarkCodexReply(4));
    db().prepare("UPDATE lark_messages SET codex_status='running',codex_dispatch_phase='submitted',codex_session_id='old-thread',codex_turn_id='old-turn' WHERE id=4").run();
    const approval = runtime.store.createApproval({ larkMessageId: 4, turnId: "old-turn", capabilityId: "test.write", operation: "fixture write", approverId: "ou_owner", expiresAt: "2099-01-01T00:00:00Z" });
    db().prepare("INSERT INTO lark_capability_invocations(lark_message_id,turn_id,capability_id,input_hash,status,created_at) VALUES(4,'old-turn','test.write','fixture','running','2026-11-23')").run();
    add(5,"answered","staged reply");
    add(6,"answered","unknown delivery");
    add(7,"answered","already sent");
    add(8,"queued","legacy queue without a receipt");
    add(9,"skipped","execution context changed","oc_uncertain"); assert(claimLarkCodexReply(9));
    db().prepare("UPDATE lark_messages SET content='a different operation' WHERE id=9").run();
    add(10,"answered","staged media"); add(11,"answered","unknown media");
    add(12,"running","owner review");
    db().prepare("UPDATE lark_messages SET reply_trigger='owner_mention',codex_dispatch_phase='preparing',codex_dispatch_context='fixture' WHERE id=12").run();
    db().prepare("UPDATE lark_messages SET codex_turn_id='media-turn' WHERE id IN (10,11)").run();
    for (const id of [10,11]) db().prepare(`INSERT INTO lark_delivery_outbox(lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at,send_stage)
      VALUES(?,'media',?,?,'2026-11-23','2026-11-23',?)`).run(id, JSON.stringify({
        messageId: "om_input"+id, turnId:"media-turn", taskDir:root, paths:["file.txt"]
      }), "media-"+id, id===10?"queued":"attempted");
    db().prepare(`INSERT INTO lark_execution_approvals(token,lark_message_id,requester_id,approver_id,request_method,server_request_id,
      thread_id,turn_id,item_id,created_at,expires_at) VALUES('native-token',4,'ou_owner','ou_owner','native','request','old-thread','old-turn','item','2026-11-23','2099-01-01')`).run();
    db().prepare(`UPDATE lark_messages SET reply_delivery_key='key-'||id,reply_delivery_text=content,
      reply_send_stage=CASE id WHEN 5 THEN 'queued' ELSE 'attempted' END,reply_next_attempt_at='2026-11-23',
      reply_status=CASE id WHEN 7 THEN 'sent' ELSE 'pending' END WHERE id IN (5,6,7)`).run();
    await runtime.app.close(); runtime.stop();
    runtime = setup();
    assert.equal(row(2).codex_status,"queued");
    assert.equal(row(3).codex_status,"queued");
    assert.equal(row(4).codex_dispatch_phase,"needs_review");
    assert.equal(row(8).codex_dispatch_phase,"needs_review");
    assert.equal(row(12).codex_dispatch_phase,"needs_review");
    assert.equal(row(6).reply_status,"failed");
    assert.equal(row(7).reply_status,"sent");
    assert.equal(runtime.store.approval(approval)?.status,"failed");
    assert.equal((await runtime.app.inject({ method: "POST", url: `/v1/approvals/${approval}/approve`, headers })).statusCode, 409);
    assert.equal(db().prepare("SELECT status FROM lark_execution_approvals WHERE token='native-token'").pluck().get(),"failed");
    assert.equal(db().prepare("SELECT status FROM lark_capability_invocations WHERE lark_message_id=4").pluck().get(),"failed");
    const retries = await runtime.app.inject({ method: "POST", url: "/v1/messages/4/retry", headers });
    assert.equal(retries.statusCode,409); assert.equal(retries.json().code,"LARK_EXECUTION_NEEDS_REVIEW");
    const methods: string[] = [];
    await reconcileInterruptedNativeTurns(db(), async (method,params) => {
      methods.push(method);
      assert.equal(params.threadId,"old-thread");
      return method === "thread/read" ? { thread: { id: "old-thread", status: { type: "idle" } } } :
        { data: [{ id: "old-turn", status: "completed", items: [{ type: "agentMessage", text: "not a committed reply" }] }] };
    });
    assert.deepEqual(methods,["thread/read","thread/turns/list"]);
    assert.equal(row(4).codex_recovery_engine_status,"completed");
    assert.equal(row(4).codex_status,"failed");
    assert.equal(row(4).reply_delivery_key,null);
    assert.equal(retryPendingLarkTextReplies(),1);
    assert.equal(retryPendingLarkTextReplies(),0);
    assert.deepEqual(sent,["staged reply"]);
    const media = (id: number) => db().prepare("SELECT * FROM lark_delivery_outbox WHERE lark_message_id=?").get(id) as Parameters<typeof deliverLarkOutboxRow>[0];
    let mediaAttempts = 0;
    const mediaSender: Parameters<typeof deliverLarkOutboxRow>[1] = () => { mediaAttempts++; return { ok: true }; };
    deliverLarkOutboxRow(media(10),mediaSender); deliverLarkOutboxRow(media(10),mediaSender); deliverLarkOutboxRow(media(11),mediaSender);
    assert.equal(mediaAttempts,1);
    assert.equal(row(10).reply_status,"sent");
    assert.equal(row(11).reply_status,"failed");
    resumeQueuedLarkCodexReplies(); resumeQueuedLarkCodexReplies();
    await waitFor(() => row(2).reply_status === "sent" && row(3).reply_status === "sent" && row(9).codex_status === "skipped");
    assert.deepEqual(dispatched.map(prompt => prompt.split("\n").at(-1)),["safe queue","safe preparation"]);
    assert.deepEqual(sent,["staged reply","fresh answer","fresh answer"]);

    db().exec("CREATE TRIGGER fixture_admission_crash BEFORE UPDATE OF codex_dispatch_phase ON lark_messages WHEN NEW.message_id='om_atomic' BEGIN SELECT RAISE(ABORT,'fixture admission interrupted'); END");
    const request = () => runtime.app.inject({ method:"POST",url:"/v1/messages",headers,payload:{
      event_id:"ev_atomic",message_id:"om_atomic",chat_id:"oc_fixture",chat_type:"p2p",sender_id:"ou_owner",sender_type:"user",message_type:"text",content:"atomic input"
    } });
    assert.equal((await request()).statusCode,500);
    assert.equal(db().prepare("SELECT count(*) FROM lark_messages WHERE message_id='om_atomic'").pluck().get(),0);
    db().exec("DROP TRIGGER fixture_admission_crash");
    assert.equal((await request()).statusCode,200);
    assert.equal((await request()).json().duplicate,true);
    await waitFor(() => db().prepare("SELECT reply_status FROM lark_messages WHERE message_id='om_atomic'").pluck().get()==="sent");
    assert.equal(dispatched.length,3);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root,{recursive:true,force:true}); }
});

test("crash recovery survives process loss before engine result and before local delivery receipt", async () => {
  const script = `
    import fs from "node:fs"; import path from "node:path";
    import { createRuntime } from "./apps/runtime/src/index.ts";
    const [root,phase]=process.argv.slice(1);
    const trace=label=>fs.appendFileSync(path.join(root,"trace"),label+"\\n");
    const engine={descriptor:{id:"fixture",label:"Fixture",models:[]},supportsPolicy:()=>true,open:async()=>({
      id:"fixture-session",run:async()=>{trace("engine"); if(phase==="engine") process.exit(73); return {status:"completed",text:"confirmed answer"};},close(){} })};
    const r=createRuntime({databasePath:path.join(root,"test.sqlite"),workspaceRoot:root,mode:"active",
      trustedSenderIds:[],runtimeToken:"fixture-recovery",approverId:"ou_owner",executionEngines:[engine],
      reactionSender:()=>({ok:true}),textReplySender:()=>{trace("transport");process.exit(73);}});
    r.store.db.prepare(\`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,direction,codex_status,raw_json,received_at,created_at)
      VALUES(1,'om_anchor','oc_fixture','p2p','inbound','answered','{}','2026-11-23','2026-11-23')\`).run();
    const headers={authorization:"Bearer fixture-recovery"};
    const route=await r.app.inject({method:"PUT",url:"/v1/chats/oc_fixture/execution",headers,payload:{override:{engineId:"fixture",model:null}}});
    if(route.statusCode!==200) process.exit(70);
    await r.app.inject({method:"POST",url:"/v1/messages",headers,payload:{event_id:"ev_fixture",message_id:"om_fixture",
      chat_id:"oc_fixture",chat_type:"p2p",sender_id:"ou_owner",sender_type:"user",message_type:"text",content:"fixture input"}});
    setTimeout(()=>process.exit(74),6000);
  `;
  for (const phase of ["engine","receipt"]) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-hard-crash-"));
    try {
      const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script,root,phase],{encoding:"utf8",timeout:12_000});
      assert.equal(child.status,73,child.stderr || child.stdout);
      let attempts=0;
      const runtime=createRuntime({...options(root),textReplySender:()=>{attempts++; return {ok:false,error:"do not retry"};}});
      try {
        const row=runtime.store.db.prepare("SELECT * FROM lark_messages WHERE message_id='om_fixture'").get() as Record<string,unknown>;
        if (phase==="engine") {
          assert.equal(row.codex_dispatch_phase,"needs_review");
          assert.equal(row.codex_status,"failed");
        } else {
          assert.equal(row.codex_dispatch_phase,"finalized");
          assert.equal(row.codex_status,"answered");
          assert.equal(row.codex_reply,"confirmed answer");
          assert.equal(row.reply_status,"failed");
          assert.equal(row.reply_send_stage,"attempted");
        }
        resumeQueuedLarkCodexReplies();
        assert.equal(retryPendingLarkTextReplies(),0);
        assert.equal(attempts,0);
        assert.equal(fs.readFileSync(path.join(root,"trace"),"utf8"),phase==="engine"?"engine\n":"engine\ntransport\n");
      } finally { await runtime.app.close();runtime.stop(); }
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  }
});
