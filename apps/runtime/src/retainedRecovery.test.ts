import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { config as conversationConfig, enqueueLarkCodexReply, larkCodexAppServerStatus, larkShutdownBlockingTurnCount, listenRetainedExecutionHost,
  onLarkTurnObservation, retryPendingLarkTextReplies, type ExecutionEngine, type LarkTurnObservation } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until(predicate: () => boolean) {
  const end = Date.now() + 12_000;
  while (!predicate()) {
    assert(Date.now() < end, "retained Lark fixture timed out");
    await delay(30);
  }
}

for (const id of ["claude", "dsh", "opencode", "agy"] as const) {
  test(id + ": Lark restarts, reuses the original card, and delivers once", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lark-retained-runtime-"));
    const socketRoot = mkdtempSync("/tmp/lark-retained-runtime-");
    const socketPath = path.join(socketRoot, "e.sock");
    const token = randomBytes(32).toString("hex");
    let runs = 0, effects = 0;
    const cards: number[] = [];
    const replies: string[] = [];
    const observations: LarkTurnObservation[] = [];
    const engine: ExecutionEngine = {
      descriptor: { id, label: id, models: [] }, supportsNativeApproval: true, supportsPolicy: () => true,
      async open({ authorizeNative }) {
        return {
          id: "session-" + id,
          async run(_text, signal, observe) {
            runs++;
            observe?.({ type: "work", stage: "read" });
            const allowed = await authorizeNative!({ engineId: id, cwd: root, text: "fixture_read" }, signal, () => !signal.aborted);
            if (allowed) effects++;
            return { status: "completed", text: allowed ? "confirmed reply" : "no operation" };
          },
          close() {}
        };
      }
    };
    function startHost() { return listenRetainedExecutionHost({ socketPath, token, workspace: root, engines: [engine] }); }
    let host = await startHost();
    const setup = () => {
      const runtime = createRuntime({
      databasePath: path.join(root, "runtime.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [],
      runtimeToken: "fixture-auth", approverId: "ou_owner", executionEngines: [engine],
      retainedEngineHost: { socketPath, token, engineIds: [id] },
      reactionSender: () => ({ ok: true }),
      approvalCardSender: (_recipient, card) => {
        cards.push(card.approvalId);
        return { ok: true, messageId: "om_card_" + card.approvalId, chatId: "oc_fixture", messageAt: null, messageType: "interactive" };
      },
      approvalCardUpdater: () => ({ ok: true }),
      progressSender: async () => ({ ok: true, messageId: "om_progress", chatId: "oc_fixture", messageAt: null, messageType: "interactive" }),
      progressUpdater: async () => ({ ok: true }),
      textReplySender: (_messageId, text) => {
        replies.push(text);
        return { ok: true, messageId: "om_out_" + replies.length, chatId: "oc_fixture", messageAt: null, messageType: "text" };
      }
      });
      const subscription = onLarkTurnObservation(runtime.store.db, event => { observations.push(event); });
      runtime.app.addHook("onClose", async () => { await subscription.drain(); subscription.close(); });
      return runtime;
    };
    const previousDelay = conversationConfig.larkCodexInterimReplyDelayMs;
    conversationConfig.larkCodexInterimReplyDelayMs = 900;
    let runtime = setup();
    const closeRuntime = async () => { await runtime.app.close(); runtime.stop(); };
    const row = (number: number) => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE id=?").get(number) as
      { codex_turn_id: string; codex_status: string; codex_dispatch_phase: string; reply_status: string };
    const add = (number: number, state: string) => runtime.store.db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,mentioned,reply_trigger,reply_status,codex_status,content,raw_json,received_at,created_at)
      VALUES(?, ?, 'oc_fixture', 'p2p','ou_sender','user','text',1,'p2p','pending',?,'fixture question','{}','2026-11-23','2026-11-23')`)
      .run(number, "om_in_" + number, state);
    const click = (approvalId: number, actor = "ou_owner", cardMessageId = "om_card_" + approvalId) => runtime.decideApprovalFromCard({
      action_value: { approval_id: approvalId, action: "approve-turn" }, operator_id: actor, message_id: cardMessageId
    });
    try {
      add(1,"answered");
      assert.equal((await runtime.app.inject({ method: "PUT", url: "/v1/chats/oc_fixture/execution",
        headers: { authorization: "Bearer fixture-auth" }, payload: { override: { engineId: id, model: null } } })).statusCode, 200);
      add(2,"skipped");
      assert(enqueueLarkCodexReply(2));
      await until(() => cards.length === 1);
      const originalTurn = row(2).codex_turn_id;
      const original = cards[0]!;
      assert.equal(effects, 0);
      assert.equal(larkCodexAppServerStatus().activeTurns, 1);
      assert.equal(larkShutdownBlockingTurnCount(), 0);
      await until(() => observations.some(event => event.kind === "turn.progress" && event.turnId === originalTurn && event.progressKey === "work:read"));
      await closeRuntime();
      runtime = setup();
      assert.equal(runtime.store.approval(original)?.status, "pending");
      assert.equal(row(2).codex_turn_id, originalTurn);
      assert.equal((await click(original,"ou_other")).ok, false);
      assert.equal((await click(original,"ou_owner","om_wrong")).ok, false);
      const deadline = Date.now() + 8_000;
      while (!(await click(original)).ok) {
        assert(Date.now() < deadline, "original card did not attach");
        await delay(40);
      }
      assert.equal((await click(original)).ok, false);
      await until(() => row(2).reply_status === "sent");
      assert.equal(runs,1);
      assert.equal(effects,1);
      assert.equal(row(2).codex_turn_id, originalTurn);
      assert.deepEqual(cards,[original]);
      assert.deepEqual(replies,["confirmed reply"]);
      await until(() => observations.some(event => event.kind === "turn.finished" && event.turnId === originalTurn));
      assert.deepEqual(observations.flatMap(event => event.kind === "turn.finished" && event.turnId === originalTurn ? [event.outcome] : []), ["completed"]);
      await closeRuntime();
      runtime = setup();
      assert.equal(retryPendingLarkTextReplies(),0);
      assert.equal((await click(original)).ok,false);
      assert.equal(runs,1);

      if (id === "dsh") {
        add(9,"skipped");
        assert(enqueueLarkCodexReply(9));
        await until(() => cards.length === 2);
        // Model a crash between the durable human decision and its IPC response.
        runtime.store.db.prepare("UPDATE lark_capability_approvals SET status='approved',approval_scope='turn',decided_at=? WHERE id=?")
          .run(new Date().toISOString(), cards[1]);
        assert.equal(effects,1);
        await closeRuntime();
        runtime = setup();
        await until(() => row(9).reply_status === "sent");
        assert.equal(effects,2);
        assert.equal(runs,2);
        assert.equal(cards.length,2);

        add(20,"skipped");
        assert(enqueueLarkCodexReply(20));
        await until(() => cards.length === 3);
        const pending = cards[2]!;
        await closeRuntime();
        await host.close();
        host = await startHost();
        runtime = setup();
        await until(() => row(20).codex_dispatch_phase === "needs_review");
        runtime.expireApprovals();
        assert.equal((await click(pending)).ok,false);
        assert.equal(effects,2);
        assert.equal(runs,3);
        assert.deepEqual(replies,["confirmed reply","confirmed reply"]);
      }
    } finally {
      conversationConfig.larkCodexInterimReplyDelayMs = previousDelay;
      await runtime.app.close();
      if (runtime.store.db.open) runtime.stop();
      await host.close();
      rmSync(root,{recursive:true,force:true});
      rmSync(socketRoot,{recursive:true,force:true});
    }
  });
}

test("Codex reattaches to the native socket, recovers the original Lark card and replies once", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lark-native-recovery-"));
  const socketRoot = mkdtempSync("/tmp/lark-native-test-");
  const socketPath = path.join(socketRoot, "c.sock");
  const server = http.createServer();
  const websocket = new WebSocketServer({ server });
  const threadId = "fixture-thread", turnId = "fixture-turn";
  const request = { id: "request-original", method: "item/commandExecution/requestApproval", params: {
    threadId, turnId, itemId: "item-original", command: "printf fixture-only", cwd: root
  } };
  let starts = 0, granted = 0, running = false, ready = false, resumed = 0;
  const finalItem = { id: "fixture-answer", type: "agentMessage", phase: "final_answer", text: "confirmed native reply" };
  websocket.on("connection", peer => peer.on("message", data => {
    const rpc = JSON.parse(data.toString());
    const send = (value: unknown) => peer.send(JSON.stringify(value));
    const result = (value: unknown) => send({ id: rpc.id, result: value });
    if (rpc.method === "thread/start") result({ thread: { id: threadId } });
    else if (rpc.method === "thread/resume") {
      resumed++;
      result({ thread: { id: threadId } });
      if (running && ready) send(request);
    } else if (rpc.method === "turn/start") {
      starts++;
      running = true;
      result({ turn: { id: turnId } });
    } else if (rpc.method === "thread/read") {
      result({ thread: { id: threadId, status: { type: running ? "active" : "idle" } } });
    } else if (rpc.method === "thread/turns/list") {
      result({ data: [{ id: turnId, status: running ? "inProgress" : "completed", items: [] }] });
    } else if (rpc.method === "thread/items/list") {
      result({ data: [{ turnId, item: finalItem }], nextCursor: null });
    } else if (rpc.id === request.id && rpc.result?.decision === "accept") {
      granted++;
      running = false;
      // The reconnect may have missed the final item notification; verify native readback.
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    } else if (rpc.method && rpc.id !== undefined) result({});
  }));
  server.listen(socketPath);
  await once(server, "listening");
  const cards: number[] = [], replies: string[] = [];
  const setup = () => createRuntime({
    databasePath: path.join(root, "runtime.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [],
    approverId: "ou_owner", runtimeToken: "fixture-auth", codexSocket: socketPath, reactionSender: () => ({ ok: true }),
    approvalCardSender: (_recipient, card) => {
      cards.push(card.approvalId);
      return { ok: true, messageId: "om_original_card", chatId: "oc_fixture", messageAt: null, messageType: "interactive" };
    },
    approvalCardUpdater: () => ({ ok: true }),
    textReplySender: (_messageId, text) => {
      replies.push(text);
      return { ok: true, messageId: "om_reply", chatId: "oc_fixture", messageAt: null, messageType: "text" };
    }
  });
  let runtime = setup();
  const closeRuntime = async () => { await runtime.app.close(); runtime.stop(); };
  const turn = () => runtime.store.db.prepare("SELECT codex_turn_id FROM lark_messages WHERE id=1").pluck().get();
  try {
    runtime.store.setSetting("executionReceiptsEnabled","false");
    runtime.store.setSetting("stickerUsageMode","off");
    runtime.store.db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,mentioned,reply_trigger,reply_status,codex_status,content,raw_json,received_at,created_at)
      VALUES(1,'om_native','oc_fixture','p2p','ou_sender','user','text',1,'p2p','pending','skipped','fixture question','{}','2026-11-23','2026-11-23')`).run();
    assert(enqueueLarkCodexReply(1));
    await until(() => turn() === turnId);
    ready = true;
    for (const peer of websocket.clients) peer.send(JSON.stringify(request));
    await until(() => cards.length === 1);
    assert.equal(granted,0);
    const approval = cards[0]!;
    await closeRuntime();
    const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import path from "node:path";
      import { setTimeout as delay } from "node:timers/promises";
      import { createRuntime } from "./apps/runtime/src/index.ts";
      const [root, codexSocket, initialApproval] = process.argv.slice(1);
      const approval = Number(initialApproval);
      const replies = [];
      const runtime = createRuntime({
        databasePath: path.join(root,"runtime.sqlite"), workspaceRoot:root, codexSocket, mode:"active", trustedSenderIds:[],
        approverId:"ou_owner", runtimeToken:"fixture-auth", reactionSender:()=>({ok:true}),
        approvalCardSender:()=>{throw new Error("Duplicated card")},
        approvalCardUpdater:()=>({ok:true}),
        textReplySender:(_messageId,text)=>{
          replies.push(text);
          return {ok:true,messageId:"om_reply",chatId:"oc_fixture",messageAt:null,messageType:"text"};
        }
      });
      const click = () => runtime.decideApprovalFromCard({
        action_value:{approval_id:approval,action:"approve-turn"},operator_id:"ou_owner",message_id:"om_original_card"
      });
      try {
        assert.equal(runtime.store.approval(approval)?.status,"pending");
        assert.equal((await click()).ok,true);
        assert.equal((await click()).ok,false);
        const end = Date.now() + 5000;
        while (runtime.store.db.prepare("SELECT reply_status FROM lark_messages WHERE id=1").pluck().get() !== "sent") {
          assert(Date.now() < end, "missing restored final reply");
          await delay(25);
        }
        console.log(JSON.stringify(replies));
      } finally { await runtime.app.close(); runtime.stop(); }
    `, root, socketPath, String(approval)], { timeout: 15_000 });
    replies.push(...JSON.parse(child.stdout.trim().split("\n").at(-1)!));
    runtime = setup();
    assert.equal(turn(),turnId);
    assert.equal(starts,1);
    assert.equal(resumed,1);
    assert.equal(granted,1);
    assert.deepEqual(cards,[approval]);
    assert.deepEqual(replies,["confirmed native reply"]);
    assert.equal(retryPendingLarkTextReplies(),0);
    assert.deepEqual(replies,["confirmed native reply"]);
  } finally {
    await runtime.app.close();
    if (runtime.store.db.open) runtime.stop();
    for (const peer of websocket.clients) peer.terminate();
    await Promise.all([new Promise<void>(resolve => websocket.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))]);
    rmSync(root,{recursive:true,force:true});
    rmSync(socketRoot,{recursive:true,force:true});
  }
});
