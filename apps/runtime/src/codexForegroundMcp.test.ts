import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { codexForegroundMcpBearer, enqueueLarkCodexReply } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until<T>(check: () => T | undefined | false): Promise<T> {
  const end = Date.now() + 8_000;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    assert(Date.now() < end, "fixture did not reach expected native state");
    await delay(20);
  }
}

test("the original Codex MCP client discovers the new catalog after a Lark restart and requires a live socket turn", { timeout: 25_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lark-codex-mcp-"));
  const socketRoot = mkdtempSync("/tmp/lark-codex-mcp-");
  const codexSocket = path.join(socketRoot, "codex.sock");
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  const threadId = "fixture-thread";
  const item = { id: "fixture-answer", type: "agentMessage", phase: "final_answer", text: "Fixture finished." };
  let turn = "", nativeActive = false;
  const sentTexts: string[] = [];
  const progressEntries: string[][] = [];
  let workerStarts = 0;
  const tokens: string[] = [];
  ws.on("connection", peer => peer.on("message", data => {
    const rpc = JSON.parse(data.toString());
    const send = (result: unknown) => peer.send(JSON.stringify({ id: rpc.id, result }));
    if (rpc.method === "thread/start" || rpc.method === "thread/resume") return send({ thread: { id: threadId } });
    if (rpc.method === "thread/read") return send({ thread: { id: threadId, status: { type: nativeActive ? "active" : "idle" } } });
    if (rpc.method === "thread/turns/list") return send({ data: [{ id: turn, status: nativeActive ? "inProgress" : "completed" }] });
    if (rpc.method === "thread/items/list") return send({ data: nativeActive ? [] : [{ turnId: turn, item }], nextCursor: null });
    if (rpc.method === "turn/start") {
      const token = JSON.stringify(rpc.params.input).match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
      assert(token);
      tokens.push(token);
      turn = "fixture-turn-" + tokens.length;
      nativeActive = true;
      return send({ turn: { id: turn } });
    }
    if (rpc.id !== undefined) send({ data: [], nextCursor: null });
  }));
  server.listen(codexSocket);
  await once(server, "listening");
  const runtimeToken = randomBytes(32).toString("base64url");
  const bearer = codexForegroundMcpBearer(runtimeToken);
  assert(bearer && bearer !== runtimeToken && bearer === codexForegroundMcpBearer(runtimeToken));
  assert.equal(codexForegroundMcpBearer("short"), undefined);
  const setup = (enabled: boolean, port?: number) => createRuntime({
    databasePath: path.join(root, "test.sqlite"), workspaceRoot: root, mode: "active", codexSocket, port,
    trustedSenderIds: ["ou_fixture"], runtimeToken, taskOrchestrationEnabled: enabled,
    taskOrchestrationChatIds: ["oc_fixture"],
    taskEngineHost: { supports: engine => engine === "dsh", async call<T>(request: Record<string, unknown>) {
      switch (request.method) {
        case "status": return { generation: "fixture", workspace: root, engines: [{ id: "dsh", models: [], trusted: true, restricted: false }] } as T;
        case "start": workerStarts++; return {} as T;
        case "attach": return { engineId: "dsh", approvals: [], status: { state: "finished", sessionId: "worker-fixture",
          result: { status: "completed", text: "Result: deliver\nOnly the Worker result." } } } as T;
        case "acknowledge": return { acknowledged: true } as T;
        default: throw new Error("Unexpected task host request");
      }
    } },
    reactionSender: () => ({ ok: true }),
    progressSender: async (_id, progress) => {
      progressEntries.push(progress.entries.map(entry => entry.text));
      return { ok: true, messageId: "om_fixture_progress", chatId: "oc_fixture", messageAt: null, messageType: "interactive" };
    },
    progressUpdater: async (_id, progress) => { progressEntries.push(progress.entries.map(entry => entry.text)); return { ok: true }; },
    textReplySender: (_id, text) => {
      sentTexts.push(text);
      return { ok: true, messageId: `om_fixture_reply_${sentTexts.length}`, chatId: "oc_fixture", messageAt: null, messageType: "text" };
    }
  });
  let runtime = setup(false);
  const mcp = new Client({ name: "foreground-codex-fixture", version: "1" });
  const closeRuntime = async () => { await runtime.app.close(); if (runtime.store.db.open) runtime.stop(); };
  const call = (tool: string, context_token: string, input: object) => mcp.callTool({ name: tool, arguments: { context_token, input } });
  try {
    const url = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(url).port);
    await mcp.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../../../packages/mcp-stickers/src/agentTools.ts", import.meta.url))],
      env: { ...process.env as Record<string, string>, LARK_AGENT_RUNTIME_URL: url, LARK_AGENT_MCP_TOKEN: bearer } }));
    assert(!(await mcp.listTools()).tools.some(t => t.name === "lark_task_orchestration"));
    const request = async (id: number, chatId = "oc_fixture") => {
      const turnIndex = tokens.length;
      const now = new Date().toISOString();
      runtime.store.db.prepare(`INSERT INTO lark_messages
        (id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,mentioned,reply_trigger,reply_status,codex_status,content,raw_json,received_at,created_at)
        VALUES(?,?,?,'p2p','ou_fixture','user','text',1,'p2p','pending','skipped','fixture question','{}',?,?)`)
        .run(id, "om_fixture_" + id, chatId, now, now);
      assert(enqueueLarkCodexReply(id));
      const token = await until(() => tokens[turnIndex]);
      await until(() => runtime.store.db.prepare("SELECT 1 FROM lark_native_socket_turns WHERE message_id=?").get(id));
      return token;
    };
    const oldToken = await request(1);
    assert.notEqual((await call("lark_approval_status", oldToken, {})).isError, true);
    nativeActive = false;
    for (const peer of ws.clients) {
      peer.send(JSON.stringify({ method: "item/completed", params: { threadId, turnId: turn, item } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turn, status: "completed", items: [item] } } }));
    }
    await until(() => runtime.store.db.prepare("SELECT codex_status FROM lark_messages WHERE id=1").pluck().get() === "answered");
    await closeRuntime();

    runtime = setup(true, port);
    await runtime.app.listen({ host: "127.0.0.1", port });
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings",
      headers: { authorization: "Bearer " + runtimeToken }, payload: { trustedExecutionEnabled: true } })).statusCode, 200);
    assert((await mcp.listTools()).tools.some(t => t.name === "lark_task_orchestration"));
    const newToken = await request(101, "oc_unlisted");
    assert.notEqual(newToken, oldToken);
    const switchGlobal = async (enabled: boolean) => {
      const response = await runtime.app.inject({ method: "PATCH", url: "/v1/settings",
        headers: { authorization: "Bearer " + runtimeToken }, payload: { taskOrchestrationGlobalEnabled: enabled } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().taskOrchestrationGlobalEnabled, enabled);
    };
    assert.equal((await call("lark_task_orchestration", newToken, { action: "list" })).isError, true);
    await switchGlobal(true);
    assert.equal((await call("lark_task_orchestration", oldToken, { action: "list" })).isError, true);
    assert.notEqual((await call("lark_task_orchestration", newToken, { action: "list" })).isError, true);
    await switchGlobal(false);
    assert.equal((await call("lark_task_orchestration", newToken, { action: "list" })).isError, true);
    assert.equal((await runtime.app.inject({ url: "/v1/internal/mcp/tools", headers: { authorization: "Bearer " + runtimeToken } })).statusCode, 403);
    assert.equal((await runtime.app.inject({ url: "/v1/plugins", headers: { authorization: "Bearer " + bearer } })).statusCode, 401);
    assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/internal/mcp/tools/approve",
      headers: { authorization: "Bearer " + bearer }, payload: { tool: "lark_task_orchestration", contextToken: newToken,
        threadId, turnId: turn, input: { action: "list" } } })).statusCode, 403);
    assert.equal(runtime.store.db.prepare("SELECT count(*) FROM lark_orchestration_tasks").pluck().get(), 0);

    await switchGlobal(true);
    sentTexts.length = 0;
    const handedOff = await call("lark_task_orchestration", newToken, { action: "dispatch", goal: "Answer the full request",
      worker: { engine: "dsh" }, delivery: "worker_only" });
    assert.notEqual(handedOff.isError, true, JSON.stringify(handedOff.content));
    assert.match(JSON.stringify(handedOff.content), /approved/);
    assert.equal(runtime.store.db.prepare("SELECT count(*) FROM lark_orchestration_outbox").pluck().get(), 0);
    nativeActive = false;
    for (const peer of ws.clients) {
      peer.send(JSON.stringify({ method: "item/completed", params: { threadId, turnId: turn, item } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turn, status: "completed", items: [item] } } }));
    }
    await until(() => runtime.store.db.prepare("SELECT codex_dispatch_phase FROM lark_messages WHERE id=101").pluck().get() === "finalized");
    await until(() => { runtime.tickPlugins(); return sentTexts.length > 0; });
    assert.equal(workerStarts, 1);
    assert.deepEqual(sentTexts, ["Only the Worker result."]);
    assert.ok(progressEntries.some(entries => entries.includes("已派给 DSH")));
    assert.equal(runtime.store.db.prepare("SELECT count(*) FROM lark_orchestration_outbox WHERE state='sent' AND receipt IS NOT NULL").pluck().get(), 1);
  } finally {
    await mcp.close();
    await closeRuntime();
    for (const peer of ws.clients) peer.terminate();
    await Promise.all([new Promise<void>(resolve => ws.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
    rmSync(root, { recursive: true, force: true });
    rmSync(socketRoot, { recursive: true, force: true });
  }
});
