import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CodexAppServerClient } from "./client.js";

test("Codex socket transport can replace a client without terminating the owner", { timeout: 10_000 }, async () => {
  // Unix-domain socket paths have a small kernel limit.
  const root = mkdtempSync("/tmp/lark-codex-test-");
  const aliasRoot = mkdtempSync("/tmp/lark-codex-test-");
  const socketPath = path.join(root, "c.sock");
  const aliasPath = path.join(aliasRoot, "c.sock");
  const server = http.createServer();
  const websocket = new WebSocketServer({ server });
  const responses: unknown[] = [];
  const clients = [socketPath, aliasPath].map(socketPath => new CodexAppServerClient(() => root, { socketPath }));
  try {
    server.listen(socketPath);
    await once(server, "listening");
    symlinkSync(socketPath, aliasPath);
    websocket.on("connection", peer => {
      peer.on("message", data => {
        const request = JSON.parse(data.toString());
        if (request.method === "initialize") peer.send(JSON.stringify({ id: request.id, result: {} }));
        if (request.method === "thread/resume") {
          peer.send(JSON.stringify({ id: request.id, result: { thread: { id: "original" } } }));
          peer.send(JSON.stringify({ id: "native-approval", method: "item/commandExecution/requestApproval", params: { turnId: "original-turn" } }));
        }
        if (request.id === "native-approval") {
          responses.push(request.result);
          peer.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: "original-turn" } } }));
        }
      });
    });
    const [old, replacement] = clients as [CodexAppServerClient, CodexAppServerClient];
    await old.start();
    assert.equal(old.status().pid, null);
    old.stop();
    assert.equal(old.status().running, false);
    assert.equal(server.listening, true);
    const completed = new Promise<unknown>(resolve => replacement.onNotification(result => resolve(result)));
    replacement.onRequest(request => {
      assert.equal(request.id, "native-approval");
      assert.equal(request.method, "item/commandExecution/requestApproval");
      assert.deepEqual(request.params, { turnId: "original-turn" });
      replacement.respondToRequest(request.id, { decision: "accept" });
      return true;
    });
    assert.deepEqual(await replacement.request("thread/resume", { threadId: "original" }), { thread: { id: "original" } });
    assert.deepEqual(await completed, { method: "turn/completed", params: { turn: { id: "original-turn" } } });
    assert.deepEqual(responses, [{ decision: "accept" }]);
    replacement.stop();
    chmodSync(root, 0o755);
    await assert.rejects(replacement.start(), /private user-owned directory/);
    assert.equal(replacement.status().running, false);
  } finally {
    clients.forEach(client => client.stop());
    for (const peer of websocket.clients) peer.terminate();
    await Promise.all([new Promise<void>(resolve => websocket.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))]);
    rmSync(root, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});
