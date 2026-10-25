import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { approvalTask, configuredTurnAutoApprovalDataSources, deploymentOperationMatchesTask, configureTurnApprovalReviewer, decideTurnAutoApproval, finishLarkTurnAutoApproval, humanApprovalHistory, reviewLarkTurnAutoApproval, type TurnApprovalInput, type TurnApprovalReviewer } from "./turnAutoApproval.js";
import { turnApprovalModelPrompt } from "./turnApprovalReviewer.js";
import { matchesLarkExecutionApprovalTurn, shouldReuseLarkTurnApproval } from "./responder.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-turn-approval-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, larkStickerDirectory: path.join(root, "stickers"), repoRoot: root, approverId: "ou_owner" });
  return { root, store, close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const input: TurnApprovalInput = { messageId: 100, turnId: "turn-new", senderId: "ou_sender",
  originalMessage: "https://git.example.com/team/repo/pulls/23 please review", operation: "node scripts/record-task.mjs review", cwd: "/tmp/workspace" };

function addHuman(store: SqliteAgentStore, options: { id: number; message?: string; sender?: string; owner?: string; scope?: string; status?: string; card?: string | null; cwd?: string; operation?: string } ) {
  const now = `2026-10-${String(options.id).padStart(2, "0")}T00:00:00.000Z`;
  store.db.prepare("INSERT INTO lark_messages (id,sender_id,content,raw_json,received_at,created_at) VALUES (?,?,?,'{}',?,?)")
    .run(options.id, options.sender ?? "ou_sender", options.message ?? input.originalMessage, now, now);
  store.db.prepare(`INSERT INTO lark_execution_approvals
    (id,token,lark_message_id,requester_id,approver_id,request_method,server_request_id,thread_id,turn_id,item_id,operation,cwd,status,approval_scope,card_message_id,created_at,expires_at,decided_at)
    VALUES (?,?,?,?,?,'item/commandExecution/requestApproval',?,'old-thread',?,'old-item',?,?,?,?,?,?,?,?)`)
    .run(options.id, `token-${options.id}`, options.id, options.sender ?? "ou_sender", options.owner ?? "ou_owner", `rpc-${options.id}`, `old-${options.id}`,
      options.operation ?? "log task",options.cwd ?? input.cwd, options.status ?? "approved", options.scope ?? "turn", options.card === undefined ? `om_card_${options.id}` : options.card, now, now, now);
}

test("history matches another PR in the same repository without model calls", async () => {
  const f = fixture(); let calls = 0;
  try {
    addHuman(f.store, { id: 1, message: input.originalMessage.replace("23", "1") });
    const result = await decideTurnAutoApproval(input, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { calls++; throw new Error("must not call"); } });
    assert.equal(result.approved, true); assert.equal(result.source, "history"); assert.equal(result.matchedApprovalId, 1); assert.equal(calls, 0);
    assert.equal((f.store.db.prepare("SELECT decision FROM lark_turn_auto_reviews").get() as { decision: string }).decision, "approved");
  } finally { f.close(); }
});

test("automatic rows and expired cards do not become human precedents", async () => {
  const f = fixture(); let calls = 0;
  try {
    addHuman(f.store, { id: 1, card: null }); addHuman(f.store, { id: 2, status: "expired" });
    const result = await decideTurnAutoApproval(input, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { calls++; return { decision: "approve_turn", reason: "PR review" }; } });
    assert.equal(humanApprovalHistory(f.store.db, "ou_sender", "ou_owner").length, 0);
    assert.equal(result.source, "model"); assert.equal(calls, 1);
  } finally { f.close(); }
});

test("latest human rejection and once-only grants override older turn approval", async () => {
  for (const latest of [{ status: "rejected", scope: "turn" }, { status: "approved", scope: "once" }]) {
    const f = fixture();
    try {
      addHuman(f.store, { id: 1 }); addHuman(f.store, { id: 2, ...latest });
      const result = await decideTurnAutoApproval(input, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { throw new Error("must not call"); } });
      assert.equal(result.approved, false); assert.equal(result.source, "history"); assert.equal(result.matchedApprovalId, 2);
    } finally { f.close(); }
  }
});

test("history remains isolated by sender, approver, repository and working directory", async () => {
  const variants = [{ senderId: "ou_other" }, { originalMessage: input.originalMessage.replace("team/repo", "team/other") }, { cwd: "/tmp/other" }];
  for (const override of variants) {
    const f = fixture(); let calls = 0;
    try {
      addHuman(f.store, { id: 1 });
      await decideTurnAutoApproval({ ...input, ...override }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { calls++; return { decision: "manual", reason: "different scope" }; } });
      assert.equal(calls, 1);
    } finally { f.close(); }
  }
  const f = fixture();
  try { addHuman(f.store, { id: 1, owner: "ou_old_owner" }); assert.deepEqual(humanApprovalHistory(f.store.db, "ou_sender", "ou_owner"), []); }
  finally { f.close(); }
});

test("code pushes and SQL mutations never reuse a PR grant", async () => {
  for (const override of [{ operation: "git push origin main" }, { operation: "DELETE FROM orders" }]) {
    const f = fixture();
    try {
      addHuman(f.store, { id: 1 });
      const result = await decideTurnAutoApproval({ ...input, ...override }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { throw new Error("must not call"); } });
      assert.equal(result.approved, false); assert.equal(result.source, "manual");
    } finally { f.close(); }
  }
});

test("deployment uses its own human scope first and otherwise asks the model", async () => {
  const deployment = { ...input, originalMessage:"请部署生产的 demo-api",operation:"node deploy-app.mjs --repo demo-api --app demo-api --execute" };
  const f=fixture(); let calls=0;
  const reviewer:TurnApprovalReviewer=async()=>{calls++;return {decision:"approve_turn",reason:"指定应用的常规部署"};};
  try {
    addHuman(f.store,{id:1,message:"帮我上线生产 demo-api",operation:deployment.operation});
    const matched=await decideTurnAutoApproval(deployment,{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer});
    assert.equal(matched.source,"history"); assert.equal(matched.approved,true); assert.equal(calls,0);
    for (const [index,change] of [
      {originalMessage:"部署预发 demo-api"},{originalMessage:"部署生产 demo-worker"},
      {operation:"node deploy-app.mjs --repo demo-worker --execute"},
      {operation:"node deploy-app.mjs --execute"},
      {operation:"kubectl apply -f prod.yaml"},
      {originalMessage:"检查 demo-api 当前服务状态",operation:"node deploy-app.mjs --repo demo-api --refresh-only"},
      {originalMessage:"请部署服务",operation:"node deploy-app.mjs --execute"},
      {originalMessage:`${input.originalMessage} 然后部署 demo-api`},
      {originalMessage:"部署生产 demo-api 并检查状态"}
    ].entries()) {
      const result=await decideTurnAutoApproval({...deployment,...change,turnId:`deployment-model-${index}`},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer});
      assert.equal(result.source,"model");
    }
    assert.equal(calls,9);
    addHuman(f.store,{id:2,message:deployment.originalMessage,status:"rejected"});
    const rejected=await decideTurnAutoApproval({...deployment,turnId:"deployment-rejected"},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer});
    assert.equal(rejected.source,"history");assert.equal(rejected.approved,false);assert.equal(calls,9);
  } finally {f.close();}
});

test("read-only deployment history cannot authorize a deployment turn", async()=>{
  const f=fixture();let calls=0;
  try {
    addHuman(f.store,{id:1,message:"检查 demo-api 当前服务状态"});
    const result=await decideTurnAutoApproval({...input,originalMessage:"部署 demo-api",operation:"node deploy-app.mjs --repo demo-api --execute"},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer:async()=>{calls++;return {decision:"approve_turn",reason:"明确部署"};}});
    assert.equal(result.source,"model");assert.equal(calls,1);
    assert.equal(approvalTask("检查 demo-api 当前服务状态")?.type,"deployment_query");
    assert.equal(approvalTask("部署生产与预发 demo-api"),null);
    assert.equal(approvalTask("部署 demo-api 不要部署 demo-worker"),null);
    assert.equal(approvalTask("帮我 sync demo-api")?.type,"deployment");
    const task=approvalTask("部署 demo-api");
    assert.equal(deploymentOperationMatchesTask(task,'forge.deploy.production: {"repo":"demo-worker","apps":["demo-worker"]}'),false);
    assert.equal(deploymentOperationMatchesTask(task,'forge.deploy.production: {"repo":"demo-api","apps":["demo-api"]}'),true);
    assert.equal(deploymentOperationMatchesTask(task,'argocd --core app sync demo-worker'),false);
    assert.equal(deploymentOperationMatchesTask(task,'node deploy-app.mjs --execute'),false);
    assert.equal(deploymentOperationMatchesTask(task,'kubectl apply -f prod.yaml'),false);
  } finally {f.close();}
});

test("deployment precedent must include a compatible operation and cannot fall through to an older grant",async()=>{
  const f=fixture();let calls=0;
  const request={...input,originalMessage:"部署 demo-api",operation:"node deploy-app.mjs --repo demo-api --app demo-api --execute"};
  const reviewer:TurnApprovalReviewer=async()=>{calls++;return {decision:"manual",reason:"历史操作目标无法确认"};};
  try {
    addHuman(f.store,{id:1,message:request.originalMessage,operation:request.operation});
    addHuman(f.store,{id:2,message:request.originalMessage,operation:"node deploy-app.mjs --repo demo-worker --execute"});
    assert.equal((await decideTurnAutoApproval(request,{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer})).source,"model");
    assert.equal(calls,1);
    addHuman(f.store,{id:3,message:request.originalMessage,operation:"node deploy-app.mjs --execute"});
    assert.equal((await decideTurnAutoApproval({...request,turnId:"unknown-history-target"},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer})).source,"model");
    assert.equal(calls,2);
    addHuman(f.store,{id:4,message:request.originalMessage,operation:request.operation});
    assert.equal((await decideTurnAutoApproval({...request,turnId:"compatible-history-target"},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer})).source,"history");
    assert.equal(calls,2);
  } finally {f.close();}
});

test("disabled policy, missing identities, malformed result and reviewer timeout fall back", async () => {
  const f = fixture();
  try {
    assert.equal((await decideTurnAutoApproval(input, { database: f.store.db, enabled: false, approverId: "ou_owner" })).source, "disabled");
    assert.equal((await decideTurnAutoApproval(input, { database: f.store.db, enabled: true, approverId: "" })).source, "disabled");
    for (const [index, reviewer] of [async () => { throw new Error("timeout"); }, async () => ({ decision: "allow", reason: "" })].entries()) {
      const result = await decideTurnAutoApproval({ ...input, turnId: `turn-failure-${index}` }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: reviewer as TurnApprovalReviewer });
      assert.equal(result.approved, false); assert.equal(result.source, "manual");
      assert.equal((f.store.db.prepare("SELECT model FROM lark_turn_auto_reviews WHERE turn_id=?").get(`turn-failure-${index}`) as { model: string }).model, "gpt-6.1-sol");
    }
  } finally { f.close(); }
});

test("concurrent requests reuse one review but a different sender or turn is reviewed separately", async () => {
  const f = fixture(); let calls = 0;
  configureTurnApprovalReviewer(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return { decision: "approve_turn", reason: "query only" }; });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    const results = await Promise.all([reviewLarkTurnAutoApproval(input), reviewLarkTurnAutoApproval({ ...input, operation: "next command" })]);
    assert(results.every((result) => result.approved)); assert.equal(calls, 1);
    await reviewLarkTurnAutoApproval({ ...input, senderId: "ou_other" }); assert.equal(calls, 2);
    await reviewLarkTurnAutoApproval({ ...input, turnId: "turn-next" }); assert.equal(calls, 3);
    setAppSettingValue("turnAutoApprovalEnabled", "false"); assert.equal((await reviewLarkTurnAutoApproval(input)).approved, false);
  } finally { finishLarkTurnAutoApproval(input.turnId); finishLarkTurnAutoApproval("turn-next"); configureTurnApprovalReviewer(); f.close(); }
});

test("review prompt is bounded, keeps only three precedents and treats target scope conservatively", () => {
  assert.equal(approvalTask("查 analytics_demo 最新 GMV", ["analytics_demo"])?.target, "analytics_demo");
  assert.equal(approvalTask("请继续"), null);
  const history = Array.from({ length: 10 }, (_, id) => ({ id, originalMessage: "x".repeat(5000), operation: "x".repeat(5000), cwd: null, status: "approved", scope: "turn", decidedAt: "now" }));
  const prompt = turnApprovalModelPrompt({ ...input, originalMessage: "x".repeat(10000), operation: "x".repeat(10000) }, history);
  assert(prompt.length < 7200); assert.equal(JSON.parse(prompt).history.length, 3);
});

test("query precedents use only configured exact data sources and never cross sources", async () => {
  const f = fixture(); let calls = 0, turn = 0;
  const reviewer: TurnApprovalReviewer = async () => { calls++; return { decision: "manual", reason: "review required" }; };
  const query = { ...input, originalMessage: "查询 analytics_demo 最近的汇总", operation: "readonly-query analytics_demo" };
  try {
    assert.deepEqual(configuredTurnAutoApprovalDataSources(f.store.db), []);
    addHuman(f.store, { id: 1, message: query.originalMessage, operation: query.operation });
    const decide = () => decideTurnAutoApproval({ ...query, turnId: `query-turn-${++turn}` }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer });
    assert.equal((await decide()).source, "model");
    setAppSettingValue("turnAutoApprovalDataSources", JSON.stringify(["ANALYTICS_DEMO", "orders_demo"]));
    assert.deepEqual(configuredTurnAutoApprovalDataSources(f.store.db), ["analytics_demo", "orders_demo"]);
    assert.equal((await decide()).source, "history"); assert.equal(calls, 1);
    assert.equal(approvalTask("查询 analytics_demo_backup 的数据", ["analytics_demo"]), null);
    assert.equal(approvalTask("查询 analytics_demo 和 orders_demo", ["analytics_demo", "orders_demo"]), null);
    assert.equal(approvalTask("查询 billing.prod-v2 的数据", ["billing.prod-v2"])?.target, "billing.prod-v2");
    assert.equal(approvalTask("查询 billingXprod-v2 的数据", ["billing.prod-v2"]), null);
    const other = await decideTurnAutoApproval({ ...query, originalMessage: "查询 orders_demo 的数据" }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer });
    assert.equal(other.source, "model");
    setAppSettingValue("turnAutoApprovalDataSources", "[]");
    assert.equal((await decide()).source, "model");
  } finally { f.close(); }
});

test("deployment without a simple keyword reaches the model but cached PR grants do not authorize deployment",async()=>{
  const f=fixture();let calls=0;
  configureTurnApprovalReviewer(async()=>{calls++;return {decision:"approve_turn",reason:"明确目标"};});
  try {
    setAppSettingValue("turnAutoApprovalEnabled","true");
    await reviewLarkTurnAutoApproval(input);
    const deploymentOperation='forge.deploy.production: {"repo":"demo-api","apps":["demo-api"]}';
    const expanded=await reviewLarkTurnAutoApproval({...input,operation:deploymentOperation});
    assert.equal(expanded.approved,false);assert.equal(calls,1);
    const first=await reviewLarkTurnAutoApproval({...input,turnId:"continue-deploy",originalMessage:"继续 demo-api，同样处理",operation:deploymentOperation});
    assert.equal(first.source,"model");assert.equal(calls,2);
    await reviewLarkTurnAutoApproval({...input,turnId:"continue-deploy",originalMessage:"继续 demo-api，同样处理",operation:deploymentOperation});
    assert.equal(calls,2);
    await reviewLarkTurnAutoApproval({...input,turnId:"inspect-only",originalMessage:"查询 demo-api 部署状态",operation:"node deploy-app.mjs --app demo-api --refresh-only"});
    assert.equal((await reviewLarkTurnAutoApproval({...input,turnId:"inspect-only",originalMessage:"查询 demo-api 部署状态",operation:deploymentOperation})).approved,false);
    assert.equal(calls,3);
  } finally {finishLarkTurnAutoApproval(input.turnId);finishLarkTurnAutoApproval("continue-deploy");finishLarkTurnAutoApproval("inspect-only");configureTurnApprovalReviewer();f.close();}
});

test("model settings are captured once per review and the audit keeps the actual model", async () => {
  const f = fixture(); const models: Array<string | undefined> = [];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  configureTurnApprovalReviewer(async (_input, _history, _signal, model) => {
    models.push(model); entered(); await gate;
    return { decision: "approve_turn", reason: "read only" };
  });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    setAppSettingValue("turnAutoApprovalModel", "gpt-5.6-terra");
    const first = reviewLarkTurnAutoApproval(input);
    await ready;
    setAppSettingValue("turnAutoApprovalModel", "gpt-6.1-sol");
    release(); await first;
    await reviewLarkTurnAutoApproval(input);
    assert.deepEqual(models, ["gpt-5.6-terra"]);
    await reviewLarkTurnAutoApproval({ ...input, turnId: "next-model-turn" });
    assert.deepEqual(models, ["gpt-5.6-terra", "gpt-6.1-sol"]);
    const audit = f.store.db.prepare("SELECT model FROM lark_turn_auto_reviews ORDER BY id").all() as Array<{ model: string }>;
    assert.deepEqual(audit.map((row) => row.model), models);
  } finally { release(); finishLarkTurnAutoApproval(input.turnId); finishLarkTurnAutoApproval("next-model-turn"); configureTurnApprovalReviewer(); f.close(); }
});

test("modern execution approvals require both thread and turn, and grants bind their approver", () => {
  const run = { threadId: "thread", turnId: "current" };
  assert.equal(matchesLarkExecutionApprovalTurn("item/commandExecution/requestApproval", { threadId: "thread", turnId: "old" }, run), false);
  assert.equal(matchesLarkExecutionApprovalTurn("item/fileChange/requestApproval", { threadId: "other", turnId: "current" }, run), false);
  assert.equal(matchesLarkExecutionApprovalTurn("item/permissions/requestApproval", run, run), true);
  assert.equal(matchesLarkExecutionApprovalTurn("execCommandApproval", { threadId: "thread", turnId: "thread" }, run), true);
  const grant = { runTurnId: "current", requestTurnId: "current", approvedRequesterId: "sender", requesterId: "sender", approvedApproverId: "owner", currentApproverId: "owner" };
  assert.equal(shouldReuseLarkTurnApproval(grant), true);
  assert.equal(shouldReuseLarkTurnApproval({ ...grant, currentApproverId: "new-owner" }), false);
  assert.equal(shouldReuseLarkTurnApproval({ ...grant, currentApproverId: "" }), false);
});
