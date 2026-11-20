import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueLarkCodexReply, retryPendingAutoApprovalNotifications } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert(Date.now() < deadline, "approval fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const manual of [false, true]) test(`whole task approval reviews a bounded log task once (${manual ? "manual" : "automatic"})`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-whole-turn-"));
  const executable = path.join(root, "fixture.mjs"), outcomes = path.join(root, "outcomes.json");
  const cmds = [
    '/bin/zsh -lc "kubectl logs deploy/demo-api --namespace=production --tail=20"',
    "kubectl logs deploy/demo-api --namespace=production --tail=100 --since=20m",
    "kubectl logs deploy/demo-worker --namespace=production --tail=20",
    "kubectl logs deploy/demo-api --namespace=staging --tail=20",
    "kubectl apply -f fixture.yaml"
  ];
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";
import fs from "node:fs";
const commands=${JSON.stringify(cmds)},accepted={},ids={threadId:"fixture-thread",turnId:"fixture-turn"};
const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");
const call=i=>send({id:"approval-"+i,method:"item/commandExecution/requestApproval",params:{...ids,itemId:"item-"+i,command:commands[i],cwd:${JSON.stringify(root)}}});
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start")send({id:m.id,result:{thread:{id:ids.threadId}}});
 else if(m.method==="turn/start"){
  send({id:m.id,result:{turn:{id:ids.turnId,status:"inProgress"}}});
  setTimeout(()=>{call(0);call(1)},30);
 }else if(m.method==="thread/read")send({id:m.id,result:{thread:{id:ids.threadId,status:{type:"active"}}}});
 else if(m.method==="thread/turns/list")send({id:m.id,result:{data:[{id:ids.turnId,status:"inProgress"}]}});
 else if(m.method)send({id:m.id,result:{}});
 else if(String(m.id).startsWith("approval-")){
  accepted[m.id]=m.result?.decision;
  if(Object.keys(accepted).length===2){call(2);call(3);call(4)}
  if(Object.keys(accepted).length===commands.length){
   fs.writeFileSync(${JSON.stringify(outcomes)},JSON.stringify(accepted));
   const item={type:"agentMessage",id:"final",phase:"final_answer",text:"Fixture complete"};
   send({method:"item/completed",params:{...ids,item}});
   send({method:"turn/completed",params:{...ids,turn:{id:ids.turnId,status:"completed",items:[item]}}});
  }
 }
});`, { mode: 0o700 });
  const oldExecutable = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = executable;
  let reviews = 0, notices = 0;
  const cards: Array<{ approvalId: number; wholeTask?: boolean }> = [];
  const runtime = createRuntime({ databasePath: path.join(root, "fixture.sqlite"), mode: "shadow", workspaceRoot: root,
    trustedSenderIds: [], approverId: "ou_owner", runtimeToken: "fixture-token",
    turnApprovalReviewer: async input => {
      reviews++;
      assert.equal(input.wholeTask, true);
      assert.equal(input.originalMessage, "检查生产 demo-api 服务日志");
      return { decision: manual ? "approve_once" : "approve_turn", reason: "Fixture reviewer" };
    },
    approvalCardSender: (_owner, card) => { cards.push(card); return { ok: true, messageId: "om_fixture_card" }; },
    approvalCardUpdater: () => {},
    autoApprovalNotificationSender: async () => {
      notices++; return { ok: true, messageId: "om_fixture_notice", chatId: null, messageAt: null, messageType: "interactive" };
    },
    textReplySender: () => ({ ok: true, messageId: "om_result", chatId: null, messageAt: null, messageType: "text" }) });
  try {
    const db = runtime.store.db;
    const now = new Date().toISOString();
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true, executionReceiptsEnabled: false } });
    db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(1,'om_request','oc_fixture','p2p','ou_user','text','检查生产 demo-api 服务日志',1,'p2p','skipped','failed','{}',?,?)`).run(now, now);
    assert.equal(enqueueLarkCodexReply(1), true);
    if (manual) {
      await until(() => cards.length === 1);
      assert.equal(cards[0].wholeTask, true);
      assert.equal(fs.existsSync(outcomes), false);
      const headers = { authorization: "Bearer fixture-token" }, url = `/v1/approvals/${cards[0].approvalId}`;
      assert.equal((await runtime.app.inject({ method: "POST", url: url+"/approve", headers })).statusCode, 409);
      assert.equal((await runtime.app.inject({ method: "POST", url: url+"/approve-turn", headers })).statusCode, 200);
    }
    await until(() => fs.existsSync(outcomes));
    const row = () => db.prepare("SELECT codex_status FROM lark_messages WHERE id=1").pluck().get();
    await until(() => row() === "answered");
    assert.deepEqual(JSON.parse(fs.readFileSync(outcomes, "utf8")), {
      "approval-0": "accept", "approval-1": "accept", "approval-2": "decline", "approval-3": "decline", "approval-4": "decline"
    });
    assert.equal(reviews, 1);
    assert.equal(cards.length, manual ? 1 : 0);
    await retryPendingAutoApprovalNotifications();
    assert.equal(notices, manual ? 0 : 1);
  } finally {
    await runtime.app.close(); runtime.stop();
    if (oldExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldExecutable;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
