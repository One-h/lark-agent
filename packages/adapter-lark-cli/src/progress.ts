import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jsonFromCliOutput, parseLarkSentMessage, type LarkSentMessage } from "./reply.js";

export type LarkProgressState = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type LarkProgressEntry = { id: string; at: string; text: string };
export type LarkProgressContent = { state: LarkProgressState; entries: LarkProgressEntry[] };
const labels: Record<LarkProgressState, string> = { running: "处理中", completed: "本轮已结束", failed: "执行失败", cancelled: "已取消", interrupted: "执行已中断" };
const escape = (text: string) => text.replace(/[&<>*_\[\]`~]/g, c => `&#${c.charCodeAt(0)};`);

export function buildLarkProgressCard(input: LarkProgressContent) {
  const entries = input.entries.slice(-5).map(entry => {
    const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(entry.at));
    return `${time}  ${escape(entry.text.replace(/\s+/g, " ").slice(0, 180))}`;
  }).join("\n\n");
  return { schema: "2.0", config: { update_multi: true, width_mode: "compact", summary: { content: `任务进度 · ${labels[input.state]}` } },
    body: { direction: "vertical", padding: "8px", vertical_spacing: "8px", elements: [
      { tag: "column_set", flex_mode: "none", background_style: input.state === "running" ? "blue-50" : input.state === "completed" ? "green-50" : "grey-50",
        columns: [{ tag: "column", width: "weighted", weight: 1, padding: "4px", elements: [{ tag: "markdown", content: `**${labels[input.state]}**` }] }] },
      { tag: "markdown", content: entries || "已开始处理。", text_size: "notation" }
    ] } };
}

const execute = promisify(execFile);
async function cli(args: string[]): Promise<string> {
  const { stdout } = await execute("lark-cli", args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  const result = jsonFromCliOutput(stdout) as { ok?: boolean; code?: number; error?: { message?: string } } | null;
  if (!result || result.ok === false || typeof result.code === "number" && result.code !== 0) throw new Error(result?.error?.message?.slice(0, 300) || "Lark progress card API rejected the request");
  return JSON.stringify(result);
}

export async function sendLarkProgressCard(messageId: string, content: LarkProgressContent, key: string): Promise<LarkSentMessage> {
  return parseLarkSentMessage(await cli(["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--msg-type", "interactive",
    "--content", JSON.stringify(buildLarkProgressCard(content)), "--idempotency-key", key, "--format", "json"]));
}

export async function updateLarkProgressCard(messageId: string, content: LarkProgressContent): Promise<{ ok: true }> {
  await cli(["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", JSON.stringify({ content: JSON.stringify(buildLarkProgressCard(content)) }), "--format", "json"]);
  return { ok: true };
}
