import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { enqueueLarkCodexReply } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until(check: () => boolean, label: string) {
  const end = Date.now() + 9000;
  while (!check()) {
    assert(Date.now() < end, label);
    await delay(25);
  }
}

for (const nativeEvidence of [true,false]) {
  test(nativeEvidence ? "socket steer survives lost acknowledgement and restores final reply to the appended input"
    : "socket steer without native input evidence remains held and is not replayed", { timeout: 25_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(),"lark-socket-steer-"));
    const control = mkdtempSync("/tmp/lark-steer-");
    const socket = path.join(control,"c.sock");
    const server = http.createServer();
    const wss = new WebSocketServer({server});
    const threadId = "fixture-thread", turnId = "fixture-turn";
    let starts = 0, steers = 0, resumes = 0, itemReads = 0;
    let mainPeer: WebSocket | undefined;
    let complete = false;
    const initial = { id: "first", type: "userMessage", clientId: "om_first" };
    const appended = { id: "second", type: "userMessage", clientId: "om_followup" };
    const final = { id: "answer", type: "agentMessage", phase: "final_answer", text: "confirmed combined answer" };
    const items: Record<string, unknown>[] = [initial];
    const send = (peer: WebSocket, message: unknown) => peer.send(JSON.stringify(message));
    wss.on("connection", peer => peer.on("message", payload => {
      const rpc = JSON.parse(payload.toString()), params = rpc.params ?? {};
      const reply = (result: unknown) => send(peer,{id:rpc.id,result});
      if (rpc.method === "thread/start") reply({thread:{id:threadId}});
      else if (rpc.method === "turn/start") {
        mainPeer = peer; starts++;
        reply({turn:{id:turnId}});
      } else if (rpc.method === "turn/steer") {
        steers++;
        assert.equal(peer,mainPeer);
        assert.equal(params.expectedTurnId,turnId);
        assert.equal(params.clientUserMessageId,"om_followup");
        // Lose both the ack and any push notification about the new input.
        peer.terminate();
      } else if (rpc.method === "thread/resume") {
        mainPeer=peer; resumes++;
        reply({thread:{id:threadId}});
      } else if (rpc.method === "thread/read") {
        reply({thread:{id:threadId,status:{type:complete?"idle":"active"}}});
      } else if (rpc.method === "thread/turns/list") {
        reply({data:[{id:turnId,status:complete?"completed":"inProgress"}],nextCursor:null});
      } else if (rpc.method === "thread/items/list") {
        itemReads++;
        reply({data:items.map(item=>({turnId,item})),nextCursor:null});
      } else if (rpc.method && rpc.id !== undefined) reply({});
    }));
    server.listen(socket);await once(server,"listening");
    const replies: Array<{messageId:string;text:string}> = [];
    const setup = () => createRuntime({
      databasePath:path.join(root,"test.sqlite"),mode:"active",workspaceRoot:root,trustedSenderIds:[],
      approverId:"ou_owner",runtimeToken:"fixture",codexSocket:socket,
      reactionSender:()=>({ok:true}),textReplySender:(messageId,text)=>{
        replies.push({messageId,text}); return {ok:true,messageId:"om_answer",chatId:"oc_fixture",messageAt:null,messageType:"text"};
      }
    });
    let runtime = setup();
    const db=()=>runtime.store.db;
    const row=(id:number)=>db().prepare("SELECT codex_turn_id,codex_status,reply_status FROM lark_messages WHERE id=?").get(id) as
      {codex_turn_id:string|null;codex_status:string;reply_status:string};
    try {
      runtime.store.setSetting("executionReceiptsEnabled","false");
      runtime.store.setSetting("stickerUsageMode","off");
      const seed=(...values: [number,string,string,string])=>db().prepare(`INSERT INTO lark_messages
        (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,mentioned,reply_trigger,reply_status,codex_status,content,raw_json,received_at,created_at)
        VALUES(?,?,'oc_fixture','p2p',?,'user','text',1,'p2p','pending','skipped',?,'{}','2026-11-24','2026-11-24')`).run(...values);
      seed(1,"om_first","ou_requester","first input");assert(enqueueLarkCodexReply(1));
      await until(()=>row(1).codex_turn_id===turnId,"original turn not started");
      seed(2,"om_followup","ou_requester","follow-up input");assert(enqueueLarkCodexReply(2));
      await until(()=>steers===1&&itemReads>0,"same-turn append or recovery readback missing");
      assert.equal(row(2).codex_turn_id,turnId);
      if (nativeEvidence) {
        // The replacement runtime has no original in-memory run or ack.
        await runtime.app.close();runtime.stop();
        items.push(appended);
        runtime=setup();
        await until(()=>resumes===1,"original turn did not resume");
        assert.equal(db().prepare("SELECT state FROM lark_native_socket_steers WHERE message_id=2").pluck().get(),"seen");
        seed(3,"om_unrelated","ou_someoneelse","independent request");assert(enqueueLarkCodexReply(3));
        await delay(100);
        assert.equal(row(3).codex_status,"queued");
        complete=true;items.push(final);
        send(mainPeer!,{method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
        await until(()=>row(2).reply_status==="sent","combined final answer was not delivered");
        assert.equal(row(1).codex_status,"answered");
        assert.deepEqual(replies,[{messageId:"om_followup",text:"confirmed combined answer"}]);
        assert.equal(db().prepare("SELECT count(*) FROM lark_native_socket_steers").pluck().get(),0);
      } else {
        await delay(750);
        assert.equal(resumes,0);
        assert.equal(db().prepare("SELECT state FROM lark_native_socket_steers WHERE message_id=2").pluck().get(),"pending");
        assert.deepEqual(replies,[]);
      }
      assert.equal(starts,1);
      assert.equal(steers,1);
    } finally {
      await runtime.app.close();runtime.stop();
      for (const peer of wss.clients) peer.terminate();
      await Promise.all([new Promise<void>(r=>wss.close(()=>r())),new Promise<void>(r=>server.close(()=>r()))]);
      rmSync(root,{recursive:true,force:true});rmSync(control,{recursive:true,force:true});
    }
  });
}
