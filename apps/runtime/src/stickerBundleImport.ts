import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import { detectStickerImage } from "@lark-agent/conversation-runtime";

type StickerRow = {
  id: string;
  name: string;
  description: string;
  tags: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string | null;
  sourceSite: string | null;
  enabled: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
};

export type StickerImportResult = {
  imported: number;
  enabled: number;
  removed: number;
  backupPath: string;
  oldFilesRemoved: boolean;
  cleanupPath?: string;
  alreadyApplied?: boolean;
};

function parseManifest(buffer: Buffer): { rows: StickerRow[]; byFile: Map<string, StickerRow> } {
  const records = parse(buffer, { columns: true, bom: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  if (records.length === 0) throw new Error("The sticker manifest is empty");
  const byFile = new Map<string, StickerRow>();
  const ids = new Set<string>();
  const rows = records.map((record) => {
    const id = record["表情 ID"]?.trim();
    const fileName = record["素材文件"]?.trim();
    const name = record["名称"]?.trim();
    const description = record["标注说明"]?.trim();
    const mimeType = record["格式"]?.trim();
    const sizeBytes = Number(record["大小（字节）"]);
    const usageCount = Number(record["使用次数"]);
    const enabled = record["状态"] === "启用" ? 1 : record["状态"] === "停用" ? 0 : -1;
    const createdAt = record["创建时间"];
    const updatedAt = record["更新时间"];
    if (!/^stk_[a-f0-9]{16}$/.test(id) || !new RegExp(`^${id}\\.(?:jpg|jpeg|png|gif|webp)$`).test(fileName)
      || !name || name.length > 80 || !description || description.length > 300
      || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 2 * 1024 * 1024
      || !Number.isSafeInteger(usageCount) || usageCount < 0 || enabled < 0
      || !createdAt || Number.isNaN(Date.parse(createdAt)) || !updatedAt || Number.isNaN(Date.parse(updatedAt))
      || ids.has(id) || byFile.has(fileName)) throw new Error(`Invalid sticker manifest entry: ${id || fileName || "unknown"}`);
    const tags = [...new Set((record["标签"] ?? "").split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length > 12) throw new Error(`Too many tags for ${id}`);
    const row: StickerRow = {
      id, name, description, tags: JSON.stringify(tags), fileName, mimeType, sizeBytes,
      sourceUrl: record["来源链接"]?.trim() || null,
      sourceSite: record["来源站点"]?.trim() || null,
      enabled, usageCount, createdAt, updatedAt, contentHash: ""
    };
    ids.add(id);
    byFile.set(fileName, row);
    return row;
  });
  return { rows, byFile };
}

function archiveParts(directory: string): string[] {
  const groups = new Map<number, Map<number, string>>();
  for (const name of fs.readdirSync(directory)) {
    const match = /^lark-sticker-assets-part-(\d+)-of-(\d+)\.zip$/.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (index < 1 || index > total || total > 100) continue;
    const group = groups.get(total) ?? new Map<number, string>();
    group.set(index, path.join(directory, name));
    groups.set(total, group);
  }
  const complete = [...groups.entries()].filter(([total, parts]) => parts.size === total && Array.from({ length: total }, (_, index) => parts.has(index + 1)).every(Boolean));
  if (complete.length === 0) throw new Error("No complete sticker archive set was found");
  const [total, parts] = complete.sort((left, right) => right[0] - left[0])[0];
  return Array.from({ length: total }, (_, index) => parts.get(index + 1)!);
}

function stageBundle(bundleDirectory: string, stagingDirectory: string, byFile: Map<string, StickerRow>): void {
  const seen = new Set<string>();
  const hashes = new Set<string>();
  for (const archive of archiveParts(bundleDirectory)) {
    const files = unzipSync(new Uint8Array(fs.readFileSync(archive)));
    for (const [fileName, bytes] of Object.entries(files)) {
      const row = byFile.get(fileName);
      if (!row || seen.has(fileName) || path.basename(fileName) !== fileName) throw new Error(`Unexpected or duplicate sticker asset: ${fileName}`);
      const buffer = Buffer.from(bytes);
      const detected = detectStickerImage(buffer);
      if (buffer.length !== row.sizeBytes || detected?.mimeType !== row.mimeType) throw new Error(`Sticker asset does not match manifest: ${fileName}`);
      row.contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (hashes.has(row.contentHash)) throw new Error(`Duplicate sticker image content: ${fileName}`);
      hashes.add(row.contentHash);
      fs.writeFileSync(path.join(stagingDirectory, fileName), buffer, { mode: 0o600, flag: "wx" });
      seen.add(fileName);
    }
  }
  if (seen.size !== byFile.size) throw new Error(`Incomplete sticker bundle: ${seen.size}/${byFile.size} assets`);
}

export async function replaceStickersFromBundle(args: {
  db: Database.Database;
  databasePath: string;
  bundleDirectory: string;
  ensureIdle: () => void;
}): Promise<StickerImportResult> {
  const { db, databasePath, ensureIdle } = args;
  const bundleDirectory = fs.realpathSync(args.bundleDirectory);
  if (!fs.statSync(bundleDirectory).isDirectory()) throw new Error("Sticker bundle path is not a directory");
  const manifest = fs.readFileSync(path.join(bundleDirectory, "lark-sticker-manifest.csv"));
  const manifestHash = crypto.createHash("sha256").update(manifest).digest("hex");
  const { rows, byFile } = parseManifest(manifest);
  const stickerDirectory = path.join(path.dirname(databasePath), "stickers");
  const prior = db.prepare("SELECT value FROM settings WHERE key='stickers.bundleHash'").get() as { value: string } | undefined;
  if (prior?.value === manifestHash && (db.prepare("SELECT count(*) AS count FROM stickers").get() as { count: number }).count === rows.length) {
    return { imported: rows.length, enabled: rows.filter((row) => row.enabled).length, removed: 0, backupPath: "", oldFilesRemoved: true, alreadyApplied: true };
  }
  ensureIdle();
  const stagingDirectory = fs.mkdtempSync(path.join(path.dirname(databasePath), ".stickers-import-"));
  let movedOld = false;
  let movedNew = false;
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const oldDirectory = path.join(path.dirname(databasePath), `.stickers-before-${stamp}`);
  const backupDirectory = path.join(path.dirname(databasePath), "backups");
  const backupPath = path.join(backupDirectory, `stickers-before-${stamp}.sqlite`);
  try {
    stageBundle(bundleDirectory, stagingDirectory, byFile);
    fs.mkdirSync(backupDirectory, { recursive: true });
    await db.backup(backupPath);
    const backup = new Database(backupPath, { readonly: true });
    try {
      if ((backup.pragma("integrity_check", { simple: true }) as string) !== "ok") throw new Error("Sticker database backup failed integrity check");
    } finally { backup.close(); }
    ensureIdle();
    const removed = (db.prepare("SELECT count(*) AS count FROM stickers").get() as { count: number }).count;
    try {
      if (fs.existsSync(stickerDirectory)) { fs.renameSync(stickerDirectory, oldDirectory); movedOld = true; }
      fs.renameSync(stagingDirectory, stickerDirectory);
      movedNew = true;
      const insert = db.prepare(`INSERT INTO stickers
        (id,name,description,tags,file_name,mime_type,size_bytes,source_url,source_site,enabled,usage_count,content_hash,local_path,created_at,updated_at,deleted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
      db.transaction(() => {
        db.prepare("DELETE FROM stickers").run();
        for (const row of rows) insert.run(row.id, row.name, row.description, row.tags, row.fileName, row.mimeType,
          row.sizeBytes, row.sourceUrl, row.sourceSite, row.enabled, row.usageCount, row.contentHash,
          path.join(stickerDirectory, row.fileName), row.createdAt, row.updatedAt);
        db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('stickers.bundleHash',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
          .run(manifestHash, new Date().toISOString());
      })();
    } catch (error) {
      if (movedNew) fs.renameSync(stickerDirectory, stagingDirectory);
      if (movedOld) fs.renameSync(oldDirectory, stickerDirectory);
      throw error;
    }
    let oldFilesRemoved = true;
    if (movedOld) {
      try { await fs.promises.rm(oldDirectory, { recursive: true }); }
      catch { oldFilesRemoved = false; }
    }
    return { imported: rows.length, enabled: rows.filter((row) => row.enabled).length, removed,
      backupPath, oldFilesRemoved, ...(oldFilesRemoved ? {} : { cleanupPath: oldDirectory }) };
  } finally {
    if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
