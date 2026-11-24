import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as conversationConfig, createNativeAcpExecutionEngine, enqueueLarkCodexReply, getLarkMcpToolContext, retainedForegroundMcpBearer,
  RetainedExecutionClient, RetainedHostError, updateConversationExecutionSettings } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until<T>(get: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    assert(Date.now() < deadline, `Foreground fixture did not reach ${label}`);
    await delay(25);
  }
}

test("the original retained ACP prompt calls authenticated lark_tools after runtime restart", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-foreground-"));
  const socketRoot = fs.mkdtempSync("/tmp/lark-fg-");
  const socketPath = path.join(socketRoot, "e.sock");
  const token = randomBytes(32).toString("base64url");
  const retainedEngineHost = { socketPath, token, engineIds: ["dsh"] };
  const client = new RetainedExecutionClient(retainedEngineHost);
  const launcher = path.join(root, "fixture.mjs");
  const marker = (name: string) => path.join(root, name);
  fs.writeFileSync(launcher, `#!${process.execPath}
import assert from "node:assert/strict";
import fs from "node:fs";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/stdio.js"))};
assert(!process.env.LARK_AGENT_ENGINE_HOST_TOKEN && !process.env.LARK_AGENT_RUNTIME_TOKEN && !process.env.LARK_AGENT_MCP_TOKEN);
const send = value => console.log(JSON.stringify({jsonrpc:"2.0", ...value}));
const respond = (id, result) => send({id, result});
let tools;
const wait = async name => { while (!fs.existsSync(name)) await delay(20); };
async function handle({id, method, params}) {
  if (method === "initialize") return respond(id, {protocolVersion:1});
  if (method === "session/new") {
    assert.deepEqual(params.mcpServers.map(server => server.name), ["lark_tools"]);
    const [server] = params.mcpServers;
    const env = Object.fromEntries(server.env.map(({name, value}) => [name, value]));
    assert.deepEqual(Object.keys(env).sort(), ["LARK_AGENT_MCP_TOKEN", "LARK_AGENT_RUNTIME_URL"]);
    tools = new Client({name:"retained-acp-fixture", version:"1"});
    await tools.connect(new StdioClientTransport({command:server.command, args:server.args, env}));
    return respond(id, {sessionId:"original-native-session"});
  }
  if (method === "session/prompt") {
    const context = params.prompt[0].text.match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
    assert(context);
    assert.match(params.prompt[0].text, /自行判断是否下派/);
    assert.doesNotMatch(params.prompt[0].text, /仅在明确委派/);
    assert.equal(params.sessionId, "original-native-session");
    fs.appendFileSync(${JSON.stringify(marker("prompts"))}, ${JSON.stringify("prompt\n")});
    assert((await tools.listTools()).tools.some(tool => tool.name === "lark_task_orchestration"));
    const call = (input, context_token = context) => tools.callTool({ name:"lark_task_orchestration", arguments:{context_token, input} });
    assert.equal((await call({action:"list"}, "X".repeat(32))).isError, true);
    assert.deepEqual(JSON.parse((await call({action:"list"})).content[0].text), []);
    fs.writeFileSync(${JSON.stringify(marker("ready"))}, "ready");
    await wait(${JSON.stringify(marker("continue"))});
    const result = await call({action:"dispatch", goal:"Research the isolated fixture", worker:{engine:"dsh"}});
    fs.writeFileSync(${JSON.stringify(marker("result.tmp"))}, JSON.stringify(result));
    fs.renameSync(${JSON.stringify(marker("result.tmp"))}, ${JSON.stringify(marker("result"))});
    await wait(${JSON.stringify(marker("finish"))});
    await tools.close();
    return respond(id, {stopReason:"cancelled"});
  }
  if (method !== "session/cancel") throw new Error("Unexpected fixture request " + method);
}
readline.createInterface({input:process.stdin}).on("line", line => {
  void handle(JSON.parse(line)).catch(error => {
    fs.writeFileSync(${JSON.stringify(marker("fixture-error"))}, error.message);
    process.exitCode = 1;
    void tools?.close().finally(() => process.exit(1));
    if (!tools) process.exit(1);
  });
});
`, { mode: 0o700 });

  const engine = createNativeAcpExecutionEngine("dsh", { launcher, models: [] });
  const setup = (port?: number) => createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "active", workspaceRoot: root,
    trustedSenderIds: ["ou_fixture"], runtimeToken: "fixture-runtime-token", executionEngines: [engine], retainedEngineHost, port,
    taskOrchestrationEnabled: true, taskEngineHost: { supports: id => id === "dsh", async call<T>(request: Record<string, unknown>) {
      if (request.method === "status") return { generation: "fixture-only", workspace: root,
        engines: [{ id: "dsh", models: [], trusted: true, restricted: false }] } as T;
      return null as T;
    } },
    textReplySender: () => ({ ok: true, messageId: "om_fixture_out", chatId: "oc_fixture", messageAt: null, messageType: "text" }),
    progressSender: async () => ({ ok: true, messageId: "om_fixture_progress", chatId: "oc_fixture", messageAt: null, messageType: "interactive" }),
    progressUpdater: async () => ({ ok: true }), reactionSender: () => ({ ok: true }) });
  let runtime = setup();
  let host: ChildProcess | undefined;
  const closeRuntime = async () => { await runtime.app.close(); if (runtime.store.db.open) runtime.stop(); };
  const checkFixture = () => assert.equal(fs.existsSync(marker("fixture-error")), false,
    fs.existsSync(marker("fixture-error")) ? fs.readFileSync(marker("fixture-error"), "utf8") : undefined);
  try {
    const runtimeUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(runtimeUrl).port);
    conversationConfig.larkAgentRuntimeUrl = runtimeUrl;
    host = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./engineHost.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PORT: String(port), LARK_AGENT_RUNTIME_URL: runtimeUrl,
        LARK_AGENT_ENGINE_HOST_SOCKET: socketPath, LARK_AGENT_ENGINE_HOST_TOKEN: token, LARK_AGENT_WORKSPACE_ROOT: root,
        LARK_AGENT_DSH_ACP_NATIVE_LAUNCHER: launcher, LARK_AGENT_TASK_ORCHESTRATION: "1" }, stdio: "ignore"
    });
    await until(() => { assert.equal(host?.exitCode, null); return fs.existsSync(socketPath); }, "host startup");
    const hostStatus = await client.call<{ generation: string }>({ method: "status" });
    const invalidStart = { method: "start", generation: hostStatus.generation, id: "invalid-fixture", engineId: "dsh",
      text: "fixture", sessionId: null, model: null, trusted: true, lane: "foreground" };
    await assert.rejects(client.call({ ...invalidStart, mcpServers: [] }), (error: unknown) => error instanceof RetainedHostError && error.status === 400);
    runtime.store.setSetting("trustedExecutionEnabled", "true");
    runtime.store.setSetting("executionReceiptsEnabled", "false");
    const insert = runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,thread_id,sender_id,sender_type,message_type,
      content,mentioned,reply_trigger,listener_verified,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(?,?,'oc_fixture','group','omt_fixture','ou_fixture','user','text','Explicitly delegate fixture research',1,'mention',1,'pending',?,'{}',?,?)`);
    const now = new Date().toISOString();
    insert.run(1, "om_seed", "answered", now, now);
    assert.equal(updateConversationExecutionSettings("oc_fixture", { engineId: "dsh", model: null }), "ok");
    insert.run(2, "om_foreground", "skipped", now, now);
    assert(enqueueLarkCodexReply(2));
    const source = () => runtime.store.db.prepare("SELECT codex_turn_id,codex_session_id,codex_status FROM lark_messages WHERE id=2").get() as
      { codex_turn_id: string; codex_session_id: string; codex_status: string };
    await until(() => {
      checkFixture();
      assert.notEqual(source().codex_status, "failed", "The foreground engine did not start");
      return fs.existsSync(marker("ready"));
    }, "the initial authenticated call");
    const original = source();
    assert.equal(original.codex_session_id, "original-native-session");
    assert.equal(original.codex_status, "running");
    const contextToken = client.foregroundMcpContextToken(hostStatus.generation, original.codex_turn_id);
    await closeRuntime();
    runtime = setup(port);
    await runtime.app.listen({ host: "127.0.0.1", port });
    fs.writeFileSync(marker("continue"), "continue");
    await until(() => { checkFixture(); return fs.existsSync(marker("result")); }, "the call after runtime restart");
    const result = JSON.parse(fs.readFileSync(marker("result"), "utf8"));
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).status, "approved");
    assert.deepEqual(runtime.store.db.prepare("SELECT message_id,sender_id,chat_id,trusted FROM lark_orchestration_tasks").all(),
      [{ message_id: 2, sender_id: "ou_fixture", chat_id: "oc_fixture", trusted: 1 }]);
    assert.deepEqual(source(), original);
    assert.equal(fs.readFileSync(marker("prompts"), "utf8"), "prompt\n");

    const invoke = (key: string, payload: Record<string, unknown> = {}) => runtime.app.inject({ method: "POST", url: "/v1/internal/mcp/tools/call",
      headers: { authorization: `Bearer ${key}` }, payload: { tool: "lark_task_orchestration", contextToken, input: { action: "list" }, ...payload } });
    const mcpBearer = retainedForegroundMcpBearer(token);
    assert.equal((await invoke(token)).statusCode, 403);
    assert.equal((await invoke(mcpBearer, { turnId: original.codex_turn_id, messageId: 2 })).statusCode, 400);
    assert.equal((await invoke(mcpBearer)).statusCode, 200);
    assert.equal(getLarkMcpToolContext(contextToken)?.turnId, original.codex_turn_id);
    conversationConfig.groupPrivacyEnforced = true;
    try { assert.equal(getLarkMcpToolContext(contextToken), undefined); }
    finally { conversationConfig.groupPrivacyEnforced = false; }
    assert.deepEqual(await client.call({ method: "cancel", generation: hostStatus.generation, id: original.codex_turn_id }), { cancelled: true });
    assert.equal(source().codex_status, "running");
    assert.equal((await invoke(mcpBearer)).statusCode, 409);
  } finally {
    fs.writeFileSync(marker("finish"), "finish");
    await closeRuntime();
    if (host && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.kill("SIGTERM");
      const kill = setTimeout(() => host?.kill("SIGKILL"), 7_000);
      try { await exited; } finally { clearTimeout(kill); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketRoot, { recursive: true, force: true });
  }
});
