import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configuredLarkStickerUsageMode, config, db, nowIso, type LarkStickerRow, type LarkStickerUsageMode } from "./context.js";

const maxStickerBytes = 2 * 1024 * 1024;
const maxStickerBatch = 20;

export type LarkSticker = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string | null;
  sourceSite: string | null;
  enabled: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  imageUrl: string;
};

export type LarkStickerUpload = {
  name: string;
  description?: string;
  tags?: string[];
  fileName: string;
  mimeType: string;
  dataBase64: string;
  sourceUrl?: string;
  sourceSite?: string;
};

export type StagedLarkSticker = {
  relativePath: string;
  absolutePath: string;
  kind: "image";
  size: number;
  stickerId: string;
};

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags: string[] = []): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function publicSticker(row: LarkStickerRow): LarkSticker {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sourceUrl: row.source_url,
    sourceSite: row.source_site,
    enabled: row.enabled === 1,
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imageUrl: `/api/lark/stickers/${encodeURIComponent(row.id)}/image`
  };
}

export function detectStickerImage(buffer: Buffer): { mimeType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return { mimeType: "image/gif", extension: ".gif" };
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp" };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") {
    return { mimeType: "image/bmp", extension: ".bmp" };
  }
  return null;
}

function decodeStickerData(dataBase64: string): Buffer {
  if (!dataBase64 || dataBase64.length > Math.ceil(maxStickerBytes / 3) * 4 + 8 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(dataBase64)) {
    throw new Error("图片 Base64 无效或超过 2 MB");
  }
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length === 0 || buffer.length > maxStickerBytes) {
    throw new Error("图片为空或超过 2 MB");
  }
  return buffer;
}

export function listLarkStickers(enabledOnly = false): LarkSticker[] {
  const where = enabledOnly ? "WHERE deleted_at IS NULL AND enabled = 1" : "WHERE deleted_at IS NULL";
  return (db.prepare(`SELECT * FROM stickers ${where} ORDER BY updated_at DESC, id DESC`).all() as LarkStickerRow[]).map(publicSticker);
}

export function uploadLarkStickers(files: LarkStickerUpload[]): LarkSticker[] {
  if (files.length === 0 || files.length > maxStickerBatch) {
    throw new Error(`每次需上传 1-${maxStickerBatch} 张表情包`);
  }
  fs.mkdirSync(config.larkStickerDirectory, { recursive: true });
  const prepared = files.map((file) => {
    const buffer = decodeStickerData(file.dataBase64);
    const detected = detectStickerImage(buffer);
    if (!detected || detected.mimeType !== file.mimeType) {
      throw new Error(`${file.fileName} 的图片格式与内容不一致`);
    }
    const id = `stk_${crypto.randomBytes(8).toString("hex")}`;
    const storedName = `${id}${detected.extension}`;
    const timestamp = nowIso();
    return {
      id,
      buffer,
      storedName,
      storedPath: path.join(config.larkStickerDirectory, storedName),
      name: file.name.trim().slice(0, 80) || path.basename(file.fileName, path.extname(file.fileName)).slice(0, 80) || id,
      description: (file.description ?? "").trim().slice(0, 300),
      tags: normalizeTags(file.tags),
      mimeType: detected.mimeType,
      sourceUrl: file.sourceUrl?.trim().slice(0, 2_000) || null,
      sourceSite: file.sourceSite?.trim().slice(0, 200) || null,
      contentHash: crypto.createHash("sha256").update(buffer).digest("hex"),
      timestamp
    };
  }).filter((item, index, items) => items.findIndex((candidate) => candidate.contentHash === item.contentHash) === index)
    .filter((item) => !db.prepare("SELECT 1 FROM stickers WHERE content_hash = ? LIMIT 1").get(item.contentHash));
  if (prepared.length === 0) return [];
  const insert = db.prepare(`
    INSERT INTO stickers (
      id, name, description, tags, file_name, mime_type, size_bytes,
      source_url, source_site, content_hash, local_path,
      enabled, usage_count, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)
  `);
  try {
    for (const item of prepared) {
      fs.writeFileSync(item.storedPath, item.buffer, { mode: 0o600, flag: "wx" });
    }
    db.transaction(() => {
      for (const item of prepared) {
        insert.run(
          item.id,
          item.name,
          item.description,
          JSON.stringify(item.tags),
          item.storedName,
          item.mimeType,
          item.buffer.length,
          item.sourceUrl,
          item.sourceSite,
          item.contentHash,
          item.storedPath,
          item.timestamp,
          item.timestamp
        );
      }
    })();
  } catch (error) {
    for (const item of prepared) {
      if (fs.existsSync(item.storedPath)) fs.unlinkSync(item.storedPath);
    }
    throw error;
  }
  return prepared.map((item) => publicSticker(db.prepare("SELECT * FROM stickers WHERE id = ?").get(item.id) as LarkStickerRow));
}

export function updateLarkSticker(id: string, patch: { name?: string; description?: string; tags?: string[]; enabled?: boolean }): LarkSticker | null {
  const existing = db.prepare("SELECT * FROM stickers WHERE id = ? AND deleted_at IS NULL").get(id) as LarkStickerRow | undefined;
  if (!existing) return null;
  const name = patch.name === undefined ? existing.name : patch.name.trim().slice(0, 80);
  if (!name) throw new Error("表情包名称不能为空");
  const description = patch.description === undefined ? existing.description : patch.description.trim().slice(0, 300);
  const tags = patch.tags === undefined ? parseTags(existing.tags) : normalizeTags(patch.tags);
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  db.prepare("UPDATE stickers SET name = ?, description = ?, tags = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(name, description, JSON.stringify(tags), enabled, nowIso(), id);
  return publicSticker(db.prepare("SELECT * FROM stickers WHERE id = ?").get(id) as LarkStickerRow);
}

export function softDeleteLarkSticker(id: string): boolean {
  const timestamp = nowIso();
  return db.prepare("UPDATE stickers SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(timestamp, timestamp, id).changes > 0;
}

export function larkStickerImage(id: string): { path: string; mimeType: string } | null {
  const row = db.prepare("SELECT * FROM stickers WHERE id = ? AND deleted_at IS NULL").get(id) as LarkStickerRow | undefined;
  if (!row || path.basename(row.file_name) !== row.file_name) return null;
  const candidate = path.join(config.larkStickerDirectory, row.file_name);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return { path: candidate, mimeType: row.mime_type };
}

function stickerSearchTokens(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let index = 0; index + 1 < han.length; index += 1) tokens.push(`${han[index]}${han[index + 1]}`);
  return [...new Set(tokens)].slice(0, 30);
}

function stickerRelevance(sticker: LarkSticker, tokens: string[]): number {
  const name = sticker.name.toLowerCase();
  const description = sticker.description.toLowerCase();
  const tags = sticker.tags.map((tag) => tag.toLowerCase());
  return tokens.reduce((score, token) => {
    if (tags.some((tag) => tag === token)) return score + 8;
    if (name.includes(token)) return score + 5;
    if (tags.some((tag) => tag.includes(token) || token.includes(tag))) return score + 4;
    if (description.includes(token)) return score + 2;
    return score;
  }, 0);
}

function rankedLarkStickers(query: string): Array<{ sticker: LarkSticker; score: number }> {
  const tokens = stickerSearchTokens(query);
  return listLarkStickers(true)
    .map((sticker) => ({ sticker, score: stickerRelevance(sticker, tokens) }))
    .sort((left, right) => right.score - left.score || right.sticker.usageCount - left.sticker.usageCount || right.sticker.updatedAt.localeCompare(left.sticker.updatedAt));
}

const minimumStickerQueryScore = 4;

export function searchLarkStickers(query: string, limit = 3): LarkSticker[] {
  return rankedLarkStickers(query)
    .filter((entry) => entry.score >= minimumStickerQueryScore && larkStickerImage(entry.sticker.id))
    .slice(0, limit).map((entry) => entry.sticker);
}

export function resolveLarkStickerQuery(chatId: string | null, query: string): { id: string; score: number } | null {
  const ranked = rankedLarkStickers(query).filter((entry) => entry.score >= minimumStickerQueryScore);
  if (ranked.length === 0) return null;
  const recent = new Set(recentLarkStickerIds(chatId));
  const selected = ranked.find((entry) => !recent.has(entry.sticker.id)) ?? ranked[0]!;
  return { id: selected.sticker.id, score: selected.score };
}

function recentLarkStickerIds(chatId: string | null): string[] {
  return chatId
    ? (db.prepare("SELECT sticker_id FROM sticker_sends WHERE chat_id = ? ORDER BY id DESC LIMIT 5").all(chatId) as Array<{ sticker_id: string }>).map((row) => row.sticker_id)
    : [];
}

export function selectLarkStickerId(chatId: string | null, query = ""): string | null {
  return resolveLarkStickerQuery(chatId, query)?.id ?? null;
}

export function ensureLarkStickerSelection(answer: string, chatId: string | null, query = ""): string {
  const blocks = [...answer.matchAll(/<(?:lark|forge)-sticker>([\s\S]*?)<\/(?:lark|forge)-sticker>/gi)];
  if (blocks.length === 1) {
    try {
      const parsed = JSON.parse(blocks[0]![1]) as { id?: unknown; query?: unknown };
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const row = db.prepare("SELECT 1 FROM stickers WHERE id = ? AND enabled = 1 AND deleted_at IS NULL").get(id);
      if (row && larkStickerImage(id)) return answer;
      const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
      if (query.length >= 2 && query.length <= 120 && stickerSearchTokens(query).length > 0) return answer;
    } catch {
      // Replace malformed or stale selections with a valid fallback below.
    }
  }
  const text = answer.replace(/<(?:lark|forge)-sticker>[\s\S]*?<\/(?:lark|forge)-sticker>/gi, "").trim();
  return text;
}

export function larkStickerAcquisitionPrompt(): string {
  const addScript = path.join(config.repoRoot, "scripts", "add-sticker.mjs");
  return `表达资产扩充能力：
- 你可以自己获取并添加表情包，不必等人类先上传。用户明确要求新表情包、当前候选明显不贴切，或多次遇到同一种表达缺口时，可以主动扩充；不要每轮无脑加图。
- 先用可用的搜索或浏览工具找到允许公开访问的图片直链，或把自己生成的图片保存为本地文件。只添加 PNG、JPG、GIF、WEBP、BMP，单张不超过 2 MB，并保留真实来源。
- 网络图片：node ${JSON.stringify(addScript)} --url '<图片直链>' --name '<画面表达>' --description '<适用场景>' --tags '<标签1,标签2>'
- 本地图片：node ${JSON.stringify(addScript)} --file '<绝对路径>' --name '<画面表达>' --description '<适用场景>' --tags '<标签1,标签2>'
- 添加成功后会返回新的 stk_ ID。需要在本轮发送它时，把该 ID 写入最终答复的 lark-sticker 声明；不要伪造 ID，也不要添加重复、低清或与当前表达无关的素材。`;
}

export function larkStickerPrompt(contextToken?: string, options: { chatId?: string | null; usageMode?: LarkStickerUsageMode } = {}): string {
  const usageMode = options.usageMode ?? configuredLarkStickerUsageMode(options.chatId);
  if (usageMode === "off") return "表情包（已关闭）：本轮不要调用 lark_stickers MCP 的 search/select 表情工具，也不要发送表情包。";
  const policy = usageMode === "explicit"
      ? `表情包（仅明确请求）：
- 只有用户明确要求发送、查找或挑选表情包时，才调用 lark_stickers MCP 的 search/select 表情工具；其他回复只发送文字或用户要求的附件。`
      : usageMode === "always"
        ? `表情包（每次回复）：
- 每次准备产生可见的最终文字回复时，都必须调用 lark_stickers MCP 的 search，再调用 select 选择一张贴合本轮语气的表情包。
- 不要因为回答较正式、内容较短或文字已经足够完整而省略表情。只有最终决定不回复并输出 no-reply 标记时，才不调用表情工具。`
        : `表情包（自然使用）：
- 当回复主要用于情绪表达、接话或加强语气时，优先调用 lark_stickers MCP；交付事实、诊断或执行结果时按语境决定，不必每条配图。`;
  return `${policy}
- 你负责表达意图，服务端负责检索和匹配素材。
- 使用 search 搜索情绪或动作，查看返回的少量候选，再用 select 选择本轮的一张；不合适可以换关键词搜索。非“每次回复”模式下也可以不选。
- 本轮两个工具的 context_token 都必须使用 ${contextToken ?? "提示词中提供的本轮上下文令牌"}，不要沿用历史令牌，也不要向用户展示它。
- 无需知道素材标签、图片 ID 或提前确认候选存在。选择只是暂存，不是已发送；仍需给出最终文字，服务端在文字确认送达后发送表情。最终回复无需拼接表情标签。`;
}

export function stageLarkStickerSelection(answer: string, taskDir: string, chatId: string | null = null): { text: string; media: StagedLarkSticker[]; errors: string[]; stickerIds: string[] } {
  const blocks = [...answer.matchAll(/<(?:lark|forge)-sticker>([\s\S]*?)<\/(?:lark|forge)-sticker>/g)];
  let text = answer.replace(/<(?:lark|forge)-sticker>[\s\S]*?<\/(?:lark|forge)-sticker>/g, "").trim();
  const errors: string[] = [];
  const media: StagedLarkSticker[] = [];
  const stickerIds: string[] = [];
  if (blocks.length > 1) {
    errors.push("每次最多发送 1 个表情包");
    return { text, media, errors, stickerIds };
  }
  const block = blocks[0];
  if (!block) return { text, media, errors, stickerIds };
  let id = "";
  try {
    const parsed = JSON.parse(block[1]) as { id?: unknown; query?: unknown };
    id = typeof parsed.id === "string" ? parsed.id : "";
    if (!id) {
      const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
      if (query.length < 2 || query.length > 120) {
        errors.push("表情包检索词必须为 2 到 120 个字符");
        return { text, media, errors, stickerIds };
      }
      const resolved = resolveLarkStickerQuery(chatId, query);
      if (!resolved) {
        return { text, media, errors, stickerIds };
      }
      id = resolved.id;
    }
  } catch {
    errors.push("表情包声明不是有效 JSON");
    return { text, media, errors, stickerIds };
  }
  const row = db.prepare("SELECT * FROM stickers WHERE id = ? AND enabled = 1 AND deleted_at IS NULL").get(id) as LarkStickerRow | undefined;
  const source = row ? larkStickerImage(row.id) : null;
  if (!row || !source) {
    errors.push(`表情包不存在、已停用或文件缺失：${id || "unknown"}`);
    return { text, media, errors, stickerIds };
  }
  const outputDir = path.join(taskDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const extension = path.extname(row.file_name).toLowerCase();
  const destination = path.join(outputDir, `sticker-${row.id}${extension}`);
  fs.copyFileSync(source.path, destination);
  media.push({
    relativePath: path.relative(taskDir, destination),
    absolutePath: destination,
    kind: "image",
    size: fs.statSync(destination).size,
    stickerId: row.id
  });
  stickerIds.push(row.id);
  return { text, media, errors, stickerIds };
}

export function recordLarkStickerSend(stickerId: string, larkMessageId: number, chatId: string | null): void {
  db.transaction(() => {
    db.prepare("UPDATE stickers SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?").run(nowIso(), stickerId);
    db.prepare("INSERT INTO sticker_sends (sticker_id, lark_message_id, chat_id, created_at) VALUES (?, ?, ?, ?)")
      .run(stickerId, larkMessageId, chatId, nowIso());
  })();
}
