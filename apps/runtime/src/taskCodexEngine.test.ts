import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import { WebSocketServer, type WebSocket } from "ws";
import { larkExecutionPolicy } from "../../../packages/conversation-runtime/src/executionEngines.js";
import { RetainedExecutionClient, type RetainedTurnSnapshot } from "../../../packages/conversation-runtime/src/retainedExecutionClient.js";
import { listenRetainedExecutionHost } from "../../../packages/conversation-runtime/src/retainedExecutionHost.js";
import { createTaskCodexEngine } from "./taskCodexEngine.js";

type Call = { id: number; method: string; params: Record<string, unknown> };

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const result = await read();
    if (result !== undefined) return result;
    assert(Date.now() < deadline, "fixture did not reach expected state");
    await delay(5);
  }
}

async function fixture(t: TestContext) {
  const root = mkdtempSync("/tmp/lark-task-codex-");
  const socketPath = path.join(root, "c.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const client = new CodexAppServerClient(() => root, { socketPath });
  const calls: Call[] = [];
  let peer: WebSocket;
  const send = (message: unknown) => peer.send(JSON.stringify(message));
  const reply = (call: Call, result: unknown) => send({ id: call.id, result });
  wss.on("connection", socket => {
    peer = socket;
    socket.on("message", data => {
      const call = JSON.parse(data.toString()) as Call;
      if (call.method === "initialize" || call.method === "thread/unsubscribe") reply(call, {});
      else if (call.method !== "initialized") calls.push(call);
    });
  });
  t.after(async () => {
    client.stop();
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([new Promise<void>(resolve => wss.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");

  return {
    root, calls, client, reply, notify: (method: string, params: unknown) => send({ method, params }),
    nth: (method: string, index = 0) => until(() => calls.filter(call => call.method === method)[index]),
    thread: (call: Call, id: string, overrides = {}) => reply(call, {
      thread: { id, status: { type: "idle" } }, sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", model: "fixture-model", ...overrides
    })
  };
}

test("retained host registers Codex and exposes only matching bounded turn text", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client, ["fixture-model"]);
  assert.deepEqual(engine.descriptor, { id: "codex", label: "Codex", models: ["fixture-model"] });
  const socketPath = path.join(f.root, "h.sock"), token = "isolated-fixture-token-for-retained-host";
  const host = await listenRetainedExecutionHost({ socketPath, token, workspace: f.root, engines: [engine] });
  try {
    const retained = new RetainedExecutionClient({ socketPath, token, engineIds: ["codex"] });
    const { generation } = await retained.call<{ generation: string }>({ method: "status" });
    const identity = { generation, id: "fixture-run" };
    const start = { method: "start", ...identity, engineId: "codex", text: "fixture input", model: "fixture-model", sessionId: null };
    await assert.rejects(retained.call({ ...start, trusted: false }), { status: 422 });
    assert.equal(f.client.status().running, false);
    assert.deepEqual(await retained.call({ ...start, trusted: true }), { started: true });
    const thread = await f.nth("thread/start");
    assert.deepEqual(thread.params, { cwd: f.root, model: "fixture-model", ephemeral: false, allowProviderModelFallback: false,
      approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" });
    f.thread(thread, "task-thread");
    const turn = await f.nth("turn/start");
    assert.deepEqual(turn.params, { threadId: "task-thread", cwd: f.root, model: "fixture-model", input: [{ type: "text", text: "fixture input" }],
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } });
    const ids = { threadId: "task-thread", turnId: "task-turn" };
    const prefix = "x".repeat(23_999);
    f.notify("turn/completed", { threadId: ids.threadId, turn: { id: "old", status: "failed" } });
    f.notify("item/agentMessage/delta", { ...ids, threadId: "other-thread", delta: "unrelated" });
    f.notify("item/agentMessage/delta", { ...ids, delta: prefix + "\u{1f4dd}" });
    f.notify("item/agentMessage/delta", { ...ids, delta: "past limit" });
    f.notify("item/completed", { ...ids, item: { type: "agentMessage", phase: "final_answer", text: prefix + "\u{1f4dd}" } });
    f.notify("item/completed", { ...ids, item: { type: "agentMessage", phase: "commentary", text: "not final" } });
    f.notify("turn/completed", { threadId: ids.threadId, turn: { id: ids.turnId, status: "completed" } });
    f.reply(turn, { turn: { id: ids.turnId, status: "inProgress" } });

    const snapshot = await until(async () => {
      const value = await retained.call<RetainedTurnSnapshot>({ method: "attach", ...identity, afterSequence: 0 });
      return value.status.state === "finished" || value.status.state === "failed" ? value : undefined;
    });
    assert.deepEqual(snapshot.status, { state: "finished", sessionId: "task-thread", result: { status: "completed", text: prefix } });
    assert.deepEqual(snapshot.events, [{ sequence: 1, event: { type: "text-delta", text: prefix } }]);
    assert.deepEqual(await retained.call({ method: "acknowledge", ...identity }), { acknowledged: true });
  } finally { await host.close(); }
});

test("Codex rejects unsupported scopes and resume drift before submitting input", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client);
  const options = { sessionId: "retained-thread", model: null, policy: larkExecutionPolicy(f.root, true), signal: new AbortController().signal };
  await assert.rejects(engine.open({ ...options, policy: larkExecutionPolicy(f.root, false) }), /cannot enforce/);
  await assert.rejects(engine.open({ ...options, mcpServers: [{ name: "fixture", command: "unused", args: [], env: [] }] }), /cannot enforce/);
  await assert.rejects(engine.open({ ...options, model: "unconfigured" }), /not configured/);
  assert.equal(f.client.status().running, false);

  const mismatched = engine.open(options);
  const resume = await f.nth("thread/resume");
  assert.equal(resume.params.threadId, options.sessionId);
  assert.equal(resume.params.excludeTurns, true);
  f.thread(resume, "wrong-thread");
  await assert.rejects(mismatched, /thread identity/);
  const downgraded = engine.open(options);
  f.thread(await f.nth("thread/resume", 1), options.sessionId, { sandbox: { type: "readOnly" } });
  await assert.rejects(downgraded, /did not confirm/);
  const active = engine.open(options);
  f.thread(await f.nth("thread/resume", 2), options.sessionId, { thread: { id: options.sessionId, status: { type: "active" } } });
  await assert.rejects(active, /not idle/);
  assert.equal(f.calls.some(call => call.method === "thread/start" || call.method === "turn/start"), false);
});

test("Codex guards input and only confirms native steer acknowledgements and terminal cancellation", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client);
  const controls = new AbortController();
  const opening = engine.open({ sessionId: "resumed-thread", model: null, policy: larkExecutionPolicy(f.root, true), signal: controls.signal });
  f.thread(await f.nth("thread/resume"), "resumed-thread");
  const session = await opening;
  try {
    for (const invalid of [" ", "x".repeat(24_001), "\uD800"]) {
      await assert.rejects(session.run(invalid, controls.signal), /Codex input/);
      await assert.rejects(session.steer!(invalid, controls.signal), /Codex input/);
    }
    assert.equal(await session.steer!("idle input", controls.signal), "idle");
    assert.equal(f.calls.length, 1);
    let ready!: () => void;
    const confirmed = new Promise<void>(resolve => { ready = resolve; });
    const running = session.run("initial input", controls.signal, ready);
    const start = await f.nth("turn/start");
    assert.equal(await session.steer!("early input", controls.signal), "idle");
    assert.equal(f.calls.length, 2);
    f.reply(start, { turn: { id: "current-turn", status: "inProgress" } });
    f.notify("item/agentMessage/delta", { threadId: "resumed-thread", turnId: "current-turn", delta: "working" });
    await confirmed;
    const rejected = session.steer!("uncertain input", controls.signal);
    const first = await f.nth("turn/steer");
    assert.equal(first.params.expectedTurnId, "current-turn");
    f.reply(first, { turnId: "different-turn" });
    await assert.rejects(rejected, /did not confirm steering/);
    const accepted = session.steer!("accepted input", controls.signal);
    const second = await f.nth("turn/steer", 1);
    assert.deepEqual(second.params, { threadId: "resumed-thread", expectedTurnId: "current-turn", input: [{ type: "text", text: "accepted input" }] });
    f.reply(second, { turnId: "current-turn" });
    assert.equal(await accepted, "injected");

    controls.abort();
    const interrupt = await f.nth("turn/interrupt");
    assert.deepEqual(interrupt.params, { threadId: "resumed-thread", turnId: "current-turn" });
    f.reply(interrupt, {});
    f.notify("turn/completed", { threadId: "resumed-thread", turn: { id: "current-turn", status: "interrupted" } });
    assert.deepEqual(await running, { status: "cancelled" });
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1);
  } finally { await session.close(); }
});
