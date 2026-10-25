import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { LarkMessageRow } from "./context.js";
import { downloadLarkImageToTask, imageKeysFromContent } from "./mediaImages.js";
import { detectStickerImage } from "./stickers.js";

type HistoryMessage = Pick<LarkMessageRow, "id" | "chat_id" | "chat_type" | "thread_id" | "root_message_id">;
type ImageRow = { id: number; message_id: string; sender_id: string | null; content: string | null; message_at: string | null };
type ContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };
export type HistoryImageBudget = { opened: Set<string>; opening: Set<string> };
export type HistoryImageState = { candidates: Set<string>; opened: Map<string, string>; budget: HistoryImageBudget };
export type HistoryImageResult = { success: boolean; contentItems: ContentItem[]; candidateCount: number; openedCount: number };

export function createHistoryImageBudget(): HistoryImageBudget { return { opened: new Set(), opening: new Set() }; }
export function createHistoryImageState(): HistoryImageState { return { candidates: new Set(), opened: new Map(), budget: createHistoryImageBudget() }; }
export function historyImagesAllowed(_trustedSender: boolean, chatType: string | null): boolean { return chatType === "p2p" || chatType === "group"; }

function scope(current: HistoryMessage): { sql: string; values: unknown[] } {
  if (current.chat_type === "p2p") return { sql: "", values: [] };
  if (current.thread_id) {
    return {
      sql: `AND (m.thread_id = ?${current.root_message_id ? " OR m.message_id = ?" : ""})`,
      values: [current.thread_id, ...(current.root_message_id ? [current.root_message_id] : [])]
    };
  }
  return {
    sql: `AND m.thread_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM lark_messages AS child
      WHERE child.chat_id = m.chat_id AND child.root_message_id = m.message_id AND child.thread_id IS NOT NULL
    )`, values: []
  };
}

function imageRows(db: Database.Database, current: HistoryMessage, beforeLocalId: number, query: string): ImageRow[] {
  if (!current.chat_id) return [];
  const chatScope = scope(current);
  return db.prepare(`
    SELECT m.id, m.message_id, m.sender_id, m.content, m.message_at
    FROM lark_messages AS m
    WHERE m.chat_id = ? AND m.id < ? AND m.id < ? AND m.message_id IS NOT NULL
      AND m.message_type IN ('image', 'post', 'text')
      AND (m.content LIKE '%img_%' OR m.content LIKE '%[Image:%')
      ${chatScope.sql}
      ${query ? "AND instr(lower(COALESCE(m.content, '')), lower(?)) > 0" : ""}
    ORDER BY m.id DESC LIMIT 160
  `).all(current.chat_id, current.id, beforeLocalId, ...chatScope.values, ...(query ? [query] : [])) as ImageRow[];
}

export function searchLarkHistoryImages(
  db: Database.Database, current: HistoryMessage, state: HistoryImageState,
  input: { query?: string; limit?: number; beforeLocalId?: number }
): HistoryImageResult {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 10;
  const beforeLocalId = input.beforeLocalId ?? current.id;
  if (query.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 20
    || !Number.isInteger(beforeLocalId) || beforeLocalId < 1 || beforeLocalId > current.id) {
    return { success: false, contentItems: [{ type: "inputText", text: "Invalid history image search parameters" }], candidateCount: 0, openedCount: state.budget.opened.size };
  }
  const rows = imageRows(db, current, beforeLocalId, query);
  const items = rows.flatMap((row) => {
    const imageKeys = imageKeysFromContent(row.content);
    return imageKeys.length > 0 ? [{ localId: row.id, sentAt: row.message_at, senderId: row.sender_id,
      imageCount: imageKeys.length, preview: (row.content ?? "").replace(/\[Image:[^\]]+\]|!\[[^\]]*\]\([^)]*\)/g, "[图片]").slice(0, 120) }] : [];
  }).slice(0, limit);
  state.candidates = new Set(items.flatMap((item) => Array.from({ length: item.imageCount }, (_, index) => `${item.localId}:${index + 1}`)));
  const nextBeforeLocalId = items.length === limit ? items.at(-1)!.localId : rows.length === 160 ? rows.at(-1)!.id : null;
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ images: items, nextBeforeLocalId, note: "imageIndex starts at 1; open only a listed image" }) }],
    candidateCount: state.candidates.size, openedCount: state.budget.opened.size };
}

function readHistoryImage(messageId: string, imageKey: string, taskDir: string, localId: number, imageIndex: number) {
  return downloadLarkImageToTask({ messageId, imageKey, taskDir, subdirectory: "history-images",
    fileStem: `${localId}-${imageIndex}-${imageKey}`, timeoutMs: 18_000 });
}

export async function openLarkHistoryImage(
  db: Database.Database, current: HistoryMessage, taskDir: string, state: HistoryImageState,
  input: { localId: number; imageIndex: number },
  download: (messageId: string, imageKey: string, taskDir: string, localId: number, imageIndex: number) => Promise<{ path: string; mimeType: string; bytes: Buffer }> | { path: string; mimeType: string; bytes: Buffer } = readHistoryImage
): Promise<HistoryImageResult> {
  const key = `${input.localId}:${input.imageIndex}`;
  const failure = (reason: string): HistoryImageResult => ({ success: false, contentItems: [{ type: "inputText", text: reason }], candidateCount: state.candidates.size, openedCount: state.budget.opened.size });
  if (!Number.isInteger(input.localId) || !Number.isInteger(input.imageIndex) || !state.candidates.has(key)) return failure("Image was not offered by the latest search");
  if (state.budget.opening.has(key)) return failure("This image is already being opened; wait for that tool result");
  if (!state.budget.opened.has(key) && state.budget.opened.size + state.budget.opening.size >= 4) return failure("At most four history images may be opened in one turn");
  const row = db.prepare("SELECT id,chat_id,chat_type,thread_id,root_message_id,message_id,content FROM lark_messages WHERE id=?").get(input.localId) as (ImageRow & HistoryMessage & { chat_id: string; thread_id: string | null; root_message_id: string | null }) | undefined;
  if (!row?.message_id || row.chat_id !== current.chat_id || row.id >= current.id) return failure("Image is outside the current conversation");
  if (current.chat_type !== "p2p") {
    const sameTopic = current.thread_id
      ? row.thread_id === current.thread_id || Boolean(current.root_message_id && row.message_id === current.root_message_id)
      : !row.thread_id && !(db.prepare("SELECT 1 FROM lark_messages WHERE chat_id=? AND root_message_id=? AND thread_id IS NOT NULL LIMIT 1").get(row.chat_id, row.message_id));
    if (!sameTopic) return failure("Image is outside the current topic");
  }
  const imageKey = imageKeysFromContent(row.content)[input.imageIndex - 1];
  if (!imageKey) return failure("Image key is no longer available");
  state.budget.opening.add(key);
  try {
    let image: { path: string; mimeType: string; bytes: Buffer };
    const cached = state.opened.get(key);
    if (cached && fs.existsSync(cached)) {
      const safePath = fs.realpathSync(cached);
      if (!safePath.startsWith(`${fs.realpathSync(path.join(taskDir, "history-images"))}${path.sep}`) || fs.statSync(safePath).size > 8 * 1024 * 1024) {
        return failure("Cached image path or size is invalid");
      }
      const bytes = fs.readFileSync(safePath);
      const detected = detectStickerImage(bytes);
      if (!detected) return failure("Cached image is invalid");
      image = { path: safePath, mimeType: detected.mimeType, bytes };
    } else image = await download(row.message_id, imageKey, taskDir, input.localId, input.imageIndex);
    state.opened.set(key, image.path);
    state.budget.opened.add(key);
    return { success: true, contentItems: [
      { type: "inputText", text: `Historical image from local message ${row.id}, image ${input.imageIndex}.` },
      { type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` }
    ], candidateCount: state.candidates.size, openedCount: state.budget.opened.size };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  finally { state.budget.opening.delete(key); }
}
