import { spawnSync } from "node:child_process";
import { buildLarkExecutionApprovalCard, buildLarkExecutionApprovalResultCard } from "./reply.js";

export type CapabilityApprovalCardInput = { approvalId: number; operation: string; originalMessage: string;
  requester?: string; cwd?: string | null; reason?: string | null; taskContext?: string; taskPlan?: string; allowPlanApproval?: boolean; wholeTask?: boolean };

export function formatCapabilityApprovalOperation(operation: string): string {
  const boundary = operation.indexOf(": ");
  if (boundary < 1 || boundary > 80) return "宿主操作";
  try {
    const payload = JSON.parse(operation.slice(boundary + 1));
    const title = operation.slice(0, boundary);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return title;
    const { repo, apps, expectedRevision } = payload;
    const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_./-]{1,80}$/.test(value);
    const appNames: string[] = (Array.isArray(apps) ? apps.slice(0, 4) : [apps]).filter(identifier);
    const appSuffix = Array.isArray(apps) && apps.length > 4 ? `（共 ${apps.length} 项）` : "";
    const parts = [title, identifier(repo) ? `仓库：${repo}` : "",
      appNames.length ? `应用：${appNames.join("、")}${appSuffix}` : "",
      identifier(expectedRevision) ? `目标版本：${expectedRevision}` : ""];
    return parts.filter(Boolean).join("；");
  } catch { return "宿主操作"; }
}

export function sendApprovalCard(approverId: string, input: CapabilityApprovalCardInput): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const content = buildLarkExecutionApprovalCard({ ...input, operationSummary: formatCapabilityApprovalOperation(input.operation), requester: input.requester ?? "未知发送人", cwd: input.cwd ?? null, reason: input.reason ?? null });
  const result = spawnSync("lark-cli", ["im", "+messages-send", "--as", "bot", "--user-id", approverId, "--msg-type", "interactive", "--content", JSON.stringify(content), "--idempotency-key", `lag-approval-${input.approvalId}`], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || "card send failed").trim() };
  try { const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } }; return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null }; } catch { return { ok: true, messageId: null }; }
}

export function updateApprovalCard(messageId: string, input: Omit<CapabilityApprovalCardInput, "approvalId"> & {
  status: "approved" | "rejected" | "expired" | "failed"; approvalScope: "once" | "turn"; planApproved?: boolean; decidedAt: string;
}): void {
  const content = buildLarkExecutionApprovalResultCard({ ...input, operationSummary: formatCapabilityApprovalOperation(input.operation), requester: input.requester ?? "未知发送人", cwd: input.cwd ?? null, reason: input.reason ?? null });
  spawnSync("lark-cli", ["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", JSON.stringify({ content: JSON.stringify(content) })], { encoding: "utf8", timeout: 30_000 });
}
