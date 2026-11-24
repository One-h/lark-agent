import type Database from "better-sqlite3";
import path from "node:path";
import { config, appSettingValue, db, nowIso, validLarkCodexModel } from "./context.js";
import { reviewTurnWithCodex } from "./turnApprovalReviewer.js";
import { queueTurnAutoApprovalNotification } from "./turnApprovalNotifications.js";
import { requiresManualCliApproval } from "./approvalCommands.js";
import { loadApprovalDirectQuote, loadApprovalTaskContext, type ApprovalTaskContext } from "./approvalTaskContext.js";
import { approvalPlanSummary, clearApprovalPlan, currentApprovalPlan, currentApprovalPlanGrant, maxReviewedOperationChars,
  operationIsDeclaredRemoteWrite, planCoversOperation, type ApprovalOperationKind, type ApprovalPlan } from "./approvalPlan.js";
import { redactReplyValues } from "./replySanitization.js";
import { boundedReadApprovalPlan, hasWholeTurnReadScope } from "./wholeTurnScope.js";

export const defaultTurnAutoApprovalModel = "gpt-6.1-sol";
export const turnAutoApprovalModel = defaultTurnAutoApprovalModel;
export function configuredTurnAutoApprovalModel(database: Database.Database | undefined = db): string {
  const stored = (database?.prepare("SELECT value FROM settings WHERE key='turnAutoApprovalModel'").get() as { value?: string } | undefined)?.value?.trim();
  return stored && validLarkCodexModel(stored) ? stored : defaultTurnAutoApprovalModel;
}

export function configuredTurnAutoApprovalDataSources(database: Database.Database | undefined = db): string[] {
  const stored = (database?.prepare("SELECT value FROM settings WHERE key='turnAutoApprovalDataSources'").get() as { value?: string } | undefined)?.value;
  try {
    const sources: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(sources) && sources.length <= 100
      && sources.every(source => typeof source === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(source))
      ? [...new Set(sources.map(source => source.toLowerCase()))] : [];
  } catch { return []; }
}
export type ApprovalTask = { type: "pr_review" | "data_query" | "deployment" | "deployment_query"; target: string };
export type TurnApprovalInput = {
  retainedRequestId?: string;
  messageId: number; turnId: string; senderId: string | null;
  originalMessage: string; operation: string; cwd: string | null;
  operationIntent?: string | null;
  operationKind?: ApprovalOperationKind;
  approvalPlan?: ApprovalPlan;
  directQuote?: string;
  taskContext?: ApprovalTaskContext;
  wholeTask?: boolean;
  readOnlyWholeTask?: boolean;
};
export type ApprovalPrecedent = {
  id: number; originalMessage: string; operation: string; cwd: string | null;
  status: string; scope: string; decidedAt: string;
};
export type ModelApprovalDecision = {
  decision: "approve_turn" | "approve_once" | "manual"; reason: string;
  approvedSteps?: number[];
  usage?: Record<string, unknown>;
};
export type TurnApprovalReviewer = (input: TurnApprovalInput, history: ApprovalPrecedent[], signal: AbortSignal, model?: string) => Promise<ModelApprovalDecision>;
export type TurnApprovalDecision = {
  approved: boolean; source: "history" | "model" | "manual" | "disabled";
  reason: string; matchedApprovalId?: number; reviewId?: number;
  scope?: "once" | "plan" | "turn";
  plan?: ApprovalPlan;
  reviewedPlan?: ApprovalPlan;
  recheckedInput?: { messageId: number; requestId: string | number };
};

type RefreshApprovalInput = () => (TurnApprovalInput & { requestId: string | number }) | undefined;
const reviews = new WeakMap<Database.Database, Map<AbortController, string>>();
let reviewer: TurnApprovalReviewer = reviewTurnWithCodex;

export function configureTurnApprovalReviewer(value?: TurnApprovalReviewer): void {
  reviewer = value ?? reviewTurnWithCodex;
}

export function turnAutoApprovalEnabled(): boolean {
  return Boolean(db && appSettingValue("turnAutoApprovalEnabled") === "true");
}

function normalizedCwd(cwd: string | null): string | null {
  return cwd ? path.resolve(cwd) : null;
}

export function approvalTask(message: string, dataSources: readonly string[] = []): ApprovalTask | null {
  // Targets come from the user's request, not a model-proposed command.
  const deployment = /部署|上线|发布|\b(?:deploy|sync)\b|同步/i.test(message);
  const inspection = /排查|查询|检查|状态|是否|\b(?:inspect|status|check)\b/i.test(message);
  // Mixed inspection/deployment wording goes to the model rather than reusing a read-only precedent.
  if (inspection && /部署|上线|发布|\b(?:deploy|sync)\b/i.test(message)) return null;
  if (deployment || (inspection && /服务|镜像|schema|application/i.test(message))) {
    if (/不要|除外|不含|除了|excluding/i.test(message)) return null;
    const services = [...new Set([...message.matchAll(/\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/gi)]
      .map(match => match[0].toLowerCase()).filter(value => !["refresh-only", "read-only", "dry-run", "pre-prod", "pre-production"].includes(value)))].sort();
    if (!services.length) return null;
    const environments = [
      [/预发|\b(?:staging|preprod|pre-prod|pre-production)\b/i,"staging"],
      [/生产|线上|\b(?:prod|production)\b/i,"production"],
      [/测试|\btest\b/i,"test"],[/开发|\bdev\b/i,"dev"]
    ] as const;
    const matchedEnvironments=environments.filter(([pattern])=>pattern.test(message)).map(([,value])=>value);
    if (matchedEnvironments.length>1) return null;
    const environment = matchedEnvironments[0] ?? "default";
    return { type: inspection ? "deployment_query" : "deployment", target: JSON.stringify({ services, environment }) };
  }
  if (/review|rereview|评审|复审|审查|审核/i.test(message)) {
    const targets: string[] = [];
    for (const match of message.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      try {
        const url = new URL(match[0]);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 4 && parts[2] === "pulls" && /^\d+$/.test(parts[3])) targets.push(`${url.origin}/${parts[0]}/${parts[1]}`);
      } catch { /* A malformed URL cannot define an approval scope. */ }
    }
    if (targets.length) return { type: "pr_review", target: [...new Set(targets)].sort().join(",") };
  }
  if (/查询|数据|报表|gmv|出单率|销量|sql|数据库|捞取/i.test(message)) {
    const targets = [...new Set(dataSources.filter(source => {
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`, "i").test(message);
    }).map(source => source.toLowerCase()))];
    if (targets.length === 1) return { type: "data_query", target: targets[0] };
  }
  return null;
}

export function requiresManualTurnApproval(input: TurnApprovalInput): boolean {
  return requiresManualCliApproval(input.operation)
    || /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|truncate\s+table)\b/i.test(input.operation);
}

function requiresModelScopeReview(message: string): boolean {
  // Text can require a fresh judgment, but does not itself make an operation manual-only.
  return /回滚|合并|删库|删除数据|修改数据库|改代码|修复代码|\b(?:rollback|merge)\b/i.test(message);
}

export function humanApprovalHistory(database: Database.Database, senderId: string, approverId: string): ApprovalPrecedent[] {
  return (database.prepare(`
    SELECT a.id, m.content AS originalMessage, a.operation, a.cwd, a.status,
           a.approval_scope AS scope, a.decided_at AS decidedAt
    FROM lark_execution_approvals a JOIN lark_messages m ON m.id=a.lark_message_id
    WHERE a.requester_id=? AND a.approver_id=? AND m.sender_id=a.requester_id AND a.card_message_id IS NOT NULL
      AND a.decided_at IS NOT NULL AND a.status IN ('approved','rejected')
    ORDER BY a.decided_at DESC, a.id DESC LIMIT 500
  `).all(senderId, approverId) as ApprovalPrecedent[]).map((row) => ({ ...row, originalMessage: row.originalMessage ?? "", operation: row.operation ?? "" }));
}

function deploymentOperationTargets(operation: string): string[] | null {
  const operationTargets = [...operation.matchAll(/--(?:repo|app|apps)(?:=|\s+)["']?([a-z0-9_/,.-]+)/gi)]
    .flatMap(match => match[1].split(",").map(value => value.split("/").at(-1)!.toLowerCase()));
  for (const match of operation.matchAll(/\bargocd(?:\s+--[a-z_-]+)*\s+app\s+(?:sync|get|wait)\s+([a-z0-9_-]+)/gi)) operationTargets.push(match[1].toLowerCase());
  if (operation.startsWith("forge.deploy.production:")) {
    try {
      const input=JSON.parse(operation.slice(operation.indexOf(":")+1)) as {repo?:unknown;apps?:unknown};
      if (typeof input.repo!=="string" || (!Array.isArray(input.apps) && typeof input.apps!=="string")) return null;
      const apps=Array.isArray(input.apps)?input.apps:input.apps.split(",");
      if (!apps.length || apps.some(app=>typeof app!=="string")) return null;
      operationTargets.push(...[input.repo,...apps].map(value=>String(value).split("/").at(-1)!.toLowerCase()));
    } catch {return null;}
  }
  return operationTargets;
}

export function deploymentOperationMatchesTask(task: ApprovalTask | null, operation: string): boolean {
  if (!task || !["deployment","deployment_query"].includes(task.type)) return true;
  const services = (JSON.parse(task.target) as { services: string[] }).services;
  const operationTargets=deploymentOperationTargets(operation);
  if (!operationTargets?.length) return false;
  if (operationTargets.some(target => !services.includes(target))) return false;
  return task.type !== "deployment_query" || !/--execute|\bargocd\s+app\s+sync\b|forge\.deploy\.production/i.test(operation);
}

function deploymentWrite(operation: string): boolean {
  return /forge\.deploy\.production:|deploy-app\.[cm]?js[^\n]*--execute|\bargocd(?:\s+--[a-z_-]+)*\s+app\s+sync\b|\bkubectl\s+(?:apply|patch)\b/i.test(operation);
}

function outsideAutomaticOperationScope(input: TurnApprovalInput, task: ApprovalTask | null): boolean {
  const isDeployment = deploymentWrite(input.operation);
  return requiresManualTurnApproval(input) || input.operation.length > maxReviewedOperationChars
    || (isDeployment && task !== null && !deploymentOperationMatchesTask(task, input.operation))
    || (operationIsDeclaredRemoteWrite(input.approvalPlan, input)
      && !(isDeployment && task?.type === "deployment" && deploymentOperationMatchesTask(task, input.operation)));
}

export function matchHumanTurnApproval(input: TurnApprovalInput, history: ApprovalPrecedent[], dataSources: readonly string[] = []): ApprovalPrecedent | null {
  const task = approvalTask(input.originalMessage, dataSources);
  if (!task || !input.cwd) return null;
  if (task.type === "deployment" || task.type === "deployment_query") {
    if (!deploymentOperationMatchesTask(task,input.operation)) return null;
  }
  const match=history.find((entry) => {
    const previous = approvalTask(entry.originalMessage, dataSources);
    return previous?.type === task.type && previous.target === task.target
      && normalizedCwd(entry.cwd) === normalizedCwd(input.cwd);
  }) ?? null;
  if (match?.status === "approved" && match.scope === "turn" && ["deployment","deployment_query"].includes(task.type)
    && !deploymentOperationMatchesTask(approvalTask(match.originalMessage, dataSources),match.operation)) return null;
  return match;
}

export async function decideTurnAutoApproval(input: TurnApprovalInput, options: {
  database: Database.Database; enabled: boolean; approverId: string;
  reviewer?: TurnApprovalReviewer; signal?: AbortSignal;
  refreshInput?: RefreshApprovalInput;
}): Promise<TurnApprovalDecision> {
  const { database, enabled, approverId } = options;
  const model = configuredTurnAutoApprovalModel(database);
  if (!enabled || !approverId || !input.senderId) return { approved: false, source: "disabled", reason: "自动审批未启用或缺少审批身份" };
  const dataSources = configuredTurnAutoApprovalDataSources(database);
  const task = approvalTask(input.originalMessage, dataSources);
  const inserted = database.prepare(`INSERT INTO lark_turn_auto_reviews
    (lark_message_id,turn_id,requester_id,approver_id,task_type,target,cwd,source,decision,reason,created_at)
    VALUES (?,?,?,?,?,?,?,'model','reviewing','',?)`)
    .run(input.messageId, input.turnId, input.senderId, approverId, task?.type ?? null, task?.target ?? null, input.cwd, nowIso());
  const reviewId = Number(inserted.lastInsertRowid);
  let reviewedInput = input;
  let reviewedTask = task;
  let recheckedInput: TurnApprovalDecision["recheckedInput"];
  let modelAttempted = false;
  const finish = (result: TurnApprovalDecision, usage?: Record<string, unknown>): TurnApprovalDecision => {
    if (!database.open) return { ...result, approved: false };
    database.prepare(`UPDATE lark_turn_auto_reviews SET source=?,decision=?,reason=?,matched_approval_id=?,model=?,usage_json=?,completed_at=?,
      lark_message_id=?,task_type=?,target=?,cwd=?,approval_scope=?,plan_summary=?,operation_intent=?,reviewed_operation=? WHERE id=?`)
      .run(result.source, result.approved ? "approved" : "manual", result.reason, result.matchedApprovalId ?? null,
        modelAttempted ? model : null, usage ? JSON.stringify(usage) : null, nowIso(), reviewedInput.messageId,
        reviewedTask?.type ?? null, reviewedTask?.target ?? null, reviewedInput.cwd, result.scope ?? "once",
        reviewedInput.approvalPlan ? approvalPlanSummary(reviewedInput.approvalPlan) : null,
        reviewedInput.operationIntent ? redactReplyValues(reviewedInput.operationIntent.slice(0, 240), []) : null,
        redactReplyValues(reviewedInput.operation.slice(0, maxReviewedOperationChars), []), reviewId);
    return { ...result, reviewId, reviewedPlan: reviewedInput.approvalPlan, ...(recheckedInput ? { recheckedInput } : {}) };
  };
  if (outsideAutomaticOperationScope(input, task)) {
    return finish({ approved: false, source: "manual", reason: "当前操作需要人工授权或超出完整审核长度" });
  }
  const history = humanApprovalHistory(database, input.senderId, approverId);
  const match = matchHumanTurnApproval(input, history, dataSources);
  if (!input.wholeTask && match && (match.status !== "approved" || match.scope !== "turn" ||
    (!input.approvalPlan && !requiresModelScopeReview(input.originalMessage) && match.operation === input.operation))) {
    return finish({ approved: match.status === "approved" && match.scope === "turn", source: "history",
    scope: "once", matchedApprovalId: match.id, reason: match.status === "rejected" ? "最近同类人工审批已拒绝" : match.scope !== "turn" ? "历史授权仅允许单次操作" : "匹配同一发送人、目标及工作目录的同一已批准操作" });
  }
  try {
    const judge = async (candidate: TurnApprovalInput) => {
      const judged = await (options.reviewer ?? reviewTurnWithCodex)(candidate, history.slice(0, 3), options.signal ?? new AbortController().signal, model);
      if (!["approve_turn", "approve_once", "manual"].includes(judged.decision) || typeof judged.reason !== "string" || !judged.reason.trim()) throw new Error("Invalid approval reviewer result");
      return judged;
    };
    modelAttempted = true;
    let judged = await judge(input);
    if (!options.signal?.aborted && judged.decision !== "manual") {
      const fresh = options.refreshInput?.();
      if (fresh && fresh.messageId !== input.messageId && fresh.senderId === input.senderId && fresh.turnId === input.turnId) {
        reviewedInput = fresh;
        reviewedTask = approvalTask(fresh.originalMessage, dataSources);
        recheckedInput = { messageId: fresh.messageId, requestId: fresh.requestId };
        if (outsideAutomaticOperationScope(fresh, reviewedTask) || !deploymentOperationMatchesTask(reviewedTask, fresh.operation)) {
          return finish({ approved: false, source: "manual", reason: "追加请求需要人工确认当前操作范围" }, judged.usage);
        }
        judged = await judge(fresh);
        if (!options.signal?.aborted && judged.decision !== "manual" && options.refreshInput?.()?.messageId !== fresh.messageId) {
          return finish({ approved: false, source: "manual", reason: "复审期间任务范围再次变化，需人工确认" }, judged.usage);
        }
      }
    }
    if (options.signal?.aborted) return finish({ approved: false, source: "manual", reason: "自动审核已取消" });
    const plan = reviewedInput.approvalPlan;
    if (reviewedInput.wholeTask) {
      const approveWhole = judged.decision === "approve_turn"
        && (!reviewedInput.readOnlyWholeTask || hasWholeTurnReadScope(reviewedInput));
      const reason = approveWhole || judged.decision === "manual" ? judged.reason
        : judged.decision === "approve_once" ? "审核未确认整轮任务，转人工决定，不单独放行当前操作。"
        : "未能验证本轮限定只读操作，转人工决定。";
      return finish({ approved: Boolean(approveWhole), source: "model", scope: "turn", reason: reason.slice(0, 300) }, judged.usage);
    }
    const approvePlan = judged.decision === "approve_turn" && plan && planCoversOperation(plan, reviewedInput)
      && judged.approvedSteps?.length === plan.steps.length && plan.steps.every((_, i) => judged.approvedSteps!.includes(i + 1))
      && plan.steps.every(step => !outsideAutomaticOperationScope({ ...reviewedInput, operation: step.operation,
        operationKind: step.kind, cwd: step.cwd }, reviewedTask));
    return finish({ approved: judged.decision !== "manual", source: "model", reason: judged.reason.slice(0, 300),
      ...(approvePlan ? { scope: "plan" as const, plan } : { scope: "once" as const }) }, judged.usage);
  } catch (error) {
    return finish({ approved: false, source: "manual", reason: `自动审核失败，转人工：${(error instanceof Error ? error.message : String(error)).slice(0, 180)}` });
  }
}

export function reviewLarkTurnAutoApproval(input: TurnApprovalInput, refreshInput?: RefreshApprovalInput): Promise<TurnApprovalDecision> {
  if (!turnAutoApprovalEnabled()) return Promise.resolve({ approved: false, source: "disabled", reason: "自动审批未启用" });
  const registeredPlan = currentApprovalPlan(db, input);
  const withContext = <T extends TurnApprovalInput>(candidate: T) => {
    const plan = currentApprovalPlan(db, candidate);
    return {
      ...candidate,
      directQuote: loadApprovalDirectQuote(db, candidate.messageId, candidate.senderId),
      taskContext: loadApprovalTaskContext(db, candidate.messageId, candidate.senderId),
      approvalPlan: candidate.readOnlyWholeTask ? boundedReadApprovalPlan(plan) : plan
    };
  };
  input = withContext(input);
  let current = reviews.get(db);
  if (!current) { current = new Map(); reviews.set(db, current); }
  const database = db;
  const grant = !input.wholeTask && currentApprovalPlanGrant(database, input, config.larkExecutionApproverId);
  if (grant && !requiresManualTurnApproval(input)) return Promise.resolve({ approved: true, scope: "plan", plan: grant.plan,
    reviewedPlan: grant.plan, source: "model", reviewId: grant.reviewId, reason: "当前操作在已确认的任务计划内" });
  const controller = new AbortController();
  current.set(controller, input.turnId);
  const result = decideTurnAutoApproval(input, { database, enabled: true, approverId: config.larkExecutionApproverId, reviewer, signal: controller.signal,
    refreshInput: refreshInput && (() => {
      const fresh = refreshInput();
      if (!fresh || fresh.senderId !== input.senderId || fresh.turnId !== input.turnId) return undefined;
      if (!current.has(controller)) return undefined;
      return withContext(fresh);
    }) });
  return result.then(decision => {
    const identity = { ...input, messageId: decision.recheckedInput?.messageId ?? input.messageId };
    if (decision.approved && currentApprovalPlan(database, identity) !== (input.readOnlyWholeTask ? registeredPlan : decision.reviewedPlan)) {
      return { ...decision, approved: false, reason: "审核期间任务计划已变化，不能放行旧申请" };
    }
    return decision;
  }).finally(() => current.delete(controller));
}

export function finishLarkTurnAutoApproval(turnId: string): void {
  clearApprovalPlan(db, turnId);
  const current = reviews.get(db);
  if (!current) return;
  for (const [controller, id] of current) if (id === turnId) { controller.abort(); current.delete(controller); }
}

export function markTurnAutoApprovalApplied(reviewId: number): void {
  db.transaction(() => {
    db.prepare("UPDATE lark_turn_auto_reviews SET applied_at=COALESCE(applied_at,?) WHERE id=? AND decision='approved'").run(nowIso(), reviewId);
    queueTurnAutoApprovalNotification(reviewId);
  })();
}

export function stopLarkTurnAutoApprovalReviews(): void {
  const current = reviews.get(db);
  if (!current) return;
  for (const controller of current.keys()) controller.abort();
  current.clear();
}
