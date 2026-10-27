import type Database from "better-sqlite3";
import path from "node:path";
import { config, appSettingValue, db, nowIso, validLarkCodexModel } from "./context.js";
import { reviewTurnWithCodex } from "./turnApprovalReviewer.js";
import { queueTurnAutoApprovalNotification } from "./turnApprovalNotifications.js";
import { requiresManualCliApproval } from "./approvalCommands.js";
import { loadApprovalTaskContext, type ApprovalTaskContext } from "./approvalTaskContext.js";

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
  messageId: number; turnId: string; senderId: string | null;
  originalMessage: string; operation: string; cwd: string | null;
  taskContext?: ApprovalTaskContext;
};
export type ApprovalPrecedent = {
  id: number; originalMessage: string; operation: string; cwd: string | null;
  status: string; scope: string; decidedAt: string;
};
export type ModelApprovalDecision = {
  decision: "approve_turn" | "manual"; reason: string;
  usage?: Record<string, unknown>;
};
export type TurnApprovalReviewer = (input: TurnApprovalInput, history: ApprovalPrecedent[], signal: AbortSignal, model?: string) => Promise<ModelApprovalDecision>;
export type TurnApprovalDecision = {
  approved: boolean; source: "history" | "model" | "manual" | "disabled";
  reason: string; matchedApprovalId?: number; reviewId?: number;
};

type ReviewEntry = { controller: AbortController; result: Promise<TurnApprovalDecision>; deploymentIntent: boolean; deploymentTargets: string[] };
const reviews = new WeakMap<Database.Database, Map<string, ReviewEntry>>();
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
  return /回滚|合并|删库|删除数据|修改数据库|改代码|修复代码|\b(?:rollback|merge)\b/i.test(input.originalMessage)
    || requiresManualCliApproval(input.operation)
    || /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|truncate\s+table)\b/i.test(input.operation);
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

function isDeploymentExecution(operation: string): boolean {
  return /forge\.deploy\.production:|deploy-app\.[cm]?js[^\n]*--execute|\bargocd(?:\s+--[a-z_-]+)*\s+app\s+sync\b|\bkubectl\s+(?:apply|patch)\b/i.test(operation);
}

export function canReuseLarkTurnAutoApproval(input: TurnApprovalInput): boolean {
  const key=JSON.stringify([input.turnId,input.senderId,config.larkExecutionApproverId]);
  const existing=reviews.get(db)?.get(key);
  if (!existing || requiresManualTurnApproval(input)) return false;
  if (!isDeploymentExecution(input.operation)) return true;
  const targets=deploymentOperationTargets(input.operation);
  return existing.deploymentIntent && Boolean(targets?.length)
    && targets!.every(target=>existing.deploymentTargets.includes(target));
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
  let modelAttempted = false;
  const finish = (result: TurnApprovalDecision, usage?: Record<string, unknown>): TurnApprovalDecision => {
    if (!database.open) return { ...result, approved: false };
    database.prepare(`UPDATE lark_turn_auto_reviews SET source=?,decision=?,reason=?,matched_approval_id=?,model=?,usage_json=?,completed_at=? WHERE id=?`)
      .run(result.source, result.approved ? "approved" : "manual", result.reason, result.matchedApprovalId ?? null,
        modelAttempted ? model : null, usage ? JSON.stringify(usage) : null, nowIso(), reviewId);
    return { ...result, reviewId };
  };
  if (requiresManualTurnApproval(input)) return finish({ approved: false, source: "manual", reason: "当前任务需要人工授权" });
  const history = humanApprovalHistory(database, input.senderId, approverId);
  const match = matchHumanTurnApproval(input, history, dataSources);
  if (match) return finish({ approved: match.status === "approved" && match.scope === "turn", source: "history",
    matchedApprovalId: match.id, reason: match.status === "rejected" ? "最近同类人工审批已拒绝" : match.scope !== "turn" ? "历史授权仅允许单次操作" : "匹配同一发送人、任务类型、目标及工作目录的人工 turn 授权" });
  try {
    modelAttempted = true;
    const judged = await (options.reviewer ?? reviewTurnWithCodex)(input, history.slice(0, 3), options.signal ?? new AbortController().signal, model);
    if (options.signal?.aborted) return finish({ approved: false, source: "manual", reason: "自动审核已取消" });
    if (!["approve_turn", "manual"].includes(judged.decision) || typeof judged.reason !== "string" || !judged.reason.trim()) throw new Error("Invalid approval reviewer result");
    return finish({ approved: judged.decision === "approve_turn", source: "model", reason: judged.reason.slice(0, 300) }, judged.usage);
  } catch (error) {
    return finish({ approved: false, source: "manual", reason: `自动审核失败，转人工：${(error instanceof Error ? error.message : String(error)).slice(0, 180)}` });
  }
}

export function reviewLarkTurnAutoApproval(input: TurnApprovalInput): Promise<TurnApprovalDecision> {
  if (!turnAutoApprovalEnabled()) return Promise.resolve({ approved: false, source: "disabled", reason: "自动审批未启用" });
  input = { ...input, taskContext: loadApprovalTaskContext(db, input.messageId, input.senderId) };
  let current = reviews.get(db);
  if (!current) { current = new Map(); reviews.set(db, current); }
  const key = JSON.stringify([input.turnId, input.senderId, config.larkExecutionApproverId]);
  const existing = current.get(key);
  const deploymentExecution = isDeploymentExecution(input.operation);
  if (existing) {
    if (!canReuseLarkTurnAutoApproval(input)) return Promise.resolve({approved:false,source:"manual",reason:"当前 turn 授权不包含该操作或部署目标"});
    return existing.result;
  }
  const controller = new AbortController();
  const result = decideTurnAutoApproval(input, { database: db, enabled: true, approverId: config.larkExecutionApproverId, reviewer, signal: controller.signal });
  const task=approvalTask(input.originalMessage);
  const inspectionIntent=/查询|检查|排查|是否|状态|\b(?:inspect|check|status)\b/i.test(input.originalMessage);
  const explicitDeploymentIntent=/(?:^|[，,。;；]|然后|并且|再)(?:\s*(?:请|帮我|开始|继续|please|can you))?\s*(?:部署|上线|发布|deploy\b|sync\b)/i.test(input.originalMessage);
  const deploymentIntent=task?.type === "deployment" || (!task && (!inspectionIntent || explicitDeploymentIntent)
    && (deploymentExecution || /部署|上线|发布|\b(?:deploy|sync)\b/i.test(input.originalMessage)));
  const deploymentTargets=task?.type === "deployment" || task?.type === "deployment_query"
    ? (JSON.parse(task.target) as {services:string[]}).services : deploymentOperationTargets(input.operation) ?? [];
  current.set(key, { controller, result, deploymentIntent, deploymentTargets });
  return result;
}

export function finishLarkTurnAutoApproval(turnId: string): void {
  const current = reviews.get(db);
  if (!current) return;
  for (const [key, entry] of current) if (JSON.parse(key)[0] === turnId) { entry.controller.abort(); current.delete(key); }
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
  for (const entry of current.values()) entry.controller.abort();
  current.clear();
}
