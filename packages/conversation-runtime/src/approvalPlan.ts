import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { redactReplyValues } from "./replySanitization.js";

export const approvalPlanToolName = "lark_approval_plan";
export const maxReviewedOperationChars = 8_000;
export type ApprovalOperationKind = "command" | "capability";
export type ApprovalPlanStep = {
  intent: string;
  effect: "read" | "local-write" | "remote-write";
  kind: ApprovalOperationKind;
  operation: string;
  cwd: string | null;
};
export type ApprovalPlan = { goal: string; impact: string; steps: ApprovalPlanStep[] };
export type ApprovalPlanIdentity = { turnId: string; messageId: number; senderId: string | null };
type PlannedOperation = { operation: string; cwd: string | null; operationKind?: ApprovalOperationKind };
export type ApprovalPlanGrant = { plan: ApprovalPlan; approverId: string; reviewId?: number; remaining: Map<string, number> };
type PlanState = { owner: ApprovalPlanIdentity; plan: ApprovalPlan; grant?: ApprovalPlanGrant };
const plans = new WeakMap<Database.Database, Map<string, PlanState>>();

export const approvalPlanTool = {
  type: "function",
  name: approvalPlanToolName,
  description: "Declare the entire requested task, expected effects and exact restricted operations for Lark approval. Declaration does not grant permission.",
  deferLoading: false,
  inputSchema: {
    type: "object", additionalProperties: false, required: ["goal", "impact", "steps"],
    properties: {
      goal: { type: "string", maxLength: 220 },
      impact: { type: "string", maxLength: 240 },
      steps: { type: "array", minItems: 1, maxItems: 6, items: {
        type: "object", additionalProperties: false, required: ["intent", "effect", "kind", "operation", "cwd"],
        properties: {
          intent: { type: "string", maxLength: 150 },
          effect: { type: "string", enum: ["read", "local-write", "remote-write"] },
          kind: { type: "string", enum: ["command", "capability"] },
          operation: { type: "string", maxLength: maxReviewedOperationChars },
          cwd: { type: ["string", "null"] }
        }
      } }
    }
  }
};

function clean(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length > limit || !value.trim()) return;
  return redactReplyValues(value.trim(), []).replace(/https?:\/\/[^\s<>"'`]+/gi, url => url.split(/[?#]/, 1)[0]);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, stableJson(val)]))
    : value;
}

function scopeKey(input: PlannedOperation): string | undefined {
  if (!input.operationKind || !input.operation.trim() || input.operation.length > maxReviewedOperationChars) return;
  let operation = input.operation.trim();
  let cwd: string | null = null;
  if (input.operationKind === "command") {
    if (!input.cwd || !path.isAbsolute(input.cwd)) return;
    cwd = input.cwd;
  } else {
    const match = /^([A-Za-z0-9_.-]+):\s+([\s\S]+)$/.exec(operation);
    if (!match) return;
    try { operation = match[1] + ": " + JSON.stringify(stableJson(JSON.parse(match[2]))); }
    catch { return; }
  }
  return createHash("sha256").update(JSON.stringify([input.operationKind, operation, cwd])).digest("hex");
}

export function parseApprovalPlan(value: unknown): ApprovalPlan | undefined {
  if (!value || typeof value !== "object") return;
  const { goal, impact, steps } = value as Record<string, unknown>;
  const safeGoal = clean(goal, 220), safeImpact = clean(impact, 240);
  if (!safeGoal || !safeImpact || !Array.isArray(steps) || steps.length < 1 || steps.length > 6) return;
  let size = 0;
  const parsed: ApprovalPlanStep[] = [];
  for (const entry of steps) {
    if (!entry || typeof entry !== "object") return;
    const { intent, effect, kind, operation, cwd } = entry as Record<string, unknown>;
    const label = clean(intent, 150);
    if (!label || (effect !== "read" && effect !== "local-write" && effect !== "remote-write")
      || (kind !== "command" && kind !== "capability") || typeof operation !== "string"
      || (kind === "command" ? typeof cwd !== "string" || cwd.length > 1024 : cwd !== null)
      || (size += operation.length) > 16_000) return;
    const target: PlannedOperation = { operation, cwd: typeof cwd === "string" ? cwd : null, operationKind: kind };
    if (!scopeKey(target)) return;
    parsed.push({ intent: label, effect, kind, operation: operation.trim(), cwd: target.cwd });
  }
  return { goal: safeGoal, impact: safeImpact, steps: parsed };
}

export function approvalPlanSummary(plan: ApprovalPlan): string {
  const effects = { read: "只读", "local-write": "本地写入", "remote-write": "线上变更" };
  return [`任务意图：${plan.goal}`, "计划：", ...plan.steps.map((step, i) => `${i + 1}. [${effects[step.effect]}] ${step.intent}`), `预计影响：${plan.impact}`].join("\n");
}

export function declareApprovalPlan(database: Database.Database, owner: ApprovalPlanIdentity, plan: ApprovalPlan): void {
  let current = plans.get(database);
  if (!current) plans.set(database, current = new Map());
  const old = current.get(owner.turnId);
  if (old && old.owner.messageId === owner.messageId && old.owner.senderId === owner.senderId
    && JSON.stringify(old.plan) === JSON.stringify(plan)) return;
  current.set(owner.turnId, { owner, plan });
}

export function currentApprovalPlan(database: Database.Database, owner: ApprovalPlanIdentity): ApprovalPlan | undefined {
  const state = plans.get(database)?.get(owner.turnId);
  return state?.owner.messageId === owner.messageId && state.owner.senderId === owner.senderId ? state.plan : undefined;
}

export function planCoversOperation(plan: ApprovalPlan, input: PlannedOperation): boolean {
  const key = scopeKey(input);
  return !!key && plan.steps.some(step => scopeKey({ ...step, operationKind: step.kind }) === key);
}

export function operationIsDeclaredRemoteWrite(plan: ApprovalPlan | undefined, input: PlannedOperation): boolean {
  const key = scopeKey(input);
  return !!key && !!plan?.steps.some(step => step.effect === "remote-write" && scopeKey({ ...step, operationKind: step.kind }) === key);
}

export function currentApprovalPlanGrant(database: Database.Database, input: ApprovalPlanIdentity & PlannedOperation, approverId: string): ApprovalPlanGrant | undefined {
  const grant = plans.get(database)?.get(input.turnId)?.grant;
  const key = scopeKey(input);
  return key && grant?.approverId === approverId && currentApprovalPlan(database, input) === grant.plan
    && (grant.remaining.get(key) ?? 0) > 0 ? grant : undefined;
}

export function preparePlanAuthorization(database: Database.Database, identity: ApprovalPlanIdentity, plan: ApprovalPlan,
  approverId: string, operations: PlannedOperation[], reviewId?: number): (() => void) | undefined {
  const state = plans.get(database)?.get(identity.turnId);
  if (!state || currentApprovalPlan(database, identity) !== plan) return;
  const grant = state.grant;
  // Concurrent callbacks must not reset a plan's operation counts.
  if (grant && grant.approverId !== approverId) return;
  const remaining = new Map(grant?.remaining);
  if (!grant) for (const step of plan.steps) {
    const key = scopeKey({ ...step, operationKind: step.kind })!;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const op of operations) {
    const key = scopeKey(op);
    if (!key || (remaining.get(key) ?? 0) < 1) return;
    remaining.set(key, remaining.get(key)! - 1);
  }
  return () => { state.grant = { plan, approverId, reviewId: grant ? grant.reviewId : reviewId, remaining }; };
}

export function applyPlanAuthorization(database: Database.Database, identity: ApprovalPlanIdentity, plan: ApprovalPlan,
  approverId: string, operations: PlannedOperation[], reviewId?: number): boolean {
  const commit = preparePlanAuthorization(database, identity, plan, approverId, operations, reviewId);
  if (!commit) return false;
  commit();
  return true;
}

export function clearApprovalPlan(database: Database.Database, turnId: string): void {
  plans.get(database)?.delete(turnId);
}
