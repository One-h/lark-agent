import { createHmac } from "node:crypto";

// Neither the MCP server nor the native agent receives the host control key.
// Distinct derivations keep catalog authentication separate from turn authority.
export function retainedForegroundMcpBearer(controlKey: string): string {
  return createHmac("sha256", controlKey).update("lark:retained-foreground:mcp-bearer:v1").digest("base64url");
}

export function retainedForegroundMcpContextToken(controlKey: string, generation: string, turnId: string): string {
  return createHmac("sha256", controlKey).update(JSON.stringify(["lark:retained-foreground:mcp-context:v1", generation, turnId]))
    .digest().subarray(0, 24).toString("base64url");
}

export function larkMcpToolsInstruction(token?: string, trusted = false): string {
  if (!token) return "";
  const outcome = trusted ? "" : "工具仅返回 declined 或「用户拒绝」而没有明确来源时，用 lark_approval_status（input={}）核实结果。超时没有人工决定；可交付已完成的部分。仅在确认人工拒绝时称为人工拒绝。";
  return `发布、PR 评审、Issue 分析、待办、飞书消息等能力通过 lark_tools MCP 直接调用。工具参数使用本轮 context_token=${token}，业务参数放在 input 内；令牌不可对外展示，不使用历史令牌。任务计划只用于安排工作，不是工具调用的前置步骤。按实际工具结果继续，不把未执行说成已完成。${outcome}`;
}

export function retainedForegroundMcpPrompt(text: string, controlKey: string, generation: string, turnId: string, trusted: boolean): string {
  const token = retainedForegroundMcpContextToken(controlKey, generation, turnId);
  return `${text}\n\n${larkMcpToolsInstruction(token, trusted)}\n若目录提供 lark_task_orchestration，仅在明确委派或跟进已委派任务时使用该工具。`;
}
