import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { buildLarkExecutionReceiptCard } from "@lark-agent/adapter-lark-cli";
import { reconcileLarkCrash } from "../../../packages/conversation-runtime/src/crashRecovery.js";
import { ForgeHostReceipts } from "./forgeHostReceipts.js";

async function localServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("an admitted Forge request is read after Lark restart, never submitted again", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-host-receipt-"));
  const databasePath = path.join(dir, "test.sqlite");
  let store = new SqliteAgentStore(databasePath);
  const old = new AbortController();
  const fresh = new AbortController();
  let posts = 0, requestId = "", finished = false, uncertain = false;
  let admitted!: () => void;
  const admittedAtHost = new Promise<void>(resolve => { admitted = resolve; });
  const forge = await localServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-host-token");
    if (req.url === "/api/lark-agent/requests/protocol") { res.end('{"version":1}'); return; }
    if (req.method === "POST") {
      posts++;
      requestId = String(req.headers["x-lark-request-id"]);
      req.resume();
      req.on("end", () => { req.socket.destroy(); admitted(); });
      return;
    }
    assert.equal(req.url, "/api/lark-agent/requests/" + requestId);
    res.end(JSON.stringify(finished ? { state: "finished", httpStatus: 200, body: { result: "fixture revision" } } : { state: uncertain ? "unknown" : "running" }));
  });
  try {
    const first = new ForgeHostReceipts(store.db, forge.url, "fixture-host-token", old.signal);
    assert.equal(await first.supported(), true);
    store.db.prepare(`INSERT INTO lark_capability_invocations
      (lark_message_id,turn_id,capability_id,input_hash,status,created_at) VALUES (1,'turn','forge.deploy.production','input','running',?)`).run(new Date().toISOString());
    const call = first.execute("forge.deploy.production", "turn", "input", "exact-context", { input: {} }, old.signal);
    const interrupted = assert.rejects(call, { name: "AbortError" });
    await admittedAtHost;
    old.abort();
    await interrupted;
    store.close();
    store = new SqliteAgentStore(databasePath);
    reconcileLarkCrash(store.db, new Date().toISOString());
    const second = new ForgeHostReceipts(store.db, forge.url, "fixture-host-token", fresh.signal);
    assert.equal(await second.read("different-context"), undefined);
    store.db.prepare("UPDATE lark_capability_invocations SET host_started_at=?").run(new Date(Date.now() - 25 * 60_000).toISOString());
    assert.equal((await second.read("exact-context"))?.status, "running");
    uncertain = true;
    const unresolved = await second.read("exact-context");
    assert.equal(unresolved?.status, "unknown");
    const card = JSON.stringify(buildLarkExecutionReceiptCard({ status: "unknown", entries: [{ capability: "forge.deploy.production",
      title: "Fixture operation", status: "unknown", summary: unresolved.error!, evidence: [] }] }));
    assert.match(card, /结果未确认/);
    assert.doesNotMatch(card, /执行失败/);
    finished = true;
    const receipt = await second.read("exact-context");
    assert.equal(receipt?.host_request_id, requestId);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(JSON.parse(receipt.result_json!), { result: "fixture revision" });
    assert.equal(posts, 1);
  } finally {
    old.abort(); fresh.abort();
    if (store.db.open) store.close();
    await forge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the original MCP call recovers its result through readback after connection loss", { timeout: 15_000 }, async () => {
  let executions = 0, reads = 0;
  const lark = await localServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/internal/mcp/tools/call") { executions++; req.socket.destroy(); return; }
      assert.equal(req.url, "/v1/internal/mcp/tools/receipt");
      res.end(JSON.stringify(++reads === 1 ? { status: "running" } : { status: "completed", text: "original result" }));
    });
  });
  const client = new Client({ name: "forge-receipt-fixture", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../../../packages/mcp-stickers/src/agentTools.ts", import.meta.url))],
      env: { ...process.env as Record<string, string>, LARK_AGENT_RUNTIME_URL: lark.url, LARK_AGENT_MCP_TOKEN: "fixture-mcp-token" } }));
    const reply = await client.callTool({ name: "forge__deploy__production", arguments: { context_token: "a".repeat(32), input: {} } });
    assert.notEqual(reply.isError, true);
    assert.deepEqual(reply.content, [{ type: "text", text: "original result" }]);
    assert.equal(executions, 1);
    assert.equal(reads, 2);
  } finally { await client.close(); await lark.close(); }
});
