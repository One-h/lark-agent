import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LarkMessageRow } from "./context.js";
import { detectStickerImage } from "./stickers.js";

const execFileAsync = promisify(execFile);

type ImageMessage = Pick<LarkMessageRow, "message_id" | "message_type" | "content" | "reply_to_message_id" | "reply_to_message_type" | "reply_to_content">
  & Partial<Pick<LarkMessageRow, "reply_to_raw_json">>;

export type LarkImageResource = { messageId: string; imageKey: string };

export function imageKeysFromContent(content: string | null): string[] {
  if (!content) return [];
  const keys: string[] = [];
  const pattern = /\[Image:\s*(img_[A-Za-z0-9_-]+)\]|!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/gi;
  for (const match of content.matchAll(pattern)) keys.push(match[1] ?? match[2]);
  try {
    const parsed = JSON.parse(content) as unknown;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 8 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value.slice(0, 200)) visit(item, depth + 1); return; }
      const record = value as Record<string, unknown>;
      for (const key of ["image_key", "imageKey"]) {
        const imageKey = record[key];
        if (typeof imageKey === "string" && /^img_[A-Za-z0-9_-]+$/.test(imageKey)) keys.push(imageKey);
      }
      for (const nested of Object.values(record).slice(0, 200)) visit(nested, depth + 1);
    };
    visit(parsed, 0);
  } catch { /* Rendered message content is commonly plain text or Markdown. */ }
  return [...new Set(keys)];
}

export function imageMarkersWithoutKeys(content: string | null): number {
  return (content?.match(/!\[Image\](?!\()|\[Image\](?!:)/gi) ?? []).length;
}

export function larkImageResourcesFromMessage(message: ImageMessage): LarkImageResource[] {
  const resources: LarkImageResource[] = [];
  const seen = new Set<string>();
  const add = (messageId: string | null, content: string | null) => {
    if (!messageId) return;
    for (const imageKey of imageKeysFromContent(content)) {
      const key = `${messageId}:${imageKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push({ messageId, imageKey });
    }
  };
  add(message.reply_to_message_id, message.reply_to_content);
  add(message.reply_to_message_id, message.reply_to_raw_json ?? null);
  add(message.message_id, message.content);
  return resources;
}

export function larkImageResourceFromMessage(message: ImageMessage): LarkImageResource | null {
  return larkImageResourcesFromMessage(message)[0] ?? null;
}

export async function downloadLarkImageToTask(input: {
  messageId: string;
  imageKey: string;
  taskDir: string;
  subdirectory: "images" | "history-images";
  fileStem: string;
  timeoutMs: number;
}): Promise<{ path: string; mimeType: string; bytes: Buffer }> {
  const directory = path.join(input.taskDir, input.subdirectory);
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(input.subdirectory, input.fileStem.replace(/[^A-Za-z0-9_-]/g, "_"));
  const { stdout } = await execFileAsync("lark-cli", ["im", "+messages-resources-download", "--as", "bot", "--message-id", input.messageId,
    "--file-key", input.imageKey, "--type", "image", "--output", output],
  { cwd: input.taskDir, encoding: "utf8", timeout: input.timeoutMs, maxBuffer: 1024 * 1024 });
  let saved = output;
  try {
    const parsed = JSON.parse(stdout) as { data?: { saved_path?: unknown } };
    if (typeof parsed.data?.saved_path === "string") saved = parsed.data.saved_path;
  } catch { /* The CLI may emit a path without JSON metadata. */ }
  const imagePath = fs.realpathSync(path.resolve(input.taskDir, saved));
  if (!imagePath.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error("Downloaded image escaped the task directory");
  const size = fs.statSync(imagePath).size;
  if (size < 1 || size > 8 * 1024 * 1024) throw new Error("Downloaded image exceeds the 8 MB limit");
  const bytes = fs.readFileSync(imagePath);
  const detected = detectStickerImage(bytes);
  if (!detected) throw new Error("Downloaded file is not a supported image");
  fs.chmodSync(imagePath, 0o600);
  return { path: imagePath, mimeType: detected.mimeType, bytes };
}
