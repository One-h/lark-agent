import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import { WebSocketServer, type WebSocket } from "ws";
import { larkExecutionPolicy, type ExecutionEngine } from "../../../packages/conversation-runtime/src/executionEngines.js";
import { RetainedExecutionClient, type RetainedTurnSnapshot } from "../../../packages/conversation-runtime/src/retainedExecutionClient.js";
import { listenRetainedExecutionHost } from "../../../packages/conversation-runtime/src/retainedExecutionHost.js";
import { retainedForegroundMcpContextToken } from "../../../packages/conversation-runtime/src/retainedForegroundMcp.js";
import { createTaskCodexEngine } from "./taskCodexEngine.js";

type Call = { id: number; method: string; params: Record<string, unknown> };
type Snapshot = RetainedTurnSnapshot & { nativeIdentity?: { sessionId: string; turnId: string | null } };
type HostStatus = { generation: string; workspace: string; engines: EngineCapability[]; taskWorkspaces: { cwd: string; engines: EngineCapability[] }[] };
type EngineCapability = { id: string; models: string[]; trusted: boolean; restricted: boolean; foregroundLarkTools?: boolean };

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
  const serverResponses: { id: number; error?: { code: number }; result?: unknown }[] = [];
  let peer: WebSocket;
  const send = (message: unknown) => peer.send(JSON.stringify(message));
  const reply = (call: Call, result: unknown) => send({ id: call.id, result });
  wss.on("connection", socket => {
    peer = socket;
    socket.on("message", data => {
      const call = JSON.parse(data.toString()) as Call;
      if (call.method === "initialize" || call.method === "thread/unsubscribe") reply(call, {});
      else if (!call.method) serverResponses.push(call);
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
    root, calls, client, reply, serverResponses, send, disconnect: () => peer.close(),
    notify: (method: string, params: unknown) => send({ method, params }),
    nth: (method: string, index = 0) => until(() => calls.filter(call => call.method === method)[index]),
    thread: (call: Call, id: string, overrides = {}) => reply(call, {
      thread: { id, cwd: call.params.cwd, status: { type: "idle" } }, cwd: call.params.cwd,
      sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", model: "fixture-model", ...overrides
    }),
    read: (call: Call, id: string, cwd = root, turns?: unknown[]) => reply(call, { thread: { id, cwd, status: { type: "idle" }, turns } })
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
    const { generation, workspace, engines, taskWorkspaces } = await retained.call<HostStatus>({ method: "status" });
    assert.equal(workspace, f.root);
    assert.deepEqual(engines, [{ id: "codex", models: ["fixture-model"], trusted: true, restricted: true }]);
    assert.deepEqual(taskWorkspaces, [{ cwd: f.root, engines }]);
    const identity = { generation, id: "fixture-run" };
    const start = { method: "start", ...identity, engineId: "codex", text: "fixture input", model: "fixture-model", sessionId: null };
    assert.equal(f.client.status().running, false);
    assert.deepEqual(await retained.call({ ...start, trusted: true }), { started: true });
    const thread = await f.nth("thread/start");
    assert.deepEqual(thread.params, { cwd: f.root, model: "fixture-model", ephemeral: false, allowProviderModelFallback: false,
      approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" });
    f.thread(thread, "task-thread");
    const turn = await f.nth("turn/start");
    const dispatchKey = `lark-task:${generation}/${identity.id}`;
    assert.deepEqual(turn.params, { threadId: "task-thread", cwd: f.root, model: "fixture-model", clientUserMessageId: dispatchKey,
      input: [{ type: "text", text: `[Lark task dispatch: ${dispatchKey}]\n\nfixture input` }],
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } });
    const replacement = new RetainedExecutionClient({ socketPath, token, engineIds: ["codex"] });
    const attach = () => replacement.call<Snapshot>({ method: "attach", ...identity, afterSequence: 0 });
    assert.deepEqual((await attach()).nativeIdentity, { sessionId: "task-thread", turnId: null });
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
      const value = await attach();
      return value.status.state === "finished" || value.status.state === "failed" ? value : undefined;
    });
    assert.deepEqual(snapshot.status, { state: "finished", sessionId: "task-thread", result: { status: "completed", text: prefix } });
    assert.deepEqual(snapshot.nativeIdentity, { sessionId: "task-thread", turnId: "task-turn" });
    assert.deepEqual(snapshot.events, [{ sequence: 1, event: { type: "text-delta", text: prefix } }]);
    assert.deepEqual(await retained.call({ method: "acknowledge", ...identity }), { acknowledged: true });
    assert.deepEqual((await attach()).nativeIdentity, snapshot.nativeIdentity);
  } finally { await host.close(); }
});

test("Codex rejects unsupported scopes and resume drift before submitting input", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client);
  const options = { sessionId: "retained-thread", model: null, policy: larkExecutionPolicy(f.root, true), signal: new AbortController().signal };
  await assert.rejects(engine.open({ ...options, policy: larkExecutionPolicy("relative-workspace", false) }), /cannot enforce/);
  await assert.rejects(engine.open({ ...options, mcpServers: [{ name: "fixture", command: "unused", args: [], env: [] }] }), /cannot enforce/);
  await assert.rejects(engine.open({ ...options, model: "unconfigured" }), /not configured/);
  assert.equal(f.client.status().running, false);

  const mismatched = engine.open(options);
  f.read(await f.nth("thread/read"), options.sessionId);
  const resume = await f.nth("thread/resume");
  assert.equal(resume.params.threadId, options.sessionId);
  assert.equal(resume.params.excludeTurns, true);
  f.thread(resume, "wrong-thread");
  await assert.rejects(mismatched, /thread identity/);
  const downgraded = engine.open(options);
  f.read(await f.nth("thread/read", 1), options.sessionId);
  f.thread(await f.nth("thread/resume", 1), options.sessionId, { sandbox: { type: "readOnly" } });
  await assert.rejects(downgraded, /did not confirm/);
  const active = engine.open(options);
  f.read(await f.nth("thread/read", 2), options.sessionId);
  f.thread(await f.nth("thread/resume", 2), options.sessionId, { thread: { id: options.sessionId, cwd: f.root, status: { type: "active" } } });
  await assert.rejects(active, /not idle/);
  assert.equal(f.calls.some(call => call.method === "thread/start" || call.method === "turn/start"), false);
});

test("Codex guards input and only confirms native steer acknowledgements and terminal cancellation", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client);
  const controls = new AbortController();
  const opening = engine.open({ sessionId: "resumed-thread", model: null, policy: larkExecutionPolicy(f.root, true), signal: controls.signal });
  f.read(await f.nth("thread/read"), "resumed-thread");
  f.thread(await f.nth("thread/resume"), "resumed-thread");
  const session = await opening;
  try {
    for (const invalid of [" ", "x".repeat(24_001), "\uD800"]) {
      await assert.rejects(session.run(invalid, controls.signal), /Codex input/);
      await assert.rejects(session.steer!(invalid, controls.signal), /Codex input/);
    }
    assert.equal(await session.steer!("idle input", controls.signal), "idle");
    assert.equal(f.calls.length, 2);
    let ready!: () => void;
    const confirmed = new Promise<void>(resolve => { ready = resolve; });
    const running = session.run("initial input", controls.signal, ready);
    const start = await f.nth("turn/start");
    assert.equal(await session.steer!("early input", controls.signal), "idle");
    assert.equal(f.calls.length, 3);
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

test("restricted Codex fails closed on missing or weaker native verification and refuses elevation", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const engine = createTaskCodexEngine(f.client);
  const signal = new AbortController().signal;
  const args = { sessionId: null, model: null, policy: larkExecutionPolicy(f.root, false), signal };
  const disabled = { config: { mcp_servers: {} } };
  const readOnly = { sandbox: { type: "readOnly", networkAccess: false } };

  const inheritedMcp = engine.open(args);
  f.reply(await f.nth("config/read"), { config: { mcp_servers: { "ambiguous.name": { enabled: true } } } });
  await assert.rejects(inheritedMcp, /cannot disable inherited MCP/);
  assert.equal(f.calls.some(call => call.method === "thread/start"), false);

  const unverified = [undefined, { type: "dangerFullAccess" }, { type: "readOnly" }, { type: "readOnly", networkAccess: true }];
  for (const [index, sandbox] of unverified.entries()) {
    const opening = engine.open(args);
    f.reply(await f.nth("config/read", index + 1), disabled);
    const start = await f.nth("thread/start", index);
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.approvalPolicy, "never");
    f.thread(start, `unverified-${index}`, { sandbox });
    await assert.rejects(opening, /did not confirm/);
  }

  const unsafeApproval = engine.open(args);
  f.reply(await f.nth("config/read", 5), disabled);
  f.thread(await f.nth("thread/start", 4), "wrong-approval", { ...readOnly, approvalPolicy: "on-request" });
  await assert.rejects(unsafeApproval, /did not confirm/);

  const ambiguousMcp = engine.open(args);
  f.reply(await f.nth("config/read", 6), disabled);
  f.thread(await f.nth("thread/start", 5), "mcp-thread", readOnly);
  f.reply(await f.nth("mcpServerStatus/list"), { data: [], nextCursor: "unknown-more" });
  await assert.rejects(ambiguousMcp, /no MCP servers/);
  assert.equal(f.calls.some(call => call.method === "turn/start"), false);

  const opening = engine.open(args);
  f.reply(await f.nth("config/read", 7), { config: { mcp_servers: { fixture: { enabled: true } } } });
  const restrictedStart = await f.nth("thread/start", 6);
  assert.equal((restrictedStart.params.config as Record<string, unknown>)["mcp_servers.fixture.enabled"], false);
  f.thread(restrictedStart, "restricted-thread", readOnly);
  const mcp = await f.nth("mcpServerStatus/list", 1);
  assert.equal(mcp.params.threadId, "restricted-thread");
  f.reply(mcp, { data: [], nextCursor: null });
  const session = await opening;
  try {
    const running = session.run("read-only input", signal);
    const turn = await f.nth("turn/start");
    assert.deepEqual(turn.params.sandboxPolicy, readOnly.sandbox);
    assert.equal(turn.params.approvalPolicy, "never");
    f.reply(turn, { turn: { id: "readonly-turn", status: "inProgress" } });
    f.send({ id: 9876, method: "item/commandExecution/requestApproval", params: { threadId: "restricted-thread", turnId: "readonly-turn" } });
    const denied = await until(() => f.serverResponses.find(result => result.id === 9876));
    assert.equal(denied.error?.code, -32601);
    assert.equal(denied.result, undefined);
    f.notify("turn/completed", { threadId: "restricted-thread", turn: { id: "readonly-turn", status: "completed" } });
    assert.deepEqual(await running, { status: "completed", text: "" });
  } finally { await session.close(); }
});

test("restricted pool accepts disabled inventory placeholders, not advertised tools", { timeout: 10_000 }, async t => {
  const base = await fixture(t), scoped = await fixture(t);
  const engine = createTaskCodexEngine(base.client, [], { get: (_cwd, disabled) => {
    assert.deepEqual(disabled, { "mcp_servers.fixture.enabled": false });
    return scoped.client;
  }, close() {} });
  const policy = larkExecutionPolicy(base.root, false);
  const open = async (index: number, tools: Record<string, unknown>) => {
    const opening = engine.open({ sessionId: null, model: null, policy, signal: new AbortController().signal });
    base.reply(await base.nth("config/read", index), { config: { mcp_servers: { fixture: { enabled: true } } } });
    scoped.reply(await scoped.nth("config/read", index), { config: { mcp_servers: { fixture: { enabled: false } } } });
    scoped.thread(await scoped.nth("thread/start", index), "isolated-" + index, { sandbox: { type: "readOnly", networkAccess: false } });
    scoped.reply(await scoped.nth("mcpServerStatus/list", index), { data: [
      { name: "fixture", tools, authStatus: "unsupported", resources: [], resourceTemplates: [] }
    ], nextCursor: null });
    return opening;
  };
  const accepted = await open(0, {});
  await accepted.close();
  await assert.rejects(open(1, { leaked: {} }), /no MCP servers/);
  assert.equal(scoped.calls.some(call => call.method === "turn/start"), false);
});

test("task workspace allowlist pins exact directories and cannot move an existing native session", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const workspace = path.join(f.root, "workspace"), other = path.join(f.root, "other"), alias = path.join(f.root, "allowed");
  const fixed = path.join(f.root, "fixed");
  mkdirSync(workspace);
  mkdirSync(other);
  symlinkSync(workspace, alias);
  symlinkSync(other, fixed);
  const socketPath = path.join(f.root, "h.sock"), token = "isolated-fixture-token-for-retained-host";
  const engine = createTaskCodexEngine(f.client);
  const otherEngine = { ...engine, descriptor: { id: "other", label: "Other", models: [] } };
  const host = await listenRetainedExecutionHost({ socketPath, token, workspace: fixed, engines: [engine, otherEngine],
    taskWorkspaces: [alias], taskWorkspaceEngineIds: ["codex"] });
  try {
    const retained = new RetainedExecutionClient({ socketPath, token, engineIds: ["codex", "other"] });
    const status = await retained.call<HostStatus>({ method: "status" });
    const unauthorized = new RetainedExecutionClient({ socketPath, token: `${token}-wrong`, engineIds: ["codex"] });
    await assert.rejects(unauthorized.call({ method: "status" }), { status: 401 });
    assert.deepEqual(status.taskWorkspaces.map(entry => [entry.cwd, entry.engines.map(entry => entry.id)]),
      [[fixed, ["codex", "other"]], [alias, ["codex"]]]);
    const start = { method: "start", generation: status.generation, id: "workspace-run", engineId: "codex", text: "fixture input",
      lane: "task", taskId: "10000000-0000-4000-8000-000000000001",
      model: null, sessionId: null, trusted: true };
    for (const cwd of [workspace, other, "allowed", `${alias}/../allowed`]) {
      await assert.rejects(retained.call({ ...start, cwd }), { status: 422 });
    }
    await assert.rejects(retained.call({ ...start, cwd: alias, engineId: "other" }), { status: 422 });
    assert.equal(f.client.status().running, false);

    await retained.call({ ...start, cwd: alias });
    const thread = await f.nth("thread/start");
    assert.equal(thread.params.cwd, realpathSync(workspace));
    f.thread(thread, "workspace-thread");
    const turn = await f.nth("turn/start");
    assert.equal(turn.params.cwd, realpathSync(workspace));
    const attach = (id: string) => retained.call<Snapshot>({ method: "attach", generation: status.generation, id, afterSequence: 0 });
    const terminal = (id: string) => until(async () => {
      const snap = await attach(id);
      return ["finished", "failed"].includes(snap.status.state) ? snap : undefined;
    });
    const wrongWorkspace = { ...start, id: "other-run", sessionId: "workspace-thread" };
    await assert.rejects(retained.call(wrongWorkspace), { status: 422 });
    assert.equal(f.calls.filter(call => call.method === "thread/read").length, 0);

    // The start request reached Codex but no usable acknowledgement made it back.
    f.send({ id: turn.id, error: { code: -32000, message: "fixture lost acknowledgement" } });
    const read = await f.nth("thread/read");
    assert.deepEqual(read.params, { threadId: "workspace-thread", includeTurns: true });
    f.read(read, "workspace-thread", workspace, [
      { id: "other-native-turn", status: "completed", items: [{ type: "agentMessage", text: "unrelated" }] },
      { id: "original-native-turn", status: "completed", items: [
        { type: "userMessage", content: turn.params.input }, { type: "agentMessage", phase: "final_answer", text: "recovered" }
      ] }
    ]);
    const recovered = await terminal(start.id);
    assert.deepEqual(recovered.status, { state: "finished", sessionId: "workspace-thread", result: { status: "completed", text: "recovered" } });
    assert.deepEqual(recovered.nativeIdentity, { sessionId: "workspace-thread", turnId: "original-native-turn" });
    const proof = (recovered as Snapshot & { sessionProof?: string }).sessionProof;
    assert.match(proof ?? "", /^[a-f0-9]{64}$/);
    await retained.call({ method: "acknowledge", generation: status.generation, id: start.id });
    await assert.rejects(retained.call({ ...wrongWorkspace, id: "move-after-completion", resumeProof: proof }), { status: 422 });
    await assert.rejects(retained.call({ ...wrongWorkspace, id: "foreign-task", cwd: alias, resumeProof: proof,
      taskId: "10000000-0000-4000-8000-000000000002" }), { status: 422 });
    assert.equal(f.calls.filter(call => call.method === "thread/resume").length, 0);
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1);

    await retained.call({ ...wrongWorkspace, id: "same-workspace-followup", cwd: alias, resumeProof: proof });
    f.read(await f.nth("thread/read", 1), "workspace-thread", workspace);
    const resume = await f.nth("thread/resume");
    assert.equal(resume.params.cwd, realpathSync(workspace));
    f.thread(resume, "workspace-thread");
    const followUp = await f.nth("turn/start", 1);
    assert.equal(followUp.params.threadId, "workspace-thread");
    f.reply(followUp, { turn: { id: "follow-up-turn", status: "completed" } });
    assert.equal((await terminal("same-workspace-followup")).status.state, "finished");

    unlinkSync(alias);
    symlinkSync(other, alias);
    assert.deepEqual((await retained.call<HostStatus>({ method: "status" })).taskWorkspaces.map(entry => entry.cwd), [fixed]);
    await assert.rejects(retained.call({ ...start, id: "replaced-workspace", cwd: alias }), { status: 422 });
    unlinkSync(fixed);
    symlinkSync(workspace, fixed);
    assert((await retained.call<HostStatus>({ method: "status" })).engines.every(engine => !engine.trusted && !engine.restricted));
    await assert.rejects(retained.call({ ...start, id: "replaced-fixed-workspace" }), { status: 422 });
  } finally { await host.close(); }
});

test("lost Codex socket preserves only a terminal result proven by unique native input", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const token = "isolated-fixture-token-for-retained-host", socketPath = path.join(f.root, "h.sock");
  const host = await listenRetainedExecutionHost({ socketPath, token, workspace: f.root, engines: [createTaskCodexEngine(f.client)] });
  try {
    const retained = new RetainedExecutionClient({ socketPath, token, engineIds: ["codex"] });
    const { generation } = await retained.call<HostStatus>({ method: "status" });
    for (const ambiguous of [true, false]) {
      const identity = { generation, id: ambiguous ? "ambiguous-evidence" : "unique-evidence" };
      await retained.call({ method: "start", ...identity, engineId: "codex", text: "fixture input", model: null, sessionId: null, trusted: true });
      const index = ambiguous ? 0 : 1;
      const threadId = `native-thread-${index}`;
      f.thread(await f.nth("thread/start", index), threadId);
      const call = await f.nth("turn/start", index);
      f.notify("item/started", { threadId, turnId: "true-turn", item: { type: "userMessage", content: call.params.input } });
      f.notify("turn/completed", { threadId, turn: { id: "true-turn", status: "completed", items: [{ type: "agentMessage", text: "recovered" }] } });
      if (ambiguous) f.notify("item/started", { threadId, turnId: "duplicate-turn", item: { type: "userMessage", content: call.params.input } });
      f.disconnect();
      const snapshot = await until(async () => {
        const value = await retained.call<Snapshot>({ method: "attach", ...identity, afterSequence: 0 });
        return ["finished", "failed"].includes(value.status.state) ? value : undefined;
      });
      assert.deepEqual(snapshot.nativeIdentity, { sessionId: threadId, turnId: ambiguous ? null : "true-turn" });
      assert.deepEqual(snapshot.status, ambiguous ? { state: "failed", sessionId: threadId }
        : { state: "finished", sessionId: threadId, result: { status: "completed", text: "recovered" } });
    }
    assert.deepEqual(f.calls.map(call => call.method), ["thread/start", "turn/start", "thread/start", "turn/start"]);
  } finally { await host.close(); }
});

test("retained host scopes the operator gateway to an active foreground invocation", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const token = "isolated-fixture-token-for-retained-host", socketPath = path.join(f.root, "h.sock");
  const foregroundMcpServer = { name: "lark_tools", command: "unused", args: [], env: [] };
  const calls: { text: string; mcpServers: unknown }[] = [];
  const engine: ExecutionEngine = {
    descriptor: { id: "fixture", label: "Fixture", models: [] }, supportsLarkMcp: true, supportsPolicy: () => true,
    async open({ mcpServers }) {
      return { id: `thread-${calls.length}`, close() {}, async run(text, signal) {
        calls.push({ text, mcpServers });
        if (!signal.aborted) await once(signal, "abort");
        return { status: "cancelled" };
      } };
    }
  };
  const host = await listenRetainedExecutionHost({ socketPath, token, workspace: f.root, engines: [engine], foregroundMcpServer });
  try {
    const client = new RetainedExecutionClient({ socketPath, token, engineIds: ["fixture"] });
    const status = await client.call<HostStatus>({ method: "status" });
    assert.equal(status.engines[0].foregroundLarkTools, true);
    assert.equal("foregroundLarkTools" in status.taskWorkspaces[0].engines[0], false);
    const start = { method: "start", generation: status.generation, engineId: "fixture", model: null, sessionId: null, text: "fixture", trusted: true };
    const call = (method: string, id: string) => client.call<Snapshot & { foregroundLarkToolsActive?: boolean }>({
      method, generation: status.generation, id, ...(method === "attach" ? { afterSequence: 0 } : {})
    });
    await assert.rejects(client.call({ ...start, id: "invalid", lane: "foreground", cwd: f.root }), { status: 422 });
    await client.call({ ...start, id: "backend" });
    await until(() => calls[0]);
    assert.deepEqual(calls[0], { text: "fixture", mcpServers: undefined });
    assert.equal((await call("attach", "backend")).foregroundLarkToolsActive, undefined);

    await client.call({ ...start, id: "foreground", lane: "foreground" });
    await until(() => calls[1]);
    assert.deepEqual(calls[1].mcpServers, [foregroundMcpServer]);
    assert(calls[1].text.includes(`context_token=${retainedForegroundMcpContextToken(token, status.generation, "foreground")}`));
    assert(!calls[1].text.includes(token));
    assert.equal((await call("attach", "foreground")).foregroundLarkToolsActive, true);
    await call("cancel", "foreground");
    assert.equal((await call("attach", "foreground")).foregroundLarkToolsActive, undefined);
  } finally { await host.close(); }
});
