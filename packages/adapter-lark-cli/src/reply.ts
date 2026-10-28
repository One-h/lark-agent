import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

export function larkReplyIdempotencyKey(kind: string, seed: string): string {
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `afc-${kind}-${hash}`;
}

export function larkAtTag(openId: string, displayName = ""): string {
  return `<at user_id="${openId}">${displayName}</at>`;
}

export type LarkSentMessage = {
  ok: true;
  messageId: string | null;
  chatId: string | null;
  messageAt: string | null;
  messageType: string | null;
};

type LarkSendResult = LarkSentMessage | { ok: false; error: string };

export function jsonFromCliOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { /* Some CLI versions print notices before JSON. */ }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as unknown; } catch { /* Continue to an earlier line. */ }
  }
  return null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function firstString(records: Array<Record<string, unknown> | null>, keys: string[]): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function isoFromLarkTime(value: string | null): string | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseLarkSentMessage(stdout: string): LarkSentMessage {
  const root = jsonFromCliOutput(stdout);
  const rootRecord = root && typeof root === "object" ? root as Record<string, unknown> : null;
  const data = nestedRecord(rootRecord, "data");
  const records = [nestedRecord(data, "message") ?? nestedRecord(rootRecord, "message"), nestedRecord(data, "item") ?? nestedRecord(rootRecord, "item"), data, rootRecord];
  return {
    ok: true,
    messageId: firstString(records, ["message_id", "messageId"]),
    chatId: firstString(records, ["chat_id", "chatId"]),
    messageAt: isoFromLarkTime(firstString(records, ["create_time", "createTime", "created_at", "createdAt"])),
    messageType: firstString(records, ["msg_type", "message_type", "messageType"])
  };
}

export function sendLarkTextReply(
  messageId: string,
  text: string,
  idempotencyKey: string
): LarkSendResult {
  const result = spawnSync(
    "lark-cli",
    ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--text", text, "--idempotency-key", idempotencyKey, "--format", "json"],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return parseLarkSentMessage(result.stdout);
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function sendLarkTextMessage(recipientId: string, text: string, idempotencyKey: string): LarkSendResult {
  const result = spawnSync(
    "lark-cli",
    ["im", "+messages-send", "--as", "bot", "--user-id", recipientId, "--text", text, "--idempotency-key", idempotencyKey, "--format", "json"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }
  );
  if (result.status === 0) return parseLarkSentMessage(result.stdout);
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function larkReplyMediaFlag(relativePath: string): "--image" | "--file" {
  return imageExtensions.has(path.extname(relativePath).toLowerCase()) ? "--image" : "--file";
}

export function buildLarkMediaReplyArgs(messageId: string, relativePath: string, idempotencyKey: string): string[] {
  return [
    "im",
    "+messages-reply",
    "--as",
    "bot",
    "--message-id",
    messageId,
    larkReplyMediaFlag(relativePath),
    relativePath,
    "--idempotency-key",
    idempotencyKey
  ];
}

export function sendLarkMediaReply(
  messageId: string,
  taskDir: string,
  relativePath: string,
  idempotencyKey: string
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync("lark-cli", buildLarkMediaReplyArgs(messageId, relativePath, idempotencyKey), {
    cwd: taskDir,
    encoding: "utf8"
  });
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function uploadLarkReplyImage(taskDir: string, relativePath: string): { ok: true; imageKey: string } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    ["im", "images", "create", "--as", "bot", "--data", JSON.stringify({ image_type: "message" }), "--file", relativePath],
    { cwd: taskDir, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { data?: { image_key?: unknown }; image_key?: unknown };
    const imageKey = typeof parsed.data?.image_key === "string" ? parsed.data.image_key : parsed.image_key;
    return typeof imageKey === "string" && imageKey ? { ok: true, imageKey } : { ok: false, error: "Lark image upload returned no image_key" };
  } catch {
    return { ok: false, error: "Lark image upload returned invalid JSON" };
  }
}

export function buildLarkImagePostReplyArgs(messageId: string, imageKeys: string[], idempotencyKey: string): string[] {
  const content = {
    zh_cn: {
      content: imageKeys.map((imageKey) => [{ tag: "img", image_key: imageKey }])
    }
  };
  return [
    "im",
    "+messages-reply",
    "--as",
    "bot",
    "--message-id",
    messageId,
    "--msg-type",
    "post",
    "--content",
    JSON.stringify(content),
    "--idempotency-key",
    idempotencyKey
  ];
}

export function sendLarkImagePostReply(
  messageId: string,
  taskDir: string,
  imagePaths: string[],
  idempotencyKey: string
): { ok: true; imageCount: number } | { ok: false; error: string } {
  const imageKeys: string[] = [];
  for (const imagePath of imagePaths) {
    const uploaded = uploadLarkReplyImage(taskDir, imagePath);
    if (!uploaded.ok) {
      return uploaded;
    }
    imageKeys.push(uploaded.imageKey);
  }
  const result = spawnSync("lark-cli", buildLarkImagePostReplyArgs(messageId, imageKeys, idempotencyKey), {
    cwd: taskDir,
    encoding: "utf8"
  });
  if (result.status === 0) {
    return { ok: true, imageCount: imageKeys.length };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export type LarkExecutionApprovalDetails = {
  requester: string;
  originalMessage: string;
  operation: string;
  operationCount?: number;
  cwd: string | null;
  reason: string | null;
  taskContext?: string;
};
export type LarkExecutionApprovalCardInput = LarkExecutionApprovalDetails & (
  { approvalToken: string; approvalId?: never } | { approvalId: number; approvalToken?: never }
);

export type LarkExecutionApprovalResultCardInput = LarkExecutionApprovalDetails & {
  status: "approved" | "rejected" | "expired" | "failed";
  approvalScope: "once" | "turn";
  decidedAt: string;
};

function compactCardText(value: string | null, maxLength: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "-";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function buildLarkExecutionApprovalCard(input: LarkExecutionApprovalCardInput): Record<string, unknown> {
  const operationLabel = input.operationCount && input.operationCount > 1
    ? `**待执行操作（${input.operationCount} 项）**`
    : "**待执行操作**";
  const details = [
    `**请求人**：${compactCardText(input.requester, 120)}`,
    `**原始消息**：${compactCardText(input.originalMessage, 500)}`,
    input.taskContext ? `**任务背景（历史）**：${compactCardText(input.taskContext, 600)}` : null,
    `${operationLabel}：${compactCardText(input.operation, 800)}`,
    input.cwd ? `**工作目录**：${compactCardText(input.cwd, 300)}` : null,
    input.reason ? `**原因**：${compactCardText(input.reason, 300)}` : null
  ].filter((value): value is string => Boolean(value));
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Lark Agent 执行授权" }
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: details.join("\n") } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "允许本次" },
            value: { action: "approve", ...(input.approvalId !== undefined ? { approval_id: String(input.approvalId) } : { approval_token: input.approvalToken }) }
          },
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "允许当前任务" },
            value: { action: "approve-turn", ...(input.approvalId !== undefined ? { approval_id: String(input.approvalId) } : { approval_token: input.approvalToken }) }
          },
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "拒绝" },
            value: { action: "reject", ...(input.approvalId !== undefined ? { approval_id: String(input.approvalId) } : { approval_token: input.approvalToken }) }
          }
        ]
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: input.operationCount && input.operationCount > 1
            ? `“允许本次”会放行当前批次的 ${input.operationCount} 项操作；“允许当前任务”还会自动放行当前 Codex turn 内的后续受限操作。审批 10 分钟后失效。`
            : "“允许本次”只放行当前操作；“允许当前任务”会自动放行当前 Codex turn 内的后续受限操作。审批 10 分钟后失效。"
        }]
      }
    ]
  };
}

export function buildLarkExecutionApprovalResultCard(input: LarkExecutionApprovalResultCardInput): Record<string, unknown> {
  const status = input.status === "approved"
    ? input.approvalScope === "turn"
      ? { label: "已允许当前任务", template: "green", note: "当前 Codex turn 内的后续受限操作将自动放行；新 turn 会重新审批。授权不代表执行成功。" }
      : { label: "已允许本次", template: "green", note: "仅授权当前操作，不代表执行成功；后续受限操作仍需审批。" }
    : input.status === "rejected"
      ? { label: "已拒绝", template: "red", note: "该操作未执行。" }
      : input.status === "expired"
        ? { label: "已过期", template: "grey", note: "该操作未执行，请重新发送指令。" }
        : { label: "处理失败", template: "red", note: "审批请求处理失败，请重新发送指令。" };
  const details = [
    `**状态**：${status.label}`,
    `**请求人**：${compactCardText(input.requester, 120)}`,
    `**原始消息**：${compactCardText(input.originalMessage, 500)}`,
    input.taskContext ? `**任务背景（历史）**：${compactCardText(input.taskContext, 600)}` : null,
    `**待执行操作**：${compactCardText(input.operation, 800)}`,
    input.cwd ? `**工作目录**：${compactCardText(input.cwd, 300)}` : null,
    input.reason ? `**原因**：${compactCardText(input.reason, 300)}` : null,
    `**处理时间**：${new Date(input.decidedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
  ].filter((value): value is string => Boolean(value));
  return {
    config: { wide_screen_mode: true },
    header: {
      template: status.template,
      title: { tag: "plain_text", content: `Lark Agent 执行授权 · ${status.label}` }
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: details.join("\n") } },
      { tag: "note", elements: [{ tag: "plain_text", content: status.note }] }
    ]
  };
}

export type LarkExecutionReceiptEntry = {
  capability: string;
  title: string;
  status: "queried" | "executed" | "verified" | "failed";
  summary: string;
  evidence: string[];
};

export function buildLarkExecutionReceiptCard(input: { status: LarkExecutionReceiptEntry["status"]; entries: LarkExecutionReceiptEntry[] }): Record<string, unknown> {
  const status = input.status === "verified"
    ? { label: "已验证", template: "green" }
    : input.status === "executed"
      ? { label: "已执行", template: "blue" }
      : input.status === "queried"
        ? { label: "仅查询", template: "grey" }
        : { label: "执行失败", template: "red" };
  const content = input.entries.slice(0, 8).map((entry, index) => {
    const label = entry.status === "verified" ? "已验证" : entry.status === "executed" ? "已执行" : entry.status === "queried" ? "仅查询" : "失败";
    const evidence = entry.evidence.slice(0, 3).map((item) => `  - ${compactCardText(item, 240)}`).join("\n");
    return `${index + 1}. **${compactCardText(entry.title, 120)}** · ${label}\n   ${compactCardText(entry.summary, 400)}${evidence ? `\n${evidence}` : ""}`;
  }).join("\n\n");
  return {
    config: { wide_screen_mode: true },
    header: { template: status.template, title: { tag: "plain_text", content: `Lark Agent 执行回执 · ${status.label}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content } },
      { tag: "note", elements: [{ tag: "plain_text", content: "回执来自真实工具调用和宿主返回结果，不代表模型文字本身已验证。" }] }
    ]
  };
}

export function sendLarkExecutionReceiptCard(messageId: string, input: { status: LarkExecutionReceiptEntry["status"]; entries: LarkExecutionReceiptEntry[] }, idempotencyKey: string): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const result = spawnSync("lark-cli", ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--msg-type", "interactive", "--content", JSON.stringify(buildLarkExecutionReceiptCard(input)), "--idempotency-key", idempotencyKey], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
  try { const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } }; return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null }; } catch { return { ok: true, messageId: null }; }
}

export function sendLarkExecutionApprovalCard(
  approverOpenId: string,
  input: LarkExecutionApprovalCardInput,
  idempotencyKey: string
): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--user-id",
      approverOpenId,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(buildLarkExecutionApprovalCard(input)),
      "--idempotency-key",
      idempotencyKey
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } };
      return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null };
    } catch {
      return { ok: true, messageId: null };
    }
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function updateLarkExecutionApprovalCard(
  messageId: string,
  input: LarkExecutionApprovalResultCardInput
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(buildLarkExecutionApprovalResultCard(input)) })
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function updatePendingLarkExecutionApprovalCard(
  messageId: string,
  input: LarkExecutionApprovalCardInput
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(buildLarkExecutionApprovalCard(input)) })
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function buildLarkReactionArgs(messageId: string, emojiType: string): string[] {
  return [
    "im",
    "reactions",
    "create",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } })
  ];
}

export function sendLarkReaction(messageId: string, emojiType: string): { ok: true } | { ok: false; error: string } {
  const result = spawnSync("lark-cli", buildLarkReactionArgs(messageId, emojiType), { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}
