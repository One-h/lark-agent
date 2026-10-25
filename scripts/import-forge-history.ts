import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SqliteAgentStore } from "../packages/adapter-sqlite/src/index.js";

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) throw new Error("Usage: tsx scripts/import-forge-history.ts <forge.sqlite> <lark-agent.sqlite>");

const source = new Database(sourcePath, { readonly: true });
const target = new SqliteAgentStore(targetPath);

try {
  const copyCompatibleTable = (table: "lark_messages" | "lark_codex_sessions" | "lark_group_context_cursors" | "lark_execution_approvals") => {
    const sourceColumns = (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    const targetColumns = new Set((target.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    const columns = sourceColumns.filter((column) => targetColumns.has(column));
    const insert = target.db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const rows = source.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as Array<Record<string, unknown>>;
    target.db.transaction(() => rows.forEach((row) => insert.run(...columns.map((column) => row[column]))))();
    return rows.length;
  };
  const migratedState = {
    messages: copyCompatibleTable("lark_messages"),
    sessions: copyCompatibleTable("lark_codex_sessions"),
    cursors: copyCompatibleTable("lark_group_context_cursors"),
    approvals: copyCompatibleTable("lark_execution_approvals")
  };
  const settings = source.prepare("SELECT key, value, updated_at FROM app_settings WHERE key LIKE 'lark%' OR key LIKE 'prompt.lark%'").all() as Array<{ key: string; value: string; updated_at: string }>;
  const upsertSetting = target.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
  target.db.transaction(() => settings.forEach((setting) => upsertSetting.run(setting.key, setting.value, setting.updated_at)))();
  const contacts = source.prepare("SELECT open_id, name, aliases, enterprise_email, department, updated_at FROM lark_contacts").all() as Array<{ open_id: string; name: string; aliases: string; enterprise_email: string | null; department: string | null; updated_at: string }>;
  const upsertContact = target.db.prepare("INSERT INTO contacts (open_id, name, aliases, email, department, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(open_id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases, email=excluded.email, department=excluded.department, updated_at=excluded.updated_at");
  target.db.transaction(() => contacts.forEach((contact) => upsertContact.run(contact.open_id, contact.name, contact.aliases, contact.enterprise_email, contact.department, contact.updated_at)))();
  const sourceStickerDirectory = path.resolve(path.dirname(sourcePath), "../../../data/lark-stickers");
  const targetStickerDirectory = path.resolve(path.dirname(targetPath), "stickers");
  fs.mkdirSync(targetStickerDirectory, { recursive: true });
  const stickers = source.prepare("SELECT id, name, description, tags, file_name, mime_type, size_bytes, source_url, source_site, enabled, created_at, updated_at FROM lark_stickers WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string; description: string; tags: string; file_name: string; mime_type: string; size_bytes: number; source_url: string | null; source_site: string | null; enabled: number; created_at: string; updated_at: string }>;
  const upsertSticker = target.db.prepare("INSERT INTO stickers (id, name, description, tags, file_name, mime_type, size_bytes, source_url, source_site, enabled, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, tags=excluded.tags, enabled=excluded.enabled, local_path=excluded.local_path, updated_at=excluded.updated_at");
  target.db.transaction(() => stickers.forEach((sticker) => {
    const sourceFile = path.join(sourceStickerDirectory, path.basename(sticker.file_name));
    const targetFile = path.join(targetStickerDirectory, path.basename(sticker.file_name));
    if (fs.existsSync(sourceFile) && !fs.existsSync(targetFile)) fs.copyFileSync(sourceFile, targetFile);
    upsertSticker.run(sticker.id, sticker.name, sticker.description, sticker.tags, sticker.file_name, sticker.mime_type, sticker.size_bytes, sticker.source_url, sticker.source_site, sticker.enabled, targetFile, sticker.created_at, sticker.updated_at);
  }))();
  console.log(JSON.stringify({ sourceRows: migratedState.messages, imported: migratedState.messages, contacts: contacts.length, stickers: stickers.length, settings: settings.length, migratedState }));
} finally {
  source.close();
  target.close();
}
