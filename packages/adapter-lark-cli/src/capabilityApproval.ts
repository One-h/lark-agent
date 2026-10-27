import { spawnSync } from "node:child_process";
import { buildLarkExecutionApprovalCard, buildLarkExecutionApprovalResultCard } from "./reply.js";

export type CapabilityApprovalCardInput = { approvalId: number; operation: string; originalMessage: string;
  requester?: string; cwd?: string | null; reason?: string | null; taskContext?: string };

export function formatCapabilityApprovalOperation(operation: string): string {
  const boundary = operation.indexOf(":");
  if (boundary < 0) return operation;
  try {
    const payload = JSON.parse(operation.slice(boundary + 1));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return operation;
    const { repo, apps, expectedRevision, ...rest } = payload;
    const parts = [operation.slice(0, boundary), repo !== undefined ? `仓库：${JSON.stringify(repo)}` : "",
      apps !== undefined ? `应用：${JSON.stringify(apps)}` : "", expectedRevision !== undefined ? `目标版本：${JSON.stringify(expectedRevision)}` : "",
      Object.keys(rest).length ? `其他参数：${JSON.stringify(rest)}` : ""];
    return parts.filter(Boolean).join("；");
  } catch { return operation; }
}

export function sendApprovalCard(approverId: string, input: CapabilityApprovalCardInput): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const content = buildLarkExecutionApprovalCard({ ...input, operation: formatCapabilityApprovalOperation(input.operation), requester: input.requester ?? "未知发送人", cwd: input.cwd ?? null, reason: input.reason ?? null });
  const result = spawnSync("lark-cli", ["im", "+messages-send", "--as", "bot", "--user-id", approverId, "--msg-type", "interactive", "--content", JSON.stringify(content), "--idempotency-key", `lag-approval-${input.approvalId}`], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || "card send failed").trim() };
  try { const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } }; return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null }; } catch { return { ok: true, messageId: null }; }
}

export function updateApprovalCard(messageId: string, input: Omit<CapabilityApprovalCardInput, "approvalId"> & {
  status: "approved" | "rejected" | "expired" | "failed"; approvalScope: "once" | "turn"; decidedAt: string;
}): void {
  const content = buildLarkExecutionApprovalResultCard({ ...input, operation: formatCapabilityApprovalOperation(input.operation), requester: input.requester ?? "未知发送人", cwd: input.cwd ?? null, reason: input.reason ?? null });
  spawnSync("lark-cli", ["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", JSON.stringify({ content: JSON.stringify(content) })], { encoding: "utf8", timeout: 30_000 });
}
