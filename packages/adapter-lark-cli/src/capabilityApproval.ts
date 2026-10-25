import { spawnSync } from "node:child_process";

export function sendApprovalCard(approverId: string, input: { approvalId: number; operation: string; originalMessage: string }): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const content = { config: { wide_screen_mode: true }, header: { template: "orange", title: { tag: "plain_text", content: "Lark Agent 执行授权" } }, elements: [{ tag: "div", text: { tag: "lark_md", content: `**原始消息**：${input.originalMessage}\n**待执行操作**：${input.operation}` } }, { tag: "action", actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "允许" }, value: { approval_id: String(input.approvalId), action: "approve" } }, { tag: "button", text: { tag: "plain_text", content: "拒绝" }, value: { approval_id: String(input.approvalId), action: "reject" } }] }] };
  const result = spawnSync("lark-cli", ["im", "+messages-send", "--as", "bot", "--user-id", approverId, "--msg-type", "interactive", "--content", JSON.stringify(content), "--idempotency-key", `lag-approval-${input.approvalId}`], { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || "card send failed").trim() };
  try { const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } }; return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null }; } catch { return { ok: true, messageId: null }; }
}

export function updateApprovalCard(messageId: string, input: { operation: string; status: "approved" | "rejected" | "expired" }): void {
  const label = input.status === "approved" ? "已允许当前任务" : input.status === "rejected" ? "已拒绝当前任务" : "审批已过期";
  const template = input.status === "approved" ? "green" : input.status === "rejected" ? "red" : "grey";
  const content = { config: { wide_screen_mode: true }, header: { template, title: { tag: "plain_text", content: `Lark Agent 执行授权 · ${label}` } }, elements: [{ tag: "div", text: { tag: "lark_md", content: `**状态**：${label}\n**待执行操作**：${input.operation}` } }] };
  spawnSync("lark-cli", ["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", JSON.stringify({ content: JSON.stringify(content) })], { encoding: "utf8" });
}
