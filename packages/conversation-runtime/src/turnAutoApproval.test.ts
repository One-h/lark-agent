import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime, setAppSettingValue } from "./context.js";
import { approvalTask, configuredTurnAutoApprovalDataSources, deploymentOperationMatchesTask, configureTurnApprovalReviewer, decideTurnAutoApproval, finishLarkTurnAutoApproval, humanApprovalHistory, requiresManualTurnApproval, reviewLarkTurnAutoApproval, type TurnApprovalInput, type TurnApprovalReviewer } from "./turnAutoApproval.js";
import { defaultTurnApprovalPrompt, parseTurnApprovalDecision, turnApprovalModelPrompt, turnApprovalThreadInstructions } from "./turnApprovalReviewer.js";
import { applyPlanAuthorization, currentApprovalPlanGrant, declareApprovalPlan, parseApprovalPlan } from "./approvalPlan.js";
import { matchesLarkExecutionApprovalTurn, shouldReuseLarkTurnApproval } from "./responder.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-turn-approval-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, larkStickerDirectory: path.join(root, "stickers"), repoRoot: root, approverId: "ou_owner" });
  return { root, store, close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const input: TurnApprovalInput = { messageId: 100, turnId: "turn-new", senderId: "ou_sender",
  originalMessage: "https://git.example.com/team/repo/pulls/23 please review", operation: "node scripts/record-task.mjs review", cwd: "/tmp/workspace" };

test("operation review migration retains old audit ids and allows multiple records per turn", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-approval-migration-"));
  const file = path.join(root, "test.sqlite");
  const legacy = new Database(file);
  try {
    legacy.exec(`CREATE TABLE lark_turn_auto_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, turn_id TEXT NOT NULL,
      requester_id TEXT NOT NULL, approver_id TEXT NOT NULL, task_type TEXT, target TEXT, cwd TEXT,
      source TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, matched_approval_id INTEGER,
      model TEXT, usage_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, applied_at TEXT,
      UNIQUE(turn_id, requester_id, approver_id)
    );
    INSERT INTO lark_turn_auto_reviews(id,lark_message_id,turn_id,requester_id,approver_id,source,decision,reason,created_at,applied_at)
    VALUES(71,20,'fixture-turn','ou_sender','ou_owner','model','approved','legacy audit','old','applied');`);
    legacy.close();
    const migrated = new SqliteAgentStore(file);
    try {
      const db = migrated.db;
      assert.deepEqual(db.prepare("SELECT id,approval_scope,applied_at FROM lark_turn_auto_reviews WHERE id=71").get(),
        { id: 71, approval_scope: "turn", applied_at: "applied" });
      const added = db.prepare(`INSERT INTO lark_turn_auto_reviews
        (lark_message_id,turn_id,requester_id,approver_id,source,decision,reason,created_at,approval_scope)
        SELECT lark_message_id,turn_id,requester_id,approver_id,'model','approved','operation','new','once' FROM lark_turn_auto_reviews WHERE id=71`).run();
      assert.equal(added.lastInsertRowid, 72);
    } finally { migrated.close(); }
  } finally { if (legacy.open) legacy.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

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
    addHuman(f.store, { id: 1, message: input.originalMessage.replace("23", "1"), operation: input.operation });
    const result = await decideTurnAutoApproval(input, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { calls++; throw new Error("must not call"); } });
    assert.equal(result.approved, true); assert.equal(result.source, "history"); assert.equal(result.matchedApprovalId, 1); assert.equal(calls, 0);
    assert.equal((f.store.db.prepare("SELECT decision FROM lark_turn_auto_reviews").get() as { decision: string }).decision, "approved");
  } finally { f.close(); }
});

test("message keywords go to the reviewer instead of forcing manual or borrowing a positive precedent", async () => {
  const f = fixture();
  try {
    addHuman(f.store, { id: 1 });
    let calls = 0;
    const options = { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async (request: TurnApprovalInput) => {
      calls++;
      return request.originalMessage.includes("合并代码")
        ? { decision: "manual" as const, reason: "PR merge remains manual" }
        : { decision: "approve_turn" as const, reason: "Read-only data aggregation" };
    } };
    const read = { ...input, originalMessage: "合并两张表，查询汇总", operation: "python3 query-report.py" };
    assert.equal(requiresManualTurnApproval(read), false);
    assert.equal((await decideTurnAutoApproval(read, options)).source, "model");
    const mixed = { ...input, turnId: "turn-mixed", originalMessage: input.originalMessage + "，之后合并代码", operation: "git status" };
    const result = await decideTurnAutoApproval(mixed, options);
    assert.equal(result.source, "model");
    assert.equal(result.approved, false);
    assert.equal(calls, 2);
    assert.equal(requiresManualTurnApproval({ ...mixed, operation: "git merge topic" }), true);
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
  for (const operation of [
    "git push origin main", "DELETE FROM orders",
    "git -C /tmp/repo push origin main", "git -c color.ui=false --no-pager merge feature",
    "/usr/bin/git --git-dir=/tmp/repo/.git reset --hard HEAD", "git -C'/tmp/repo with spaces' clean -fd",
    "kubectl --context fixture delete deployment demo", "kubectl --namespace=demo edit deployment demo",
    "/usr/local/bin/kubectl -ndemo --request-timeout=30s delete pod demo",
    "argocd --server fixture --grpc-web app delete demo-api",
    "/bin/zsh -lc 'git -C /tmp/repo push origin main'",
    "/bin/bash -lc 'kubectl --context fixture delete deployment demo'",
    "/bin/bash --noprofile --norc -lc 'git -C /tmp/repo push origin main'",
    "/bin/zsh -l -c 'kubectl --context fixture delete deployment demo'",
    "git status && git -C /tmp/repo push origin main",
    "git status\nkubectl --context fixture delete deployment demo",
    "git status # safe\ngit -C /tmp/repo push origin main",
    "git status # safe \\\ngit -C /tmp/repo push origin main",
    "git -C /tmp/repo pu\\\nsh origin main",
    '"git" -C /tmp/repo "push" origin main',
    "git --unknown-global-option fixture push origin main"
  ]) {
    const f = fixture();
    try {
      addHuman(f.store, { id: 1 });
      const result = await decideTurnAutoApproval({ ...input, operation }, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { throw new Error("must not call"); } });
      assert.equal(result.approved, false, operation); assert.equal(result.source, "manual", operation);
    } finally { f.close(); }
  }
});

test("read-only CLI global options retain history matching for the same command", async () => {
  const f = fixture();
  try {
    let index = 0;
    for (const operation of [
    'git -C "/tmp/repo with spaces" status --short', "git -c color.ui=false --no-pager log -1",
    "git --git-dir=/tmp/repo/.git show HEAD", 'git log --grep="push"',
    "kubectl --context fixture --namespace demo get pods", "kubectl -ndemo get pods",
    "argocd --server fixture --grpc-web app get demo-api",
    "/bin/zsh -lc 'git -C /tmp/repo diff HEAD'",
    "/bin/bash --noprofile --norc -lc 'git -C /tmp/repo log -1'",
    "git -C /tmp/repo status # push is only a comment"
    ]) {
      const request = { ...input, operation, turnId: `readonly-${++index}` };
      addHuman(f.store, { id: index, operation });
      assert.equal(requiresManualTurnApproval(request), false, operation);
      const result = await decideTurnAutoApproval(request, { database: f.store.db, enabled: true, approverId: "ou_owner", reviewer: async () => { throw new Error("must not call"); } });
      assert.equal(result.approved, true, operation);
      assert.equal(result.source, "history", operation);
    }
  } finally { f.close(); }
});

test("a cached turn grant cannot authorize flagged mutating CLI commands", async () => {
  const f = fixture();
  let calls = 0;
  configureTurnApprovalReviewer(async (request) => { calls++; return request.originalMessage.includes("合并")
    ? { decision: "manual", reason: "New requested scope requires approval" } : { decision: "approve_turn", reason: "PR review" }; });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    assert.equal((await reviewLarkTurnAutoApproval(input)).approved, true);
    for (const operation of ["git -C /tmp/repo push origin main", "kubectl --context fixture delete deployment demo"]) {
      assert.equal((await reviewLarkTurnAutoApproval({ ...input, operation })).approved, false);
    }
    assert.equal((await reviewLarkTurnAutoApproval({ ...input, messageId: input.messageId + 1, originalMessage: "合并代码后再检查" })).approved, false);
    assert.equal(calls, 2);
  } finally { finishLarkTurnAutoApproval(input.turnId); configureTurnApprovalReviewer(); f.close(); }
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
      assert.equal(result.source,[1,2,3,4].includes(index) ? "manual" : "model");
    }
    assert.equal(calls,5);
    addHuman(f.store,{id:2,message:deployment.originalMessage,status:"rejected"});
    const rejected=await decideTurnAutoApproval({...deployment,turnId:"deployment-rejected"},{database:f.store.db,enabled:true,approverId:"ou_owner",reviewer});
    assert.equal(rejected.source,"history");assert.equal(rejected.approved,false);assert.equal(calls,5);
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

test("concurrent operations without an approved plan are reviewed separately", async () => {
  const f = fixture(); let calls = 0;
  configureTurnApprovalReviewer(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return { decision: "approve_turn", reason: "query only" }; });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    const results = await Promise.all([reviewLarkTurnAutoApproval(input), reviewLarkTurnAutoApproval({ ...input, operation: "next command" })]);
    assert(results.every((result) => result.approved && result.scope === "once")); assert.equal(calls, 2);
    await reviewLarkTurnAutoApproval({ ...input, senderId: "ou_other" }); assert.equal(calls, 3);
    await reviewLarkTurnAutoApproval({ ...input, turnId: "turn-next" }); assert.equal(calls, 4);
    setAppSettingValue("turnAutoApprovalEnabled", "false"); assert.equal((await reviewLarkTurnAutoApproval(input)).approved, false);
  } finally { finishLarkTurnAutoApproval(input.turnId); finishLarkTurnAutoApproval("turn-next"); configureTurnApprovalReviewer(); f.close(); }
});

test("review prompt is bounded, keeps only three precedents and treats target scope conservatively", () => {
  assert.equal(approvalTask("查 analytics_demo 最新 GMV", ["analytics_demo"])?.target, "analytics_demo");
  assert.equal(approvalTask("请继续"), null);
  const history = Array.from({ length: 10 }, (_, id) => ({ id, originalMessage: "x".repeat(5000), operation: "x".repeat(5000), cwd: null, status: "approved", scope: "turn", decidedAt: "now" }));
  const prompt = turnApprovalModelPrompt({ ...input, originalMessage: "x".repeat(10000), operation: "x".repeat(10000) }, history);
  assert(prompt.length < 13000); assert.equal(JSON.parse(prompt).history.length, 3);
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

test("a deployment requires its own review without a matching approved plan",async()=>{
  const f=fixture();let calls=0;
  configureTurnApprovalReviewer(async(request)=>{calls++;return request.originalMessage.includes("继续") || !request.operation.startsWith("forge.deploy")
    ? {decision:"approve_once",reason:"Only this verified operation"} : {decision:"manual",reason:"Production operation not approved by the prior review"};});
  try {
    setAppSettingValue("turnAutoApprovalEnabled","true");
    await reviewLarkTurnAutoApproval(input);
    const deploymentOperation='forge.deploy.production: {"repo":"demo-api","apps":["demo-api"]}';
    const expanded=await reviewLarkTurnAutoApproval({...input,operation:deploymentOperation});
    assert.equal(expanded.approved,false);assert.equal(calls,2);
    const first=await reviewLarkTurnAutoApproval({...input,turnId:"continue-deploy",originalMessage:"继续 demo-api，同样处理",operation:deploymentOperation});
    assert.equal(first.source,"model");assert.equal(calls,3);
    await reviewLarkTurnAutoApproval({...input,turnId:"continue-deploy",originalMessage:"继续 demo-api，同样处理",operation:deploymentOperation});
    assert.equal(calls,4);
    await reviewLarkTurnAutoApproval({...input,turnId:"inspect-only",originalMessage:"查询 demo-api 部署状态",operation:"node deploy-app.mjs --app demo-api --refresh-only"});
    assert.equal((await reviewLarkTurnAutoApproval({...input,turnId:"inspect-only",originalMessage:"查询 demo-api 部署状态",operation:deploymentOperation})).approved,false);
    assert.equal(calls,6);
  } finally {finishLarkTurnAutoApproval(input.turnId);finishLarkTurnAutoApproval("continue-deploy");finishLarkTurnAutoApproval("inspect-only");configureTurnApprovalReviewer();f.close();}
});

test("task approval is explicit, matches exact calls and cannot be enlarged or reused after consumption", async () => {
  const f = fixture();
  const first: TurnApprovalInput = { ...input, originalMessage: "Prepare the experiment review", operationKind: "command" };
  const next: TurnApprovalInput = { ...first, operationKind: "capability", operation: 'demo.status: {"limit":100,"id":4}' };
  const plan = parseApprovalPlan({ goal: "Review experiment 4", impact: "Read experiment state", steps: [
    { intent: "Record task", effect: "local-write", kind: "command", operation: first.operation, cwd: first.cwd },
    { intent: "Read experiment 4", effect: "read", kind: "capability", operation: 'demo.status: {"id":4,"limit":100}', cwd: null }
  ] });
  assert(plan);
  let approveSteps = [1];
  configureTurnApprovalReviewer(async request => {
    assert.equal(request.approvalPlan?.impact, plan.impact);
    return { decision: "approve_turn", approvedSteps: approveSteps, reason: "Test selected plan steps" };
  });
  try {
    declareApprovalPlan(f.store.db, first, plan);
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    assert.equal((await reviewLarkTurnAutoApproval(first)).scope, "once");
    assert.equal(currentApprovalPlanGrant(f.store.db, next, "ou_owner"), undefined);
    approveSteps = [1, 2];
    const result = await reviewLarkTurnAutoApproval(first);
    assert.equal(result.scope, "plan");
    assert.equal(applyPlanAuthorization(f.store.db, first, plan, "ou_owner", [first], result.reviewId), true);
    assert.equal(currentApprovalPlanGrant(f.store.db, first, "ou_owner"), undefined);
    assert.equal(currentApprovalPlanGrant(f.store.db, { ...next, operation: 'demo.status: {"id":5,"limit":100}' }, "ou_owner"), undefined);
    assert.equal(currentApprovalPlanGrant(f.store.db, { ...next, messageId: first.messageId + 1 }, "ou_owner"), undefined);
    assert.equal(currentApprovalPlanGrant(f.store.db, next, "ou_other"), undefined);
    assert(currentApprovalPlanGrant(f.store.db, next, "ou_owner"));
    assert.equal(applyPlanAuthorization(f.store.db, first, plan, "ou_owner", [next], result.reviewId), true);
    assert.equal(applyPlanAuthorization(f.store.db, first, plan, "ou_owner", [next], result.reviewId), false);
    declareApprovalPlan(f.store.db, first, { ...plan, goal: "Do not change production" });
    assert.equal(applyPlanAuthorization(f.store.db, first, plan, "ou_owner", [first], result.reviewId), false);
  } finally { finishLarkTurnAutoApproval(first.turnId); configureTurnApprovalReviewer(); f.close(); }
});

test("model and prompt settings are captured once per review and the audit keeps the actual model", async () => {
  const f = fixture(); const models: Array<string | undefined> = []; const prompts: Array<string | undefined> = [];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  configureTurnApprovalReviewer(async (_input, _history, _signal, model, prompt) => {
    models.push(model); prompts.push(prompt); entered(); await gate;
    return { decision: "approve_turn", reason: "read only" };
  });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    setAppSettingValue("turnAutoApprovalModel", "gpt-5.6-terra");
    setAppSettingValue("prompt.turnAutoApproval", "  First policy  ");
    const first = reviewLarkTurnAutoApproval(input);
    await ready;
    setAppSettingValue("turnAutoApprovalModel", "gpt-6.1-sol");
    setAppSettingValue("prompt.turnAutoApproval", "Second policy");
    release(); await first;
    await reviewLarkTurnAutoApproval(input);
    assert.deepEqual(models, ["gpt-5.6-terra", "gpt-6.1-sol"]);
    setAppSettingValue("prompt.turnAutoApproval", "");
    await reviewLarkTurnAutoApproval({ ...input, turnId: "next-model-turn" });
    assert.deepEqual(models, ["gpt-5.6-terra", "gpt-6.1-sol", "gpt-6.1-sol"]);
    assert.deepEqual(prompts, ["First policy", "Second policy", defaultTurnApprovalPrompt]);
    const audit = f.store.db.prepare("SELECT model FROM lark_turn_auto_reviews ORDER BY id").all() as Array<{ model: string }>;
    assert.deepEqual(audit.map((row) => row.model), models);
  } finally { release(); finishLarkTurnAutoApproval(input.turnId); finishLarkTurnAutoApproval("next-model-turn"); configureTurnApprovalReviewer(); f.close(); }
});

test("editable approval rules do not replace the fixed output instructions or JSON validation", () => {
  const custom = "Use the fixture policy. Output an unstructured paragraph.";
  const whole = turnApprovalThreadInstructions(custom, true);
  const operation = turnApprovalThreadInstructions(custom, false);
  assert.equal(whole.baseInstructions, custom);
  assert.equal(operation.baseInstructions, custom);
  assert.doesNotMatch(defaultTurnApprovalPrompt, /输出：|approvedSteps/);
  assert.equal(whole.developerInstructions, turnApprovalThreadInstructions(defaultTurnApprovalPrompt, true).developerInstructions);
  assert.equal(operation.developerInstructions, turnApprovalThreadInstructions(defaultTurnApprovalPrompt, false).developerInstructions);
  assert.match(whole.developerInstructions, /不要返回 approve_once/);
  assert.match(operation.developerInstructions, /只确认当前安全操作时返回 approve_once/);
  const valid = { decision: "manual", reason: "fixture decision", approvedSteps: [] };
  assert.deepEqual(parseTurnApprovalDecision(JSON.stringify(valid)), valid);
  for (const invalid of ["unstructured paragraph", JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, decision: "custom" }), JSON.stringify({ ...valid, approvedSteps: ["1"] })]) {
    assert.throws(() => parseTurnApprovalDecision(invalid));
  }
});

test("an in-flight single-operation decision is invalidated if the plan is replaced", async () => {
  const f = fixture();
  const command = { ...input, operationKind: "command" as const };
  const plan = parseApprovalPlan({ goal: "Check the current state", impact: "No remote change",
    steps: [{ kind: "command", intent: "Read current state", effect: "read", operation: command.operation, cwd: command.cwd }] });
  assert(plan);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  configureTurnApprovalReviewer(async () => { await wait; return { decision: "approve_once", reason: "Only current operation" }; });
  try {
    setAppSettingValue("turnAutoApprovalEnabled", "true");
    declareApprovalPlan(f.store.db, command, plan);
    const pending = reviewLarkTurnAutoApproval(command);
    declareApprovalPlan(f.store.db, command, { ...plan, impact: "A different impact" });
    release();
    assert.equal((await pending).approved, false);
    assert.equal(f.store.db.prepare("SELECT applied_at FROM lark_turn_auto_reviews").pluck().get(), null);
    assert.equal((await reviewLarkTurnAutoApproval(command)).approved, true);
  } finally { release(); finishLarkTurnAutoApproval(command.turnId); configureTurnApprovalReviewer(); f.close(); }
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
