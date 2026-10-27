import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { hasLarkManualTurnApproval, waitForTurnAuthorization } from "./approvalLifecycle.js";

test("manual grants bind their thread, turn, requester and approver and never trust an automatic row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-shared-grants-"));
  const store = new SqliteAgentStore(path.join(root, "agent.sqlite"));
  try {
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO lark_messages(id,sender_id,codex_session_id,raw_json,received_at,created_at) VALUES (1,'ou_sender','thread-one','{}',?,?)").run(now, now);
    store.db.prepare(`INSERT INTO lark_execution_approvals
      (token,lark_message_id,requester_id,approver_id,request_method,server_request_id,thread_id,turn_id,item_id,status,approval_scope,card_message_id,created_at,expires_at)
      VALUES ('fixture',1,'ou_sender','ou_owner','fixture','fixture','thread-one','turn-one','fixture','approved','turn',NULL,?,?)`).run(now, now);
    const binding = { turnId: "turn-one", threadId: "thread-one", senderId: "ou_sender", approverId: "ou_owner" };
    assert.equal(hasLarkManualTurnApproval(store.db, binding), false);
    store.db.prepare("UPDATE lark_execution_approvals SET card_message_id='om_native'").run();
    assert.equal(hasLarkManualTurnApproval(store.db, binding), true);
    for (const patch of [{ turnId: "new-turn" }, { threadId: "other-thread" }, { senderId: "ou_other" }, { approverId: "ou_other" }])
      assert.equal(hasLarkManualTurnApproval(store.db, { ...binding, ...patch }), false);
    store.db.prepare("UPDATE lark_execution_approvals SET approval_scope='once'").run();
    assert.equal(hasLarkManualTurnApproval(store.db, binding), false);
    const id = store.createApproval({ larkMessageId: 1, turnId: "turn-one", capabilityId: "fixture", operation: "fixture", approverId: "ou_owner", expiresAt: now });
    store.setApprovalCardMessage(id, "om_capability"); store.decideApproval(id, "approved");
    assert.equal(hasLarkManualTurnApproval(store.db, binding), false);
    store.db.prepare("UPDATE lark_capability_approvals SET approval_scope='turn' WHERE id=?").run(id);
    assert.equal(hasLarkManualTurnApproval(store.db, binding), true);
    store.db.prepare("UPDATE lark_messages SET sender_id='ou_changed',codex_session_id='other-thread' WHERE id=1").run();
    assert.equal(hasLarkManualTurnApproval(store.db, binding), false);
    assert.equal(hasLarkManualTurnApproval(store.db, { ...binding, senderId: "ou_changed", threadId: "other-thread" }), false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("authorization wait cancels immediately without converting a late reviewer result into execution", async () => {
  let release!: (value: boolean) => void;
  const result = new Promise<boolean>(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = waitForTurnAuthorization(result, controller.signal); controller.abort();
  await assert.rejects(pending, /cancelled/); release(true);
  await assert.rejects(waitForTurnAuthorization(Promise.resolve(true), controller.signal), /cancelled/);
});

test("legacy capability approvals migrate as single-call grants without rewriting old records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-approval-schema-"));
  const file = path.join(root, "agent.sqlite"); let store = new SqliteAgentStore(file);
  try {
    store.db.prepare("INSERT INTO lark_capability_approvals(lark_message_id,operation,approver_id,status,expires_at,created_at) VALUES(1,'kept operation','ou_owner','approved','2026-01-01','2026-01-01')").run();
    store.db.exec(`DROP INDEX idx_lark_capability_turn_grant;
      ALTER TABLE lark_capability_approvals DROP COLUMN approval_scope;
      ALTER TABLE lark_capability_approvals DROP COLUMN error;
      ALTER TABLE lark_capability_approvals DROP COLUMN requester_id;
      ALTER TABLE lark_capability_approvals DROP COLUMN thread_id;`);
    store.close(); store = new SqliteAgentStore(file);
    const row = store.approval(1)!;
    assert.equal(row.operation, "kept operation"); assert.equal(row.status, "approved");
    assert.equal(row.approval_scope, "once"); assert.equal(row.requester_id, null); assert.equal(row.thread_id, null);
    assert.equal(row.error, null);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
