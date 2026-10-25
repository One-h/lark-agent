import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createRuntime } from "../apps/runtime/src/index.js";
import { enqueueLarkCodexReply } from "@lark-agent/conversation-runtime";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-app-server-"));
const host = Fastify({ logger: false });
let hostCalls = 0;
host.post("/api/lark-agent/capabilities/host.demo", async (request) => ({ ok: true, call: ++hostCalls, input: (request.body as { input?: unknown }).input, _receipt: { status: "verified", summary: "Host demo completed and verified.", evidence: ["call: 1"] } }));
await host.listen({ host: "127.0.0.1", port: 0 });
const hostAddress = host.server.address();
assert.ok(hostAddress && typeof hostAddress !== "string");
const runtime = createRuntime({
  databasePath: path.join(temporaryRoot, "agent.sqlite"),
  mode: "active",
  runtimeToken: "verification-runtime-token",
  trustedSenderIds: ["ou_e2e"],
  hostBaseUrl: `http://127.0.0.1:${hostAddress.port}`,
  workspaceRoot: temporaryRoot,
  port: 4782,
  approvalCardSender: () => ({ ok: true, messageId: null })
});

try {
  await runtime.app.listen({ host: "127.0.0.1", port: 4782 });
  const registered = await runtime.app.inject({ method: "POST", url: "/v1/capabilities/register", headers: { authorization: "Bearer verification-runtime-token" }, payload: { capabilities: [{ id: "host.demo", title: "演示能力", description: "返回传入参数，用于验证 Lark Agent 到本地宿主的能力调用。", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, risk: "local-write" }] } });
  assert.equal(registered.statusCode, 200, registered.body);
  const now = new Date().toISOString();
  const saved = runtime.store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("evt-e2e-app-server", "om_e2e_app_server", "oc_e2e", "p2p", "ou_e2e", "text", "请直接调用已注册的 host.demo 能力，参数 value 必须为 e2e。拿到工具结果后只回复工具返回的 call 数字。", 1, "p2p", "sent", "failed", "{}", now, now);
  const messageId = Number(saved.lastInsertRowid);
  assert.equal(enqueueLarkCodexReply(messageId), true);
  let row: { codex_status?: string; codex_reply?: string | null; codex_error?: string | null } | undefined;
  for (let index = 0; index < 90; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    row = runtime.store.db.prepare("SELECT codex_status, codex_reply, codex_error FROM lark_messages WHERE id=?").get(messageId) as typeof row;
    if (row?.codex_status === "answered" || row?.codex_status === "failed") break;
  }
  assert.equal(row?.codex_status, "answered", row?.codex_error ?? "App Server did not finish within 90 seconds");
  assert.equal(hostCalls, 1, `expected exactly one host capability call, got ${hostCalls}`);
  assert.match(row?.codex_reply ?? "", /1/);
  const receipt = runtime.store.db.prepare("SELECT status, entries_json FROM lark_execution_receipts WHERE lark_message_id=?").get(messageId) as { status?: string; entries_json?: string } | undefined;
  assert.equal(receipt?.status, "verified");
  assert.match(receipt?.entries_json ?? "", /Host demo completed and verified/);
  console.log("App Server Dynamic Tools end-to-end verification passed.");
} finally {
  await runtime.app.close();
  runtime.stop();
  await host.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
