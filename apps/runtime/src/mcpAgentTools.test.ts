import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config, enqueueLarkCodexReply, larkCodexSessionKeyForMessage, retryPendingLarkMediaReplies, retryPendingLarkTextReplies, saveConversationPersona, updateConversationExecutionSettings, uploadLarkStickers, type ExecutionEngine } from "@lark-agent/conversation-runtime";
import { codexAppServer, larkAgentToolsMcpServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { createRuntime } from "./index.js";
import { buildLarkExecutionApprovalCard } from "@lark-agent/adapter-lark-cli";

async function waitFor<T>(check: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    assert(Date.now() < deadline, "fixture did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const auth = { authorization: "Bearer fixture-host-token" };
const capableIds = ["forge.deploy.inspect", "forge.deploy.production", "forge.gitea.review-pr", "forge.gitea.triage-issue", "forge.todo.create"];
const catalog = capableIds.map((id, i) => ({ id, title: id, description: id,
  inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  risk: i === 0 ? "read" : i === 1 ? "external-write" : "local-write" }));

test("resumed Codex thread discovers host tools over real MCP stdio without dynamic tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-shared-tools-"));
  const executable = path.join(root, "codex.mjs"), rpc = path.join(root, "resume.json"), response = path.join(root, "confirmation.jsonl");
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline";import fs from "node:fs";
const send=x=>console.log(JSON.stringify(x));
const reply=(id,result)=>send({id,result});
const meta={threadId:"00000000-0000-4000-8000-000000000017",turnId:"fixture-turn"};
let turns=0,active=false;
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/resume"){
  if(m.params.threadId!==meta.threadId||"dynamicTools" in m.params)throw Error("resume must not depend on dynamic tools");
  fs.writeFileSync(${JSON.stringify(rpc)},JSON.stringify({resumed:true}));
  reply(m.id,{thread:{id:meta.threadId}});
 }else if(m.method==="thread/start")throw Error("a new thread would not test compatibility");
 else if(m.method==="thread/loaded/list"||m.method==="thread/list")reply(m.id,{data:[],nextCursor:null});
 else if(m.method==="thread/read")reply(m.id,{thread:{id:meta.threadId,status:{type:active?"active":"idle"}}});
 else if(m.method==="thread/turns/list")reply(m.id,{data:[{id:meta.turnId,status:active?"inProgress":"completed"}]});
 else if(m.method==="turn/start"){
  if(turns++)meta.turnId="fixture-owner-turn";
  active=true;
  reply(m.id,{turn:{id:meta.turnId,status:"inProgress"}});
 }
 else if(m.method==="fixture/confirm"){
  reply(m.id,{});
  send({id:m.params.id,method:"mcpServer/elicitation/request",params:m.params.params});
 }else if(m.method==="fixture/finish"){
  active=false;
  reply(m.id,{});
  const item={id:"answer",type:"agentMessage",phase:"final_answer",text:"Fixture complete"};
  send({method:"item/completed",params:{...meta,item}});
  send({method:"turn/completed",params:{...meta,turn:{id:meta.turnId,status:"completed",items:[item]}}});
 }else if(m.method)reply(m.id,{});
 else if(String(m.id).startsWith("confirm-")) fs.appendFileSync(${JSON.stringify(response)},JSON.stringify(m)+"\\n");
});`, { mode: 0o755 });
  const cli = path.join(root, "lark-cli");
  fs.writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' '{\"data\":{\"message_id\":\"om_fixture\"}}'\n", { mode: 0o755 });
  const oldExecutable = process.env.CODEX_EXECUTABLE, oldPath = process.env.PATH;
  const oldQuestionTarget = process.env.LARK_AGENT_GROUP_QUESTION_TARGET;
  process.env.LARK_AGENT_GROUP_QUESTION_TARGET = "oc_builders,ou_responder";
  process.env.CODEX_EXECUTABLE = executable; process.env.PATH = `${root}:${oldPath ?? ""}`;
  const host = Fastify();
  let writes = 0, sends = 0, groupCreates = 0, questionsSent = 0;
  host.post("/api/lark-agent/capabilities/forge.deploy.inspect", async () => ({ found: true, _receipt: { internal: "not forwarded" } }));
  host.post("/api/lark-agent/capabilities/forge.deploy.production", async () => ({ applied: ++writes }));
  const hostUrl = await host.listen({ host: "127.0.0.1", port: 0 });
  const cards: Array<{ approvalId: number; taskPlan?: string; operationPreview?: string }> = [];
  const app = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: ["ou_owner"],
    runtimeToken: "fixture-host-token", approverId: "ou_owner", hostBaseUrl: hostUrl,
    groupQuestionCli: async args => {
      if (args[1] === "chats") return { data: { chat_mode: "group" } };
      assert.equal(args[args.indexOf("--chat-id") + 1], "oc_builders");
      questionsSent++;
      return { data: { message_id: "om_question", chat_id: "oc_builders" } };
    },
    managedChatCreator: async input => { assert.equal(input.ownerId, "ou_owner"); groupCreates++; return { chatId: "oc_newgroup", ownerConfirmed: true }; },
    approvalCardSender: (_id, card) => { cards.push(card); return { ok: true, messageId: "om_fixture_card" }; },
    approvalCardUpdater: () => {}, textReplySender: () => ({ ok: true, messageId: "om_reply", chatId: "oc_fixture", messageAt: null, messageType: "text" }),
    proactiveMessageSender: () => { sends++; return { ok: true, messageId: "om_fake_send", chatId: "oc_contact", messageAt: null, messageType: "text" }; } });
  const client = new Client({ name: "migration-fixture", version: "1.0.0" });
  try {
    const runtimeUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });
    config.larkAgentRuntimeUrl = runtimeUrl;
    const server = larkAgentToolsMcpServer();
    assert(server);
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args,
      env: { ...Object.fromEntries(server.env.map(x => [x.name, x.value])), LARK_AGENT_RUNTIME_URL: runtimeUrl } }));
    assert.equal((await app.app.inject({ url: "/v1/internal/mcp/tools", headers: auth })).statusCode, 403);
    assert.equal((await app.app.inject({ method: "POST", url: "/v1/internal/mcp/tools/approve", headers: auth, payload: {} })).statusCode, 403);
    assert.equal((await app.app.inject({ method: "POST", url: "/v1/capabilities/register", headers: auth,
      payload: { capabilities: catalog } })).statusCode, 200);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["lark_approval_status", "lark__message__send", "lark__chat__create", "lark__chat__list_managed", "lark__group__ask", "lark__group__ask_reply",
      ...capableIds.map(id => id.replaceAll(".", "__"))].sort());
    const inspectTool = tools.find(t => t.name === "forge__deploy__inspect");
    assert.deepEqual(inspectTool?.inputSchema.properties?.input, catalog[0].inputSchema);
    assert.equal(inspectTool?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === "lark_approval_status")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === "forge__deploy__production")?.annotations?.readOnlyHint, false);
    const now = new Date().toISOString(), source = { chat_id: "oc_fixture", chat_type: "p2p" };
    app.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES (?,?,'untrusted','00000000-0000-4000-8000-000000000017',?,?)")
      .run(larkCodexSessionKeyForMessage(source, false), source.chat_id, now, now);
    app.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(1,'om_fixture','oc_fixture','p2p','ou_requester','user','text','Deploy the fixture service',1,'p2p','skipped','failed','{}',?,?)`).run(now, now);
    assert.equal(enqueueLarkCodexReply(1), true);
    const row = () => app.store.db.prepare("SELECT codex_turn_id,codex_task_dir,codex_status FROM lark_messages WHERE id=1").get() as
      { codex_turn_id: string | null; codex_task_dir: string; codex_status: string };
    await waitFor(() => Boolean(row().codex_turn_id));
    assert.deepEqual(JSON.parse(fs.readFileSync(rpc, "utf8")), { resumed: true });
    const context_token = fs.readFileSync(path.join(row().codex_task_dir, "prompt.md"), "utf8").match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
    assert(context_token);
    const call = (name: string, input: unknown, token = context_token) => client.callTool({ name, arguments: { context_token: token, input } });
    assert.equal((await call("lark__group__ask", { text: "Untrusted session" })).isError, true);
    assert.equal(questionsSent, 0);
    const groupInput = { requestId: "767dfbee-0ffd-4b61-8599-4d559e8686be", name: "Example group",
      execution: { engineId: "codex", model: null } };
    assert.equal((await call("lark__chat__create", groupInput)).isError, true);
    assert.equal(groupCreates, 0);
    const read = await call("forge__deploy__inspect", { repo: "demo-api" });
    assert.equal(Boolean(read.isError), false);
    assert.match(JSON.stringify(read.content), /found/);
    assert.doesNotMatch(JSON.stringify(read.content), /_receipt/);
    const input = { repo: "demo-api" };
    const plan = await call("lark_approval_plan", { goal: "Deploy the fixture service", impact: "Modify demo-api only",
      steps: [{ intent: "Deploy demo-api", effect: "remote-write", kind: "capability", cwd: null,
        operation: `forge.deploy.production: ${JSON.stringify(input)}` }] });
    assert.equal(Boolean(plan.isError), false);
    assert.equal(writes, 0);
    const confirmations = () => fs.existsSync(response)
      ? fs.readFileSync(response, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const confirm = (id: string, params: Record<string, unknown> = {}) => codexAppServer.request("fixture/confirm", {
      id, params: { threadId: "00000000-0000-4000-8000-000000000017", turnId: "fixture-turn", serverName: "lark_tools", mode: "form",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "forge__deploy__production", tool_params: { context_token, input } }, ...params }
    });
    await confirm("confirm-stale", { turnId: "old-turn" });
    assert.deepEqual((await waitFor(() => confirmations().find(r => r.id === "confirm-stale"))).result, { action: "decline", content: null });
    assert.equal(cards.length, 0);
    await confirm("confirm-valid");
    const card = await waitFor(() => cards[0]);
    assert.match(card.taskPlan ?? "", /Modify demo-api only/);
    assert.equal(writes, 0);
    assert.equal(confirmations().some(r => r.id === "confirm-valid"), false);
    assert.equal((await app.app.inject({ method: "POST", url: `/v1/approvals/${card.approvalId}/approve-turn`, headers: auth })).statusCode, 200);
    assert.deepEqual((await waitFor(() => confirmations().find(r => r.id === "confirm-valid"))).result, { action: "accept", content: {} });
    assert.equal(writes, 0);
    const changed = call("forge__deploy__production", { repo: "other-fixture" });
    const changedCard = await waitFor(() => cards[1]);
    assert.equal(writes, 0);
    assert.equal((await app.app.inject({ method: "POST", url: `/v1/approvals/${changedCard.approvalId}/reject`, headers: auth })).statusCode, 200);
    const rejected = await changed;
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /审批人明确拒绝/);
    const approvalState = await call("lark_approval_status", {});
    assert.notEqual(approvalState.isError, true);
    assert.match(JSON.stringify(approvalState.content), /rejected/);
    assert.doesNotMatch(JSON.stringify(approvalState.content), /ou_owner|demo-api|forge\.deploy/);
    assert.equal(Boolean((await call("forge__deploy__production", input)).isError), false);
    assert.equal(writes, 1);
    await confirm("confirm-cached");
    assert.deepEqual((await waitFor(() => confirmations().find(r => r.id === "confirm-cached"))).result, { action: "accept", content: {} });
    const cached = await call("forge__deploy__production", input);
    assert.equal(Boolean(cached.isError), false);
    assert.match(JSON.stringify(cached.content), /applied/);
    assert.equal(writes, 1);
    assert.equal(cards.length, 2);
    assert.equal(Boolean((await call("forge__deploy__inspect", input, "x".repeat(32))).isError), true);
    await codexAppServer.request("fixture/finish", {});
    await waitFor(() => row().codex_status === "answered");
    assert.equal(Boolean((await call("forge__deploy__inspect", input)).isError), true);
    assert.equal((await call("lark_approval_status", {})).isError, true);

    app.store.setSetting("trustedExecutionEnabled", "true");
    app.store.setSetting("ownerMessageFastPathEnabled", "true");
    app.store.setSetting("ownerMessageFastPathOwnerId", "ou_owner");
    app.store.db.prepare("INSERT INTO contacts (open_id,name,updated_at) VALUES (?,?,?)").run("ou_contact", "Example", now);
    app.store.db.prepare("INSERT INTO lark_codex_sessions (session_key,chat_id,trust_scope,codex_session_id,created_at,updated_at) VALUES (?,?,'trusted','00000000-0000-4000-8000-000000000017',?,?)")
      .run(larkCodexSessionKeyForMessage(source, true), source.chat_id, now, now);
    const ownerId = Number(app.store.db.prepare(`INSERT INTO lark_messages(message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES('om_owner','oc_fixture','p2p','ou_owner','user','text','跟Example说：hello',1,'p2p','skipped','failed','{}',?,?)`).run(now, now).lastInsertRowid);
    assert.equal(enqueueLarkCodexReply(ownerId), true);
    const ownerRow = () => app.store.db.prepare("SELECT codex_turn_id,codex_task_dir,codex_status FROM lark_messages WHERE id=?").get(ownerId) as ReturnType<typeof row>;
    await waitFor(() => ownerRow().codex_turn_id === "fixture-owner-turn");
    const ownerToken = fs.readFileSync(path.join(ownerRow().codex_task_dir, "prompt.md"), "utf8").match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
    assert(ownerToken);
    assert.equal((await call("lark__chat__create", groupInput, ownerToken)).isError, true, "an unverified local event is not a Feishu owner message");
    app.store.db.prepare("UPDATE lark_messages SET listener_verified=1 WHERE id=?").run(ownerId);
    await app.app.inject({ method: "POST", url: "/v1/messages", payload: {
      message_id: "om_owner", chat_id: "oc_fixture", chat_type: "p2p", sender_id: "ou_other", content: "Unverified replacement"
    } });
    assert.equal((app.store.db.prepare("SELECT sender_id FROM lark_messages WHERE id=?").get(ownerId) as { sender_id: string }).sender_id, "ou_owner");
    const direct = await app.app.inject({ method: "POST", url: "/v1/capabilities/lark.chat.create/invoke", headers: auth,
      payload: { input: groupInput, context: { larkMessageId: ownerId, turnId: "fixture-owner-turn", chatId: source.chat_id, trustScope: "trusted" } } });
    assert.notEqual(direct.statusCode, 200);
    assert.equal(groupCreates, 0);
    const createdGroup = await call("lark__chat__create", groupInput, ownerToken);
    assert.notEqual(createdGroup.isError, true, JSON.stringify(createdGroup.content));
    assert.match(JSON.stringify(createdGroup.content), /oc_newgroup/);
    assert(Array.isArray(createdGroup.content) && createdGroup.content[0]?.type === "text");
    assert.deepEqual(JSON.parse(createdGroup.content[0].text).item.execution, groupInput.execution);
    assert.equal(groupCreates, 1);
    assert.match(JSON.stringify((await call("lark__chat__list_managed", {}, ownerToken)).content), /oc_newgroup/);
    assert.notEqual((await call("lark__chat__create", groupInput, ownerToken)).isError, true);
    assert.equal(groupCreates, 1);
    const message = { recipient: "Example", text: "hello" };
    await confirm("confirm-owner", { turnId: "fixture-owner-turn",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "lark__message__send", tool_params: { context_token: ownerToken, input: message } } });
    assert.deepEqual((await waitFor(() => confirmations().find(r => r.id === "confirm-owner"))).result, { action: "accept", content: {} });
    assert.equal(cards.length, 2);
    const groupQuestion = { text: "What is the warehouse status?" };
    assert.equal((await call("lark__group__ask", { ...groupQuestion, chatId: "oc_other" }, ownerToken)).isError, true);
    const asked = call("lark__group__ask", groupQuestion, ownerToken);
    const groupCard = await waitFor(() => cards[2]);
    assert.equal(questionsSent, 0);
    const cardJson = JSON.stringify(buildLarkExecutionApprovalCard({
      ...groupCard, requester: "Fixture", operation: "", originalMessage: "", cwd: root, reason: null, allowPlanApproval: false
    }));
    assert.match(cardJson, /oc_builders.*ou_responder.*What is the warehouse status\?/);
    assert.equal((await app.app.inject({ method: "POST", url: `/v1/approvals/${groupCard.approvalId}/approve-turn`, headers: auth })).statusCode, 409);
    assert.equal(questionsSent, 0);
    assert.equal((await app.app.inject({ method: "POST", url: `/v1/approvals/${groupCard.approvalId}/approve`, headers: auth })).statusCode, 200);
    const sent = await asked;
    assert.notEqual(sent.isError, true, JSON.stringify(sent.content));
    assert.equal(questionsSent, 1);
    assert(Array.isArray(sent.content) && sent.content[0]?.type === "text");
    const { requestId } = JSON.parse(sent.content[0].text);
    assert.match(JSON.stringify((await call("lark__group__ask_reply", { requestId, waitSeconds: 0 }, ownerToken)).content), /open/);
    await app.app.inject({ method: "POST", url: "/v1/messages", payload: {
      message_id: "om_fake_answer", chat_id: "oc_builders", chat_type: "group", sender_id: "ou_responder",
      sender_type: "user", message_type: "text", reply_to: "om_question", content: "unverified reply"
    } });
    assert.match(JSON.stringify((await call("lark__group__ask_reply", { requestId, waitSeconds: 0 }, ownerToken)).content), /open/);
    assert.notEqual((await call("lark__group__ask", groupQuestion, ownerToken)).isError, true);
    assert.equal(questionsSent, 1);
    app.store.setSetting("trustedExecutionEnabled", "false");
    const revoked = await call("lark__message__send", message, ownerToken);
    assert.equal(revoked.isError, true);
    assert.match(JSON.stringify(revoked.content), /Capability trust scope|Capability identity/);
    assert.equal(sends, 0);
    await codexAppServer.request("fixture/finish", {});
    await waitFor(() => ownerRow().codex_status === "answered");
    assert.equal((await call("lark__chat__list_managed", {}, ownerToken)).isError, true);
  } finally {
    await client.close(); await app.app.close(); app.stop(); await host.close();
    if (oldExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = oldExecutable;
    process.env.PATH = oldPath;
    if (oldQuestionTarget === undefined) delete process.env.LARK_AGENT_GROUP_QUESTION_TARGET;
    else process.env.LARK_AGENT_GROUP_QUESTION_TARGET = oldQuestionTarget;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an opted-in restricted engine gets the shared MCP catalog and loses access when its turn ends", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-shared-external-"));
  let configName: string | undefined, prompt: string | undefined, steered: string | undefined, finish!: () => void;
  const host = Fastify();
  let writes = 0;
  host.post("/api/lark-agent/capabilities/forge.deploy.production", async () => ({ applied: ++writes }));
  const hostUrl = await host.listen({ host: "127.0.0.1", port: 0 });
  const cards: number[] = [];
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const engine: ExecutionEngine = { descriptor: { id: "fixture", label: "Fixture", models: [] }, supportsLarkMcp: true,
    supportsPolicy: policy => policy.trustScope === "untrusted", async open({ mcpServers }) {
      configName = mcpServers?.[0]?.name;
      return { id: "fixture-session", close() {},
        async run(text, signal) {
          prompt = text;
          await Promise.race([hold, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
          return signal.aborted ? { status: "cancelled" } : { status: "completed", text: "Fixture complete" };
        },
        async steer(text) {
          if (text.startsWith("Ambiguous follow-up")) throw new Error("fixture acknowledgement unavailable");
          steered = text; return "injected";
        } };
    } };
  const app = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: ["ou_owner"],
    runtimeToken: "fixture-host-token", approverId: "ou_owner", executionEngines: [engine], hostBaseUrl: hostUrl,
    approvalCardSender: (_id, card) => { cards.push(card.approvalId); return { ok: true, messageId: "om_fixture_card" }; },
    approvalCardUpdater: () => {},
    textReplySender: () => ({ ok: true, messageId: "om_reply", chatId: "oc_fixture", messageAt: null, messageType: "text" }) });
  try {
    const now = new Date().toISOString();
    assert.equal((await app.app.inject({ method: "POST", url: "/v1/capabilities/register", headers: auth,
      payload: { capabilities: [catalog[1]] } })).statusCode, 200);
    const insert = app.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,thread_id,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(?,?,'oc_fixture','group','omt_fixture','ou_owner','user','text','Fixture request',1,'mention','skipped','skipped','{}',?,?)`);
    insert.run(1, "om_first", now, now);
    assert.equal(updateConversationExecutionSettings("oc_fixture", { engineId: "fixture", model: null }), "ok");
    saveConversationPersona("oc_fixture", { mode: "custom", name: "Fixture", instructions: "Use the configured fixture persona." });
    insert.run(2, "om_second", now, now);
    assert.equal(enqueueLarkCodexReply(2), true);
    const text = await waitFor(() => prompt);
    assert.equal(configName, "lark_tools");
    assert.match(text, /Use the configured fixture persona/);
    const token = text.match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
    const secret = larkAgentToolsMcpServer()?.env.find(e => e.name === "LARK_AGENT_MCP_TOKEN")?.value;
    assert(token && secret);
    const call = (tool: string, input: unknown, contextToken = token) =>
      app.app.inject({ method: "POST", url: "/v1/internal/mcp/tools/call", headers: { authorization: `Bearer ${secret}` },
        payload: { tool, contextToken, input } });
    const submit = (contextToken = token) => call("lark_approval_plan", { goal: "Fixture deploy", impact: "Modify one fixture only",
      steps: [{ intent: "Deploy demo", effect: "remote-write", kind: "capability", operation: 'forge.deploy.production: {"repo":"demo-api"}', cwd: null }] }, contextToken);
    assert.equal((await submit()).statusCode, 200);
    const first = call("forge__deploy__production", { repo: "demo-api" });
    const firstCard = await waitFor(() => cards[0]);
    assert.equal(writes, 0);
    const approve = (id: number) => app.app.inject({ method: "POST", url: `/v1/approvals/${id}/approve`, headers: auth });
    assert.equal((await approve(firstCard)).statusCode, 200);
    assert.equal((await first).statusCode, 200);
    const pending = call("forge__deploy__production", { repo: "other-fixture" });
    const secondCard = await waitFor(() => cards[1]);
    insert.run(3, "om_followup", now, now);
    assert.equal(enqueueLarkCodexReply(3), true);
    await waitFor(() => app.store.db.prepare("SELECT codex_turn_id FROM lark_messages WHERE id=3").pluck().get() || undefined);
    const nextToken = steered?.match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];
    assert(nextToken && nextToken !== token);
    assert.equal((await approve(secondCard)).statusCode, 409);
    assert.equal((await pending).statusCode, 409);
    assert.equal(writes, 1);
    assert.equal((await submit()).statusCode, 409);
    assert.equal((await submit(nextToken)).statusCode, 200);
    const ambiguous = call("forge__deploy__production", { repo: "third-fixture" }, nextToken);
    const thirdCard = await waitFor(() => cards[2]);
    insert.run(4, "om_ambiguous", now, now);
    app.store.db.prepare("UPDATE lark_messages SET content='Ambiguous follow-up' WHERE id=4").run();
    assert.equal(enqueueLarkCodexReply(4), true);
    await waitFor(() => app.store.db.prepare("SELECT 1 FROM lark_messages WHERE id=4 AND codex_status='failed'").get());
    assert.equal((await approve(thirdCard)).statusCode, 409);
    assert.equal((await ambiguous).statusCode, 409);
    assert.equal(writes, 1);
    assert.equal((await submit(nextToken)).statusCode, 409);
  } finally { finish(); await app.app.close(); app.stop(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("external sticker MCP delivers only the current selection after final text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-external-stickers-"));
  const mediaLog = path.join(root, "media.log");
  fs.writeFileSync(path.join(root, "lark-cli"), `#!${process.execPath}
const fs=require("node:fs");
if(process.argv.includes("--image"))fs.appendFileSync(${JSON.stringify(mediaLog)},process.argv[process.argv.indexOf("--message-id")+1]+"\\n");
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? ""}`;
  type OpenOptions = Parameters<ExecutionEngine["open"]>[0];
  type Outcome = Awaited<ReturnType<Awaited<ReturnType<ExecutionEngine["open"]>>["run"]>>;
  let servers: OpenOptions["mcpServers"], prompt = "", steered = "", finish: ((outcome: Outcome) => void) | undefined;
  const engine: ExecutionEngine = {
    descriptor: { id: "fixture", label: "Fixture", models: [] }, supportsLarkMcp: true, supportsPolicy: () => true,
    async open(options) {
      servers = options.mcpServers;
      return { id: "fixture-session", close() {}, async run(text) {
        prompt = text;
        return new Promise<Outcome>(resolve => { finish = resolve; });
      }, async steer(text) { steered = text; return "injected"; } };
    }
  };
  let failText = true;
  const app = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "active", workspaceRoot: root, trustedSenderIds: [],
    runtimeToken: "fixture-host-token", executionEngines: [engine],
    textReplySender: () => failText ? { ok: false, error: "fixture text failure" }
      : { ok: true, messageId: "om_reply", chatId: "oc_fixture", messageAt: null, messageType: "text" } });
  const client = new Client({ name: "fixture-stickers", version: "1" });
  try {
    config.larkAgentRuntimeUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });
    const [sticker] = uploadLarkStickers([{ name: "得意", tags: ["得意"], fileName: "image.png", mimeType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==" }]);
    const now = new Date().toISOString();
    const insert = app.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
      VALUES(?,?,'oc_fixture','p2p','ou_sender','user','text','Fixture request',1,'p2p','skipped','skipped','{}',?,?)`);
    const add = (id: number) => insert.run(id, `om_source${id}`, now, now);
    const row = (id: number) => app.store.db.prepare("SELECT codex_status, codex_reply, codex_turn_id FROM lark_messages WHERE id=?").get(id) as
      { codex_status: string; codex_reply: string | null; codex_turn_id: string | null };
    const sent = () => app.store.db.prepare("SELECT lark_message_id FROM sticker_sends").pluck().all();
    const tokenIn = (text: string) => text.match(/context_token=([A-Za-z0-9_-]{32})/)![1];
    add(1);
    assert.equal(updateConversationExecutionSettings("oc_fixture", { engineId: "fixture", model: null }), "ok");
    const start = async (id: number) => {
      finish = undefined;
      add(id);
      assert.equal(enqueueLarkCodexReply(id), true);
      await waitFor(() => finish);
      return tokenIn(prompt);
    };
    app.store.setSetting("conversation.stickerUsageMode:oc_fixture", "always");
    const first = await start(2);
    assert.match(prompt, /表情包（每次回复）/);
    const descriptor = servers?.find(server => server.name === "lark_stickers");
    assert(descriptor);
    assert(!descriptor.env.some(item => item.name === "LARK_AGENT_RUNTIME_TOKEN"));
    await client.connect(new StdioClientTransport({ command: descriptor.command, args: descriptor.args,
      env: Object.fromEntries(descriptor.env.map(item => [item.name, item.value])) }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["search", "select"]);
    const search = (token: string) => client.callTool({ name: "search", arguments: { context_token: token, query: "得意" } });
    const select = (token: string) => client.callTool({ name: "select", arguments: { context_token: token, sticker_id: sticker.id } });
    assert.equal((await select(first)).isError, true);
    assert.notEqual((await search(first)).isError, true);
    assert.notEqual((await select(first)).isError, true);
    assert.deepEqual(sent(), []);
    finish!({ status: "completed", text: "**Final**" });
    await waitFor(() => row(2).codex_status === "answered");
    assert.equal(row(2).codex_reply, "**Final**");
    assert.deepEqual(sent(), []);
    assert.equal(app.store.db.prepare("SELECT status FROM lark_delivery_outbox WHERE lark_message_id=2 AND kind='media'").pluck().get(), "pending");
    assert.equal((await search(first)).isError, true);
    failText = false;
    app.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE id=2").run();
    retryPendingLarkTextReplies();
    app.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='1970-01-01' WHERE lark_message_id=2").run();
    retryPendingLarkMediaReplies();
    retryPendingLarkMediaReplies();
    assert.deepEqual(sent(), [2]);
    assert.equal(fs.readFileSync(mediaLog, "utf8"), "om_source2\n");

    const directive = `<lark-sticker>{"id":"${sticker.id}"}</lark-sticker>`;
    const next = await start(10);
    await search(next); await select(next);
    add(20);
    assert.equal(enqueueLarkCodexReply(20), true);
    await waitFor(() => row(20).codex_turn_id || undefined);
    assert.notEqual(tokenIn(steered), next);
    assert.equal((await select(next)).isError, true);
    assert.equal((await select(tokenIn(steered))).isError, true);
    finish!({ status: "completed", text: `Follow-up ${directive}` });
    await waitFor(() => row(10).codex_status === "answered");
    assert.equal(row(10).codex_reply, "Follow-up");

    for (const [id, result, expected] of [
      [30, { status: "completed", text: "<lark-no-reply/>" }, "no_reply"],
      [40, { status: "cancelled" }, "failed"]
    ] as const) {
      const token = await start(id);
      assert.notEqual((await search(token)).isError, true);
      assert.notEqual((await select(token)).isError, true);
      finish!(result);
      await waitFor(() => row(id).codex_status === expected);
    }
    const disabled = await start(50);
    assert.notEqual((await search(disabled)).isError, true);
    assert.notEqual((await select(disabled)).isError, true);
    app.store.setSetting("conversation.stickerUsageMode:oc_fixture", "off");
    assert.equal((await search(disabled)).isError, true);
    finish!({ status: "completed", text: `Off ${directive}` });
    await waitFor(() => row(50).codex_status === "answered");
    assert.equal(row(50).codex_reply, "Off");
    assert.deepEqual(sent(), [2]);
  } finally {
    finish?.({ status: "cancelled" });
    await client.close();
    await app.app.close(); app.stop();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
