import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./index.js";

test("approval history separates turn decisions and human cards, paginates, and never returns tokens", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-approval-history-"));
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: [], runtimeToken: "secret" });
  const db = runtime.store.db;
  const headers = { authorization: "Bearer secret" };
  const get = (url: string) => runtime.app.inject({ method: "GET", url, headers });
  try {
    const now = "2026-10-13T07:00:00.000Z";
    db.prepare("INSERT INTO contacts(open_id,name,source,created_at,updated_at) VALUES ('ou_sender','测试同事','test',?,?)").run(now,now);
    db.prepare("INSERT INTO lark_messages(id,sender_id,content,codex_session_id,raw_json,received_at,created_at) VALUES (1,'ou_sender','please review team/repo','session-one','{}',?,?)").run(now,now);
    const execution = db.prepare(`INSERT INTO lark_execution_approvals
      (id,token,lark_message_id,requester_id,approver_id,request_method,server_request_id,thread_id,turn_id,item_id,operation,cwd,status,approval_scope,card_message_id,created_at,expires_at,decided_at)
      VALUES (?, ?,1,'ou_sender','ou_owner','command','request','thread',?,'item','git diff','/tmp/work',?,'turn',?,?,?,?)`);
    execution.run(1,"never-expose-this-token","old-turn","approved","om_card",now,now,now);
    execution.run(2,"derived-operation-secret","current-turn","approved",null,now,now,now);
    execution.run(3,"pending-secret","pending-turn","pending","om_pending",now,now,null);
    const auto = db.prepare(`INSERT INTO lark_turn_auto_reviews
      (id,lark_message_id,turn_id,requester_id,approver_id,source,decision,reason,matched_approval_id,model,usage_json,created_at,completed_at,applied_at)
      VALUES (?,1,?,'ou_sender','ou_owner',?,?,'test reason',?,?,?, ?,?,?)`);
    auto.run(1,"current-turn","history","approved",1,null,null,now,now,now);
    auto.run(2,"model-turn","model","approved",null,"gpt-6.1-sol",'{"input_tokens":120}',now,now,null);
    auto.run(3,"manual-turn","manual","manual",null,null,null,now,now,null);
    db.prepare("INSERT INTO lark_capability_approvals(lark_message_id,operation,approver_id,status,expires_at,created_at) VALUES (1,'deploy','ou_owner','rejected',?,?)").run(now,now);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/approval-history" })).statusCode,401);
    const initial = (await get("/v1/approval-history")).json();
    assert.equal(initial.total,3);
    assert.equal(initial.items.length,3);
    assert.equal(initial.items[0].requesterName,"测试同事");
    assert.deepEqual(initial.summary,{historyApproved:1,modelApproved:1,manualRequired:1,pendingHuman:1});
    assert.equal(Object.hasOwn(initial.items[0],"operation"),false);
    const page = (await get("/v1/approval-history?source=history&status=approved&limit=1")).json();
    assert.deepEqual(page.items.map((r: { id: number })=>r.id),[1]);
    assert.equal((await get("/v1/approval-history?offset=1&limit=1")).json().items.length,1);
    assert.equal((await get("/v1/approval-history?offset=9")).json().items.length,0);
    assert.equal((await get("/v1/approval-history?q=%E6%B5%8B%E8%AF%95%E5%90%8C%E4%BA%8B")).json().total,3);
    assert.equal((await get("/v1/approval-history?q=%25")).json().total,0);
    assert.equal((await get("/v1/approval-history?kind=manual")).json().total,3);
    assert.equal((await get("/v1/approval-history?kind=all")).json().total,6);
    const history = await get("/v1/approval-history/auto/1");
    assert.equal(history.statusCode,200);
    assert.equal(history.json().matchedApproval.id,1);
    assert.equal(history.json().matchedApproval.matchedApproval,null);
    assert.equal(history.json().operation,"git diff");
    assert.equal(history.json().sessionId,"session-one");
    assert.equal(history.json().appliedAt,now);
    const model = (await get("/v1/approval-history/auto/2")).json();
    assert.deepEqual(model.usage,{input_tokens:120});
    assert.equal(model.appliedAt,null);
    for (const url of ["/v1/approval-history?limit=101","/v1/approval-history?offset=-1","/v1/approval-history?source=bad","/v1/approval-history?kind=execution","/v1/approval-history?status=bad","/v1/approval-history?limit=1.5","/v1/approval-history/other/1","/v1/approval-history/auto/0","/v1/approval-history/auto/NaN"]) assert.equal((await get(url)).statusCode,400,url);
    assert.equal((await get("/v1/approval-history/auto/999")).statusCode,404);
    for (const url of ["/v1/approval-history?kind=all","/v1/approval-history/auto/1","/v1/approval-history/execution/1","/v1/approval-history/capability/1"]) assert.doesNotMatch((await get(url)).body,/never-expose|derived-operation-secret|pending-secret|"token"/);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root,{recursive:true,force:true}); }
});
