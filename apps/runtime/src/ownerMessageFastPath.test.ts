import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./index.js";

test("enabled owner message sends once without a card and records its narrow authorization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-owner-message-"));
  let cards = 0;
  let sends = 0;
  const runtime = createRuntime({ runtimeToken: "test-token", databasePath: path.join(root, "runtime.sqlite"), mode: "shadow",
    trustedSenderIds: ["ou_owner"], approverId: "ou_owner",
    turnActivityProbe: async () => true, approvalCardSender: () => { cards++; return { ok: false, error: "approval required" }; },
    proactiveMessageSender: () => { sends++; return { ok: true, messageId: "om_fake_send", chatId: "oc_contact", messageAt: new Date().toISOString(), messageType: "text" }; }
  });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    runtime.store.setSetting("ownerMessageFastPathEnabled", "true");
    runtime.store.setSetting("ownerMessageFastPathOwnerId", "ou_owner");
    runtime.store.db.prepare("INSERT INTO contacts (open_id,name,updated_at) VALUES (?,?,?)").run("ou_contact", "示例同事", new Date().toISOString());
    const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: { event_id: "evt-owner-message", chat_id: "oc_owner", chat_type: "p2p", sender_id: "ou_owner", sender_type: "user", message_type: "text", content: "跟示例同事说：你好" } })).json() as { id: number };
    runtime.store.db.prepare("UPDATE lark_messages SET codex_status='running',codex_turn_id='turn-owner' WHERE id=?").run(inbound.id);
    const request = { headers: { authorization: "Bearer test-token" }, method: "POST" as const, url: "/v1/internal/capabilities/lark.message.send/execute", payload: { input: { recipient: "示例同事", text: "你好" }, context: { larkMessageId: inbound.id, chatId: "oc_owner", trustScope: "trusted", turnId: "turn-owner" } } };
    const result = await runtime.app.inject(request);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json()._authorization.mode, "explicit-owner-message");
    assert.equal((await runtime.app.inject(request)).statusCode, 200);
    assert.equal(sends, 1);
    assert.equal(cards, 0);
    assert.equal((runtime.store.db.prepare("SELECT count(*) AS n FROM lark_capability_approvals").get() as { n: number }).n, 0);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime keeps cards for disabled, non-owner, ambiguous, external, sensitive and stale requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-owner-message-boundaries-"));
  let cards = 0;
  let sends = 0;
  const runtime = createRuntime({ runtimeToken: "test-token", databasePath: path.join(root, "runtime.sqlite"), mode: "shadow",
    trustedSenderIds: ["ou_owner", "ou_trusted"], approverId: "ou_owner",
    turnActivityProbe: async () => true, approvalCardSender: () => { cards++; return { ok: false, error: "approval required" }; },
    proactiveMessageSender: () => { sends++; return { ok: false, error: "must never send" }; }
  });
  try {
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().ownerMessageFastPathEnabled, false);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { ownerMessageFastPathEnabled: "true" } })).statusCode, 400);
    const enabled = (await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { ownerMessageFastPathEnabled: true } })).json();
    assert.equal(enabled.ownerMessageFastPathOwnerId, "ou_owner");
    for (const [id, name, external] of [["ou_contact", "示例同事", 0], ["ou_external", "外部同事", 1], ["ou_duplicate1", "同名同事", 0], ["ou_duplicate2", "同名同事", 0]] as const) {
      runtime.store.db.prepare("INSERT INTO contacts (open_id,name,is_cross_tenant,updated_at) VALUES (?,?,?,?)").run(id, name, external, new Date().toISOString());
    }
    const cases = [
      { enabled: false }, { sender: "ou_trusted" }, { sender: "ou_other", scope: "untrusted" },
      { chatType: "group" }, { messageType: "post" }, { text: "hello" },
      { original: "跟示例同事说：我的工资是10000", text: "我的工资是10000" },
      { original: "帮我给他发个问候", text: "hello" },
      { original: "跟示例同事、示例用户说：test", text: "test" },
      { recipient: "外部同事", original: "跟外部同事说：test", text: "test" },
      { recipient: "同名同事", original: "跟同名同事说：test", text: "test" },
      { callTurn: "different-turn" }, { status: "answered" }, { approver: "ou_new_owner" }
    ];
    let expectedCards = 0;
    for (const [i, entry] of cases.entries()) {
      const c = entry as { enabled?: boolean; sender?: string; scope?: string; chatType?: string; messageType?: string; text?: string; original?: string; recipient?: string; callTurn?: string; status?: string; approver?: string };
      runtime.store.setSetting("ownerMessageFastPathEnabled", String(c.enabled ?? true));
      if (c.approver) {
        runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE codex_status='running'").run();
        assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { approverId: c.approver } })).statusCode, 200);
      }
      const turn = `turn-boundary-${i}`;
      const inbound = (await runtime.app.inject({ method: "POST", url: "/v1/messages", payload: {
        event_id: `evt-boundary-${i}`, chat_id: "oc_owner", chat_type: c.chatType ?? "p2p", sender_id: c.sender ?? "ou_owner",
        sender_type: "user", message_type: c.messageType ?? "text", content: c.original ?? "跟示例同事说：你好"
      } })).json() as { id: number };
      runtime.store.db.prepare("UPDATE lark_messages SET codex_status=?,codex_turn_id=? WHERE id=?").run(c.status ?? "running", turn, inbound.id);
      const result = await runtime.app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: "/v1/internal/capabilities/lark.message.send/execute", payload: {
        input: { recipient: c.recipient ?? "示例同事", text: c.text ?? "你好" },
        context: { larkMessageId: inbound.id, chatId: "oc_owner", trustScope: c.scope ?? "trusted", turnId: c.callTurn ?? turn }
      } });
      assert.notEqual(result.statusCode, 200, JSON.stringify(c));
      if (!c.callTurn && c.status !== "answered") expectedCards++;
      assert.equal(cards, expectedCards, JSON.stringify(c));
      assert.equal(sends, 0, JSON.stringify(c));
    }
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
