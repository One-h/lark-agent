import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createRuntime, capabilityApprovalAction, type RuntimeConfig } from "./index.js";
import { config, declareApprovalPlan, enqueueLarkCodexReply, notifyLarkTurnEnded, postHostJson, decideLarkExecutionApprovalFromCard } from "@lark-agent/conversation-runtime";
import { codexAppServer } from "../../../packages/conversation-runtime/src/codexRuntime.js";
import { buildLarkExecutionApprovalCard, buildLarkExecutionApprovalResultCard, formatCapabilityApprovalOperation, type CapabilityApprovalCardInput } from "@lark-agent/adapter-lark-cli";

async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < end, "fixture did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function fixture(reviewer?: RuntimeConfig["turnApprovalReviewer"], native = false, wholeTaskAutoApproval?: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-approval-lifecycle-"));
  const host = Fastify(); let writes = 0; let hostBarrier: Promise<void> | null = null;
  host.post("/api/lark-agent/capabilities/:id", async () => { writes++; await hostBarrier; return { call: writes }; });
  await host.listen({ host: "127.0.0.1", port: 0 });
  const hostAddress = host.server.address(); assert(hostAddress && typeof hostAddress !== "string");
  const cards: CapabilityApprovalCardInput[] = [];
  const updates: Array<Parameters<NonNullable<RuntimeConfig["approvalCardUpdater"]>>[1]> = [];
  const runtime = createRuntime({ databasePath: path.join(root, "agent.sqlite"), workspaceRoot: root, mode: "shadow", runtimeToken: "fixture-token",
    approverId: "ou_owner", trustedSenderIds: [], hostBaseUrl: `http://127.0.0.1:${hostAddress.port}`, turnApprovalReviewer: reviewer, wholeTaskAutoApproval,
    turnActivityProbe: native ? undefined : async () => true,
    textReplySender: () => ({ ok: true, messageId: "om_reply", chatId: "oc_private", messageAt: null, messageType: "text" }),
    reactionSender: () => ({ ok: true }), approvalCardSender: (_recipient, card) => { cards.push(card); return { ok: true, messageId: `om_card_${card.approvalId}` }; },
    approvalCardUpdater: (_id, value) => { updates.push(value); } });
  runtime.store.registerCapabilities([{ id: "forge.deploy.production", title: "生产发布", description: "fixture deployment", inputSchema: {}, risk: "external-write" }]);
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address(); assert(address && typeof address !== "string");
  config.larkAgentRuntimeUrl = `http://127.0.0.1:${address.port}`;
  const seed = (status = "running", turn = "turn-one") => {
    const now = new Date().toISOString();
    runtime.store.db.prepare(`INSERT INTO lark_messages
      (id,message_id,chat_id,chat_type,sender_id,sender_type,content,message_type,mentioned,codex_status,codex_turn_id,codex_session_id,raw_json,received_at,created_at)
      VALUES (1,'om_request','oc_private','p2p','ou_requester','user','部署 demo-api','text',1,?,?,NULL,'{}',?,?)`).run(status, turn, now, now);
  };
  const invoke = (revision = "aaaaaaa", signal?: AbortSignal) => postHostJson(`http://127.0.0.1:${address.port}/v1/internal/capabilities/forge.deploy.production/execute`, {
    input: { repo: "demo-api", apps: ["demo-api"], expectedRevision: revision },
    context: { larkMessageId: 1, chatId: "oc_private", trustScope: "untrusted", turnId: "turn-one" }
  }, { authorization: "Bearer fixture-token" }, signal);
  const decide = (id: number, decision = "approve") => runtime.app.inject({ method: "POST", url: `/v1/approvals/${id}/${decision}`, headers: { authorization: "Bearer fixture-token" } });
  return { root, runtime, host, cards, updates, seed, invoke, decide, writes: () => writes,
    holdHost() { let release!: () => void; hostBarrier = new Promise<void>(resolve => { release = resolve; }); return release; },
    row: () => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE id=1").get() as any,
    async close() { await runtime.app.close(); runtime.stop(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("native and capability cards share actions, fields and truthful once/turn terminal labels", () => {
  const details = { requester: "Example", originalMessage: "export", operation: "/bin/zsh -lc " + "creator-row ".repeat(300),
    cwd: "/workspace", reason: "新建飞书表格并写入核对后的名单", taskContext: "previous task" };
  for (const target of [{ approvalToken: "native-token" }, { approvalId: 10 }]) {
    const card = buildLarkExecutionApprovalCard({ ...details, ...target });
    const text = JSON.stringify(card);
    assert.match(text, /Lark Agent 执行授权/); assert.match(text, /允许本次/); assert.match(text, /允许当前任务/); assert.match(text, /任务背景/);
    assert.match(text, /approve-turn/);
    assert.match(text, /执行意图：新建飞书表格并写入核对后的名单/);
    assert.doesNotMatch(text, /creator-row|\/bin\/zsh|\/workspace/);
    assert.ok(text.indexOf("执行意图") < text.indexOf("原始消息"));
  }
  const once = JSON.stringify(buildLarkExecutionApprovalResultCard({ ...details, status: "approved", approvalScope: "once", decidedAt: new Date().toISOString() }));
  assert.match(once, /已允许本次/); assert.doesNotMatch(once, /已允许当前任务/); assert.match(once, /不代表执行成功/);
  assert.match(once, /执行意图/); assert.doesNotMatch(once, /creator-row|\/bin\/zsh|\/workspace/);
  const batch = JSON.stringify(buildLarkExecutionApprovalCard({ ...details, approvalToken: "fixture",
    operationCount: 4, operationIntents: ["第一项", null, "第三项", "第四项"] }));
  assert.match(batch, /执行意图（4 项）/);
  assert.match(batch, /2\. 未提供意图/);
  assert.match(batch, /其余 1 项请在本地审批记录核对/);
  assert.doesNotMatch(batch, /第四项|creator-row/);
  assert.equal(capabilityApprovalAction({ action_value: { approval_id: 1, action: "approve" } }), null);
  assert.deepEqual(capabilityApprovalAction({ action_value: { approval_id: 1, action: "approve-turn" }, operator_id: "ou_owner", message_id: "om_card_1" }),
    { id: 1, decision: "approve-turn", actorId: "ou_owner", messageId: "om_card_1" });
  const operation = formatCapabilityApprovalOperation('发布: {"repo":"demo-api","apps":["demo-api"],"expectedRevision":"abcdef0","execute":false}');
  assert.match(operation, /仓库：demo-api/); assert.match(operation, /目标版本：abcdef0/); assert.doesNotMatch(operation, /execute/);
});

test("single-call authorization is not reused; human turn permission is scoped and replay-safe", async () => {
  const f = await fixture();
  try {
    f.seed();
    const first = f.invoke(); await until(() => f.cards.length === 1);
    assert.equal((await f.runtime.app.inject({ method: "POST", url: `/v1/approvals/${f.cards[0].approvalId}/approve` })).statusCode, 401);
    assert.equal((await f.runtime.decideApprovalFromCard({ action_value: { approval_id: f.cards[0].approvalId, action: "approve-turn" }, operator_id: "ou_other", message_id: "om_card_1" })).ok, false);
    assert.equal((await f.runtime.decideApprovalFromCard({ action_value: { approval_id: f.cards[0].approvalId, action: "approve-turn" }, operator_id: "ou_owner", message_id: "om_wrong" })).ok, false);
    assert.equal(f.writes(), 0);
    await f.decide(f.cards[0].approvalId); assert.equal((await first).status, 200);
    const second = f.invoke("bbbbbbb"); await until(() => f.cards.length === 2);
    assert.equal(f.writes(), 1);
    assert.equal((await f.runtime.decideApprovalFromCard({ action_value: { approval_id: f.cards[1].approvalId, action: "approve-turn" }, operator_id: "ou_owner", message_id: `om_card_${f.cards[1].approvalId}` })).ok, true);
    assert.equal((await second).status, 200);
    assert.equal(f.runtime.store.approval(f.cards[1].approvalId)?.approval_scope, "turn");
    assert.equal((await f.invoke("ccccccc")).status, 200); assert.equal(f.cards.length, 2);
    assert.equal((await f.decide(f.cards[1].approvalId, "approve-turn")).statusCode, 409);
    assert.equal((await f.invoke("bbbbbbb")).status, 200); assert.equal(f.writes(), 3);
    f.runtime.store.db.prepare("UPDATE lark_messages SET codex_turn_id='other-turn' WHERE id=1").run();
    assert.equal((await f.invoke("ddddddd")).status, 409); assert.equal(f.writes(), 3);
    const history = (await f.runtime.app.inject({ method: "GET", url: "/v1/approval-history?kind=manual", headers: { authorization: "Bearer fixture-token" } })).json();
    assert.ok(history.items.some((row: any) => row.kind === "capability" && row.scope === "turn"));
  } finally { await f.close(); }
});

test("ordinary groups retain capability approval while privacy-enabled groups cannot invoke host tools", async () => {
  const f = await fixture();
  try {
    f.seed();
    f.runtime.store.db.prepare("UPDATE lark_messages SET chat_type='group' WHERE id=1").run();
    const pending = f.invoke();
    await until(() => f.cards.length === 1);
    assert.equal(f.writes(), 0);
    assert.equal((await f.decide(f.cards[0].approvalId)).statusCode, 200);
    assert.equal((await pending).status, 200);
    assert.equal(f.writes(), 1);
    f.runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    assert.equal((await f.runtime.app.inject({ method: "PATCH", url: "/v1/group-privacy", headers: { authorization: "Bearer fixture-token" }, payload: { enabled: true } })).statusCode, 200);
    f.runtime.store.db.prepare("UPDATE lark_messages SET codex_status='running' WHERE id=1").run();
    const blocked = await f.invoke("bbbbbbb");
    assert.equal(blocked.status, 409);
    assert.match(blocked.body, /群聊隐私/);
    assert.equal(f.cards.length, 1);
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("terminal turns, replacement turns and expired cards cannot start deployment on a late click", async () => {
  for (const reason of ["completed", "replaced", "expired", "identity-changed"]) {
    const f = await fixture();
    try {
      f.seed(); const pending = f.invoke(); await until(() => f.cards.length === 1);
      const id = f.cards[0].approvalId;
      if (reason === "completed") { f.runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run(); notifyLarkTurnEnded(f.runtime.store.db, "turn-one"); }
      if (reason === "replaced") f.runtime.store.db.prepare("UPDATE lark_messages SET codex_turn_id='replacement' WHERE id=1").run();
      if (reason === "expired") f.runtime.store.db.prepare("UPDATE lark_capability_approvals SET expires_at='2000-01-01' WHERE id=?").run(id);
      if (reason === "identity-changed") f.runtime.store.db.prepare("UPDATE lark_messages SET sender_id='ou_changed' WHERE id=1").run();
      assert.equal((await f.decide(id)).statusCode, 409);
      const result = await pending;
      assert.equal(result.status, 409); assert.equal(f.writes(), 0);
      if (reason === "expired") {
        assert.equal(JSON.parse(result.body).approvalStatus, "expired");
        assert.match(JSON.parse(result.body).error, /超时.*未收到审批人的决定/);
      }
      assert.ok(["failed", "expired"].includes(f.runtime.store.approval(id)!.status));
      assert.equal((await f.decide(id, "approve-turn")).statusCode, 409);
    } finally { await f.close(); }
  }
});

test("client disconnect cancels the approval promise even when its native message remains running", async () => {
  const f = await fixture();
  try {
    f.seed(); const controller = new AbortController(); const pending = f.invoke("aaaaaaa", controller.signal); void pending.catch(() => {});
    await until(() => f.cards.length === 1); controller.abort();
    await assert.rejects(pending);
    await until(() => f.runtime.store.approval(f.cards[0].approvalId)?.status === "failed");
    assert.equal(f.row().codex_status, "running");
    assert.equal((await f.decide(f.cards[0].approvalId)).statusCode, 409); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("production defaults cannot approve a running database row without native activity proof", async () => {
  const f = await fixture(undefined, true);
  try {
    f.seed(); const pending = f.invoke(); await until(() => f.cards.length === 1);
    assert.equal((await f.runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnActivityProbe: true } })).statusCode, 400);
    assert.equal((await f.decide(f.cards[0].approvalId, "approve-turn")).statusCode, 409);
    assert.equal((await pending).status, 409); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("a late automatic decision cannot invoke the host or emit an applied authorization", async () => {
  let release!: () => void; let reviewing = false;
  const f = await fixture(async () => { reviewing = true; await new Promise<void>(resolve => { release = resolve; }); return { decision: "approve_turn", reason: "fixture" }; });
  try {
    f.seed(); await f.runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true } });
    const pending = f.invoke(); await until(() => reviewing);
    f.runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    notifyLarkTurnEnded(f.runtime.store.db, "turn-one"); release();
    assert.equal((await pending).status, 409); assert.equal(f.writes(), 0); assert.equal(f.cards.length, 0);
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_turn_auto_reviews WHERE applied_at IS NOT NULL").get() as any).n, 0);
  } finally { release?.(); await f.close(); }
});

test("graceful shutdown waits for an already authorized operation instead of losing its result", async () => {
  const f = await fixture(); let release: (() => void) | undefined;
  try {
    f.seed(); release = f.holdHost();
    const pending = f.invoke(); await until(() => f.cards.length === 1);
    await f.decide(f.cards[0].approvalId); await until(() => f.writes() === 1);
    f.runtime.store.db.prepare("UPDATE lark_messages SET codex_status='answered' WHERE id=1").run();
    notifyLarkTurnEnded(f.runtime.store.db, "turn-one");
    let closed = false; const closing = f.runtime.app.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, false);
    release(); assert.equal((await pending).status, 200); await closing;
    assert.equal((f.runtime.store.db.prepare("SELECT status FROM lark_capability_invocations LIMIT 1").get() as any).status, "completed");
    assert.equal(f.writes(), 1);
  } finally { release?.(); await f.close(); }
});

async function nativeFixture(order: "host-first" | "command-first" | "query", reviewer?: RuntimeConfig["turnApprovalReviewer"]) {
  const f = await fixture(reviewer, true, order === "query");
  const previousExecutable = process.env.CODEX_EXECUTABLE, previousPath = process.env.PATH;
  const executable = path.join(f.root, "codex.mjs");
  const decisions = path.join(f.root, "query-decisions.jsonl");
  const tokens = path.join(f.root, "query-tokens.txt");
  fs.writeFileSync(path.join(f.root, "lark-cli"), '#!/bin/sh\nprintf \'%s\\n\' \'{"data":{"message_id":"om_native"}}\'\n', { mode: 0o755 });
  fs.writeFileSync(executable, `#!${process.execPath}
import readline from "node:readline"; import {appendFileSync} from "node:fs";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
let status="inProgress";
const command=()=>send({id:"command-one",method:"item/commandExecution/requestApproval",params:{threadId:"thread-live",turnId:"turn-live",itemId:"cmd",command:"echo fixture",cwd:${JSON.stringify(f.root)}}});
const host=()=>send({id:"host-one",method:"item/tool/call",params:{threadId:"thread-live",turnId:"turn-live",tool:"forge__deploy__production",arguments:{repo:"demo-api",apps:["demo-api"],expectedRevision:"abcdef0"}}});
const finish=value=>{status=value;if(status==="completed")send({method:"item/completed",params:{threadId:"thread-live",turnId:"turn-live",item:{id:"answer",type:"agentMessage",phase:"final_answer",text:"fixture done"}}});send({method:"turn/completed",params:{threadId:"thread-live",turn:{id:"turn-live",status}}});};
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);
if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"thread-live"}}});
else if(m.method==="turn/start"){
 send({id:m.id,result:{turn:{id:"turn-live",status:"inProgress"}}});
 ${order === "query"
    ? `const token=JSON.stringify(m.params.input).match(/context_token=([A-Za-z0-9_-]{32})/)?.[1];if(token)appendFileSync(${JSON.stringify(tokens)},token);`
    : `setTimeout(${order === "host-first" ? "host" : "command"},20);`}
}
else if(m.method==="turn/steer")send({id:m.id,result:{turnId:"turn-live"}});
else if(m.method==="fixture/end"){send({id:m.id,result:{}});finish(m.params.status);}
else if(m.method==="fixture/state-only"){status=m.params.status;send({id:m.id,result:{}});}
else if(m.method==="fixture/query"){send({id:m.id,result:{}});send({id:m.params.id,method:m.params.method??"item/commandExecution/requestApproval",params:{threadId:"thread-live",turnId:"turn-live",itemId:m.params.id,command:m.params.command,reason:"Fixture operation intent",cwd:${JSON.stringify(f.root)}}});}
else if(m.method==="thread/read")send({id:m.id,result:{thread:{id:"thread-live",status:{type:status==="inProgress"?"active":"idle"}}}});
else if(m.method==="thread/turns/list")send({id:m.id,result:{data:[{id:"turn-live",status}]}});
else if(m.method)send({id:m.id,result:{}});
else if(String(m.id).startsWith("query-"))appendFileSync(${JSON.stringify(decisions)},JSON.stringify({id:m.id,decision:m.result?.decision})+"\\n");
else if(status==="inProgress"&&(m.result?.success===false||m.result?.decision==="decline"))finish("failed");
else if(m.id==="host-one"&&status==="inProgress"){${order === "host-first" ? "command();" : 'finish("completed");'}}
else if(m.id==="command-one"&&status==="inProgress"){${order === "command-first" ? "host();" : 'finish("completed");'}}
});`);
  fs.chmodSync(executable, 0o755); process.env.CODEX_EXECUTABLE = executable; process.env.PATH = `${f.root}:${previousPath ?? ""}`;
  f.seed("failed", "");
  if (order === "query") f.runtime.store.db.prepare("UPDATE lark_messages SET content='查询 fixture-db 的示例数据' WHERE id=1").run();
  assert.equal(enqueueLarkCodexReply(1), true);
  return { ...f, decisions, tokens, async close() { await f.close(); if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousExecutable; if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; } };
}

test("manual whole-turn approval accepts revised queries while automatic approval stays scoped", async () => {
  for (const manual of [true, false]) {
    let reviews = 0;
    const f = await nativeFixture("query", async () => {
      reviews++;
      return { decision: manual ? "manual" : "approve_turn", reason: "fixture" };
    });
    try {
      const { store } = f.runtime;
      store.setSetting("turnAutoApprovalEnabled", "true");
      store.setSetting("turnAutoApprovalDataSources", '["fixture-db"]');
      await until(() => f.row().codex_status === "running" && f.row().codex_turn_id === "turn-live");
      const identity = { messageId: 1, senderId: "ou_requester", turnId: "turn-live" };
      const first = "python3 query-fixture.py first";
      const revised = "python3 query-fixture.py revised";
      const plan = (operation: string) => ({ goal: "查询", impact: "只读",
        steps: [{ intent: "查询统计", effect: "read" as const, kind: "command" as const, operation, cwd: f.root }] });
      const send = (id: string, command: string) => codexAppServer.request("fixture/query", { id, command });
      const decision = (id: string) => fs.existsSync(f.decisions) ? fs.readFileSync(f.decisions, "utf8").trim().split("\n")
        .map(line => JSON.parse(line)).find(item => item.id === id)?.decision : undefined;
      declareApprovalPlan(store.db, identity, plan(first));
      await send("query-first", first);
      if (manual) {
        await until(() => f.cards.length === 1);
        assert.equal(decision("query-first"), undefined);
        assert.equal((await f.decide(f.cards[0].approvalId, "approve")).statusCode, 409);
        assert.equal((await f.decide(f.cards[0].approvalId, "approve-turn")).statusCode, 200);
      }
      await until(() => decision("query-first") === "accept");
      declareApprovalPlan(store.db, identity, plan(revised));
      await send("query-revised", revised);
      await until(() => decision("query-revised") === (manual ? "accept" : "decline"));
      await send("query-write", "mysql -e 'DELETE FROM fixture_rows'");
      await until(() => decision("query-write") === "decline");
      assert.equal((await approvalStatus(f)).json().text.includes('"status":"blocked"'), true);
      assert.equal(f.cards.length, manual ? 1 : 0);
      assert.equal(reviews, 1);
      await codexAppServer.request("fixture/end", { status: "completed" });
      await until(() => f.row().codex_status === "answered");
      await send("query-late", revised);
      await until(() => decision("query-late") === "decline");
    } finally { await f.close(); }
  }
});

test("first native operation opens one manual turn card without a registered plan or automatic review", async () => {
  const f = await nativeFixture("query", async () => assert.fail("automatic reviewer should be disabled"));
  try {
    assert.equal(f.runtime.store.setting("turnAutoApprovalEnabled", "false"), "false");
    await until(() => f.row().codex_status === "running" && fs.existsSync(f.tokens));
    const request = (id: string, method?: string, command?: string) => codexAppServer.request("fixture/query", { id, method, command });
    const result = (id: string) => fs.existsSync(f.decisions) ? fs.readFileSync(f.decisions, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).find(item => item.id === id)?.decision : undefined;
    await request("query-file", "item/fileChange/requestApproval");
    await until(() => f.cards.length === 1);
    assert.equal(f.cards[0].wholeTask, true);
    assert.equal(f.cards[0].taskPlan, undefined);
    assert.match(f.cards[0].originalMessage, /fixture-db/);
    assert.deepEqual(f.cards[0].operationIntents, ["Fixture operation intent"]);
    assert.equal(result("query-file"), undefined);
    assert.equal((await f.decide(f.cards[0].approvalId, "approve-turn")).statusCode, 200);
    await until(() => result("query-file") === "accept");
    await request("query-second", undefined, "echo next operation");
    await until(() => result("query-second") === "accept");
    assert.equal(f.cards.length, 1);
    await codexAppServer.request("fixture/end", { status: "completed" });
    await until(() => f.row().codex_status === "answered");
    await request("query-late", undefined, "echo must not reuse");
    await until(() => result("query-late") === "decline");
  } finally { await f.close(); }
});

test("trusted direct turns invoke host writes without an approval card", async () => {
  const f = await fixture();
  try {
    f.runtime.store.setSetting("trustedExecutionEnabled", "true");
    f.seed();
    f.runtime.store.db.prepare("UPDATE lark_messages SET sender_id='ou_owner' WHERE id=1").run();
    const response = await f.runtime.app.inject({ method: "POST", url: "/v1/internal/capabilities/forge.deploy.production/execute",
      headers: { authorization: "Bearer fixture-token" }, payload: { input: { repo: "demo-api" },
        context: { larkMessageId: 1, chatId: "oc_private", trustScope: "trusted", turnId: "turn-one" } } });
    assert.equal(response.statusCode, 200);
    assert.equal(f.writes(), 1);
    assert.equal(f.cards.length, 0);
    assert.equal((await f.invoke("bbbbbbb")).status, 409);
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

function approvalStatus(f: Awaited<ReturnType<typeof nativeFixture>>, input: unknown = {}, token = fs.readFileSync(f.tokens, "utf8")) {
  return f.runtime.app.inject({ method: "POST", url: "/v1/internal/mcp/tools/call",
    headers: { authorization: `Bearer ${config.larkAgentMcpToken}` },
    payload: { tool: "lark_approval_status", contextToken: token, input } });
}

test("native declines expose different model-visible outcomes for timeout and human rejection", async () => {
  for (const outcome of ["expired", "rejected"] as const) {
    const f = await nativeFixture("query", async () => ({ decision: "manual", reason: "fixture" }));
    try {
      f.runtime.store.setSetting("turnAutoApprovalEnabled", "true");
      await until(() => f.row().codex_status === "running" && fs.existsSync(f.tokens));
      await codexAppServer.request("fixture/query", { id: "query-first", command: "python3 query-fixture.py" });
      await until(() => f.cards.length === 1);
      const id = f.cards[0].approvalId;
      assert.deepEqual(JSON.parse((await approvalStatus(f)).json().text).outcomes.map((row: { status: string }) => row.status), ["pending"]);
      assert.equal((await approvalStatus(f, { messageId: 99 })).statusCode, 400);
      assert.equal((await approvalStatus(f, {}, "x".repeat(32))).statusCode, 409);
      if (outcome === "expired") {
        f.runtime.store.db.prepare("UPDATE lark_capability_approvals SET expires_at='2000-01-01' WHERE id=?").run(id);
        f.runtime.expireApprovals();
      } else {
        assert.equal((await f.decide(id, "reject")).statusCode, 200);
      }
      await until(() => fs.existsSync(f.decisions));
      assert.equal(JSON.parse(fs.readFileSync(f.decisions, "utf8")).decision, "decline");
      const result = await approvalStatus(f);
      assert.equal(result.statusCode, 200);
      const { outcomes } = JSON.parse(result.json().text);
      assert.deepEqual(outcomes.map((row: { status: string }) => row.status), [outcome]);
      assert.match(outcomes[0].message, outcome === "expired" ? /超时.*未收到审批人的决定/ : /明确拒绝/);
      assert.equal(f.runtime.store.approval(id)?.status, outcome);
      assert.equal(f.writes(), 0);
      await codexAppServer.request("fixture/end", { status: "completed" });
      await until(() => f.row().codex_status === "answered");
      assert.equal((await approvalStatus(f)).statusCode, 409);
    } finally { await f.close(); }
  }
});

test("native terminal notification invalidates an outstanding host approval before any host write", async () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const f = await nativeFixture("host-first");
    try {
      await until(() => f.cards.length === 1);
      assert.equal(f.row().codex_status, "running");
      await codexAppServer.request("fixture/end", { status });
      await until(() => f.runtime.store.approval(f.cards[0].approvalId)?.status === "failed");
      assert.equal((await f.decide(f.cards[0].approvalId, "approve-turn")).statusCode, 409);
      assert.equal(f.writes(), 0);
    } finally { await f.close(); }
  }
});

test("native terminal readback blocks approval even when its completion notification was lost", async () => {
  const f = await nativeFixture("host-first");
  try {
    await until(() => f.cards.length === 1);
    await codexAppServer.request("fixture/state-only", { status: "completed" });
    assert.equal(f.row().codex_status, "running");
    assert.equal((await f.decide(f.cards[0].approvalId)).statusCode, 409);
    assert.equal(f.writes(), 0);
    assert.equal(f.row().codex_status, "failed");
    assert.equal((f.runtime.store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox WHERE kind='completion-reaction'").get() as any).n, 0);
    await until(() => f.runtime.store.approval(f.cards[0].approvalId)?.status === "failed");
  } finally { await f.close(); }
});

test("legacy host tool callbacks cannot execute after a newer message takes over their turn", async () => {
  const f = await nativeFixture("host-first");
  try {
    await until(() => f.cards.length === 1);
    const source = f.runtime.store.db.prepare("SELECT * FROM lark_messages WHERE id=1").get() as
      { chat_id: string; chat_type: string; reply_trigger: string; sender_id: string };
    const now = new Date().toISOString();
    f.runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,
      reply_status,codex_status,raw_json,received_at,created_at) VALUES (2,'om_new',?,?,?,'user','text','Recheck this scope',1,?,'skipped','failed','{}',?,?)`)
      .run(source.chat_id, source.chat_type, source.sender_id, source.reply_trigger, now, now);
    assert.equal(enqueueLarkCodexReply(2), true);
    await until(() => {
      const row = f.runtime.store.db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id=2").get() as { codex_task_dir?: string };
      if (!row.codex_task_dir) return false;
      const file = path.join(row.codex_task_dir, "resume-session.json");
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).action === "turn/steer";
    });
    assert.equal((await f.decide(f.cards[0].approvalId)).statusCode, 409);
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("native command approval cards also become invalid when the turn ends", async () => {
  const f = await nativeFixture("command-first");
  try {
    const row = () => f.runtime.store.db.prepare("SELECT * FROM lark_execution_approvals WHERE status='pending' LIMIT 1").get() as any;
    await until(() => Boolean(row()?.card_message_id));
    const approval = row();
    await codexAppServer.request("fixture/end", { status: "completed" });
    await until(() => !row());
    assert.equal(decideLarkExecutionApprovalFromCard({ token: approval.token, decision: "approve-turn", operatorId: "ou_owner", messageId: approval.card_message_id }).ok, false);
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("one human turn grant is shared between native command and host tools in both directions", async () => {
  for (const order of ["host-first", "command-first"] as const) {
    const f = await nativeFixture(order);
    try {
      if (order === "host-first") {
        await until(() => f.cards.length === 1);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(f.writes(), 0); assert.equal(f.row().codex_status, "running");
        assert.equal((await f.decide(f.cards[0].approvalId, "approve-turn")).statusCode, 200);
      } else {
        const pending = () => f.runtime.store.db.prepare("SELECT * FROM lark_execution_approvals WHERE status='pending' LIMIT 1").get() as any;
        await until(() => Boolean(pending()?.card_message_id));
        assert.equal(decideLarkExecutionApprovalFromCard({ token: pending().token, decision: "approve-turn", operatorId: "ou_owner", messageId: pending().card_message_id }).ok, true);
      }
      await until(() => f.row().codex_status === "answered");
      assert.equal(f.writes(), 1);
      assert.equal(f.cards.length, order === "host-first" ? 1 : 0);
    } finally { await f.close(); }
  }
});
