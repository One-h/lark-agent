import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { enqueueLarkCodexReply, larkCodexAppServerStatus } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until(predicate: () => boolean, context: string) {
  const deadline = Date.now() + 12_000;
  while (!predicate()) {
    assert(Date.now() < deadline, context);
    await delay(25);
  }
}

test("oversize shared messages reattach both live turns and a later oversize readback stays isolated", { timeout: 40_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lark-socket-overflow-"));
  const socketRoot = mkdtempSync("/tmp/lark-limit-");
  const socketPath = path.join(socketRoot, "c.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const byThread = new Map<string, WebSocket>();
  const state = new Map<string, string>();
  const resumed = new Map<string, number>();
  let starts = 0, created = 0, accepted = 0, readbackOverflow = false;
  let oversizeReadbackPeer: WebSocket | undefined;
  const approval = { id: "native-once", method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "printf isolated-fixture", cwd: root
  } };
  const answer = (turnId: string) => ({ id: turnId + "-answer", type: "agentMessage", phase: "final_answer", text: "answer-" + turnId });
  const send = (peer: WebSocket, value: unknown) => peer.send(JSON.stringify(value));
  const complete = (threadId: string, sendAnswer: boolean) => {
    const turnId = threadId.replace("thread", "turn"), peer = byThread.get(threadId)!;
    state.set(turnId, "completed");
    if (sendAnswer) send(peer, { method: "item/completed", params: { threadId, turnId, item: answer(turnId) } });
    send(peer, { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  };
  wss.on("connection", peer => peer.on("message", payload => {
    const rpc = JSON.parse(payload.toString());
    const p = rpc.params ?? {};
    const reply = (result: unknown) => send(peer, { id: rpc.id, result });
    if (rpc.method === "thread/start") {
      reply({ thread: { id: "thread-" + (++created) } });
    } else if (rpc.method === "turn/start") {
      const turnId = p.threadId.replace("thread", "turn");
      starts++;
      state.set(turnId, "inProgress");
      byThread.set(p.threadId, peer);
      reply({ turn: { id: turnId } });
    } else if (rpc.method === "thread/resume") {
      assert.equal(p.excludeTurns, true);
      byThread.set(p.threadId, peer);
      resumed.set(p.threadId, (resumed.get(p.threadId) ?? 0) + 1);
      reply({ thread: { id: p.threadId } });
      if (p.threadId === "thread-1" && !accepted) send(peer, approval);
    } else if (rpc.method === "thread/read") {
      assert.equal(p.includeTurns, false);
      const running = state.get(p.threadId.replace("thread", "turn")) === "inProgress";
      reply({ thread: { id: p.threadId, status: { type: running ? "active" : "idle" } } });
    } else if (rpc.method === "thread/turns/list") {
      const turnId = p.threadId.replace("thread", "turn");
      reply({ data: [{ id: turnId, status: state.get(turnId), items: [] }], nextCursor: null });
    } else if (rpc.method === "thread/items/list") {
      assert(peer !== byThread.get(p.threadId), "terminal readback must not use the event subscription");
      if (p.turnId === "turn-1" && !readbackOverflow) {
        oversizeReadbackPeer = peer;
        readbackOverflow = true;
        reply({ padding: "x".repeat(1_100_000) });
      } else if (!p.cursor) {
        assert.equal(p.limit, 10);
        reply({ data: [{ turnId: p.turnId, item: { id: "meta", type: "plan" } }], nextCursor: "next-page" });
      } else {
        assert.equal(p.cursor, "next-page");
        reply({ data: [{ turnId: p.turnId, item: answer(p.turnId) }], nextCursor: null });
      }
    } else if (rpc.id === approval.id && rpc.result?.decision === "accept") {
      accepted++;
    } else if (rpc.method && rpc.id !== undefined) reply({});
  }));
  server.listen(socketPath);
  await once(server, "listening");
  const replies: string[] = [], cards: number[] = [];
  const runtime = createRuntime({
    databasePath: path.join(root,"test.sqlite"), mode:"active", workspaceRoot:root, trustedSenderIds:[],
    approverId:"ou_owner", runtimeToken:"fixture-auth", codexSocket:socketPath, codexSocketMaxPayloadMiB:1,
    reactionSender:()=>({ok:true}),
    approvalCardSender:(_recipient,card)=>{ cards.push(card.approvalId); return {ok:true,messageId:"om_original"}; },
    approvalCardUpdater:()=>({ok:true}),
    textReplySender:(_messageId,text)=>{ replies.push(text); return {ok:true,messageId:"om_reply"+replies.length,
      chatId:"oc_fixture",messageAt:null,messageType:"text"}; }
  });
  const db=runtime.store.db;
  const row=(id:number)=>db.prepare("SELECT codex_turn_id,codex_status,reply_status FROM lark_messages WHERE id=?").get(id) as
    {codex_turn_id:string;codex_status:string;reply_status:string};
  const click=()=>runtime.decideApprovalFromCard({ action_value:{approval_id:cards[0],action:"approve-turn"},
    operator_id:"ou_owner",message_id:"om_original" });
  try {
    runtime.store.setSetting("executionReceiptsEnabled","false");
    runtime.store.setSetting("stickerUsageMode","off");
    const seed=db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(?,?,?,'p2p','ou_sender','user','text','fixture request',1,'p2p','pending','skipped','{}','2026-11-23','2026-11-23')`);
    seed.run(1,"om_input1","oc_first");assert(enqueueLarkCodexReply(1));
    await until(()=>row(1).codex_turn_id==="turn-1","first turn did not start");
    seed.run(2,"om_input2","oc_second");assert(enqueueLarkCodexReply(2));
    await until(()=>row(2).codex_turn_id==="turn-2","second turn did not start");
    const firstPeer=byThread.get("thread-1")!;
    assert.equal(firstPeer,byThread.get("thread-2"));
    send(firstPeer,approval);
    await until(()=>cards.length===1,"original approval card not delivered");
    send(firstPeer,{method:"fixture/oversize",params:{padding:"x".repeat(1_100_000)}});
    await until(()=>firstPeer.readyState===firstPeer.CLOSED,"oversize socket stayed open");
    assert.equal(row(1).codex_status,"running");
    assert.equal(row(2).codex_status,"running");
    assert.equal(runtime.store.approval(cards[0]!)?.status,"pending");
    await until(()=>resumed.size===2,"original live turns did not reattach");
    assert.equal(starts,2);
    assert.equal(larkCodexAppServerStatus().activeTurns,2);
    const newPeer=byThread.get("thread-1")!;
    assert.notEqual(firstPeer,newPeer);assert.equal(newPeer,byThread.get("thread-2"));
    assert.equal((await click()).ok,true);
    assert.equal((await click()).ok,false);
    await until(()=>accepted===1,"original native approval was not answered");
    complete("thread-1",false);
    await until(()=>oversizeReadbackPeer?.readyState===oversizeReadbackPeer?.CLOSED && readbackOverflow,"readback socket did not overflow");
    assert.notEqual(oversizeReadbackPeer,newPeer);
    assert.equal(newPeer.readyState,newPeer.OPEN);
    complete("thread-2",true);
    await until(()=>row(1).reply_status==="sent" && row(2).reply_status==="sent","final replies did not complete");
    assert.equal(byThread.get("thread-2"), newPeer);
    assert.deepEqual(replies.slice().sort(),["answer-turn-1","answer-turn-2"]);
    assert.equal(cards.length,1);assert.equal(starts,2);assert.equal(accepted,1);
  } finally {
    await runtime.app.close(); runtime.stop();
    for(const peer of wss.clients) peer.terminate();
    await Promise.all([new Promise<void>(r=>wss.close(()=>r())),new Promise<void>(r=>server.close(()=>r()))]);
    rmSync(root,{recursive:true,force:true});rmSync(socketRoot,{recursive:true,force:true});
  }
});
