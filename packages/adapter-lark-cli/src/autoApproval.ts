import { execFile } from "node:child_process";
import { parseLarkSentMessage, type LarkSentMessage } from "./reply.js";

export type LarkAutoApprovalCardInput = {
  reviewId: number; messageId: number; requester: string; request: string;
  source: "history" | "model"; reason: string; model: string | null;
  matchedApprovalId: number | null; appliedAt: string;
};

export function buildLarkAutoApprovalCard(input: LarkAutoApprovalCardInput): Record<string, unknown> {
  const text = `请求人：${input.requester}\n原始消息：${input.request.slice(0,1600)}\n授权范围：当前 turn\n审批来源：${input.source === "history" ? `历史人工审批 #${input.matchedApprovalId}` : `模型判断 · ${input.model}`}\n依据：${input.reason}\n授权时间：${new Date(input.appliedAt).toLocaleString("zh-CN",{ timeZone: "Asia/Shanghai", hour12:false })}\n记录：自动审批 #${input.reviewId} · 消息 #${input.messageId}`;
  return { config: { wide_screen_mode: true }, header: { template: "green", title: { tag: "plain_text", content: "Codex 自动授权 · 当前任务" } },
    elements: [{ tag: "div", text: { tag: "plain_text", content: text } },
      { tag: "note", elements: [{ tag: "plain_text", content: "当前 turn 授权已生效。这是授权通知，不代表任务或部署已完成；新 turn 会重新审核。" }] }] };
}

export function sendLarkAutoApprovalCard(recipientId: string, input: LarkAutoApprovalCardInput, idempotencyKey: string): Promise<LarkSentMessage | { ok: false; error: string }> {
  return new Promise(resolve => {
    execFile("lark-cli",["im","+messages-send","--as","bot","--user-id",recipientId,"--msg-type","interactive","--content",JSON.stringify(buildLarkAutoApprovalCard(input)),"--idempotency-key",idempotencyKey,"--format","json"],
      { encoding:"utf8",timeout:30_000,maxBuffer:1024*1024 },(error,stdout,stderr)=> {
        resolve(error ? { ok:false,error:(stderr || stdout || error.message).trim() } : parseLarkSentMessage(stdout));
      });
  });
}
