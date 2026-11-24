import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { larkCodexAppServerStatus } from "@lark-agent/conversation-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { replaceStickersFromBundle } from "../stickerBundleImport.js";

const stickerColumns = "id, name, description, tags, file_name AS fileName, mime_type AS mimeType, size_bytes AS sizeBytes, source_url AS sourceUrl, source_site AS sourceSite, enabled, created_at AS createdAt, updated_at AS updatedAt";

export function mountStickerLibraryPlugin({ app, store, dataDirectory, authenticated, hasRuntimeToken }: {
  app: FastifyInstance;
  store: SqliteAgentStore;
  dataDirectory: string;
  authenticated: (request: FastifyRequest) => boolean;
  hasRuntimeToken: boolean;
}): void {
  const databasePath = store.db.name;
  // Keep persisted asset paths relative when the runtime database path is relative.
  const stickerDirectory = path.join(path.isAbsolute(databasePath) ? dataDirectory : path.dirname(databasePath), "stickers");
  let stickerImportRunning = false;

  app.get("/v1/stickers", async () => (store.db.prepare(`SELECT ${stickerColumns} FROM stickers ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>)
    .map((sticker) => ({ ...sticker, tags: JSON.parse(String(sticker.tags ?? "[]")), imageUrl: `/v1/stickers/${encodeURIComponent(String(sticker.id))}/image` })));

  app.post("/v1/stickers/replace-from-bundle", async (request, reply) => {
    if (!hasRuntimeToken || !authenticated(request) || !["127.0.0.1", "::1"].includes(request.ip)) {
      return reply.code(403).send({ code: "STICKER_IMPORT_FORBIDDEN", message: "Local runtime token required" });
    }
    const directory = (request.body as { bundleDirectory?: unknown } | null)?.bundleDirectory;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 1000) {
      return reply.code(400).send({ code: "INVALID_STICKER_BUNDLE", message: "An absolute bundle directory is required" });
    }
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE", message: "A sticker import is already running" });
    stickerImportRunning = true;
    try {
      return await replaceStickersFromBundle({
        db: store.db, databasePath, bundleDirectory: directory,
        ensureIdle: () => { if (larkCodexAppServerStatus().activeTurns > 0) throw new Error("Wait for active Codex turns before replacing stickers"); }
      });
    } catch (error) {
      return reply.code(409).send({ code: "STICKER_IMPORT_FAILED", message: error instanceof Error ? error.message : String(error) });
    } finally { stickerImportRunning = false; }
  });

  app.post("/v1/stickers/batch", async (request, reply) => {
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" });
    const payload = request.body as { files?: Array<{ name?: string; description?: string; tags?: string[]; fileName?: string; mimeType?: string; dataBase64?: string; sourceUrl?: string; sourceSite?: string }> };
    const files = payload.files ?? [];
    if (files.length < 1 || files.length > 50) return reply.code(400).send({ error: "files must contain 1-50 stickers" });
    mkdirSync(stickerDirectory, { recursive: true });
    const insert = store.db.prepare("INSERT INTO stickers (id, name, description, tags, file_name, mime_type, size_bytes, source_url, source_site, enabled, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)");
    const created: string[] = [];
    const now = new Date().toISOString();
    store.db.transaction(() => files.forEach((file) => {
      if (!file.dataBase64 || !file.fileName || !file.mimeType) throw new Error("sticker file metadata is required");
      const bytes = Buffer.from(file.dataBase64, "base64");
      if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error("sticker file must be 1B-2MB");
      const id = `stk_${randomBytes(8).toString("hex")}`;
      const name = (file.name ?? path.basename(file.fileName, path.extname(file.fileName))).trim().slice(0, 80);
      if (!name) throw new Error("sticker name is required");
      const storedName = `${id}${path.extname(file.fileName).toLowerCase()}`;
      const storedPath = path.join(stickerDirectory, storedName);
      writeFileSync(storedPath, bytes);
      insert.run(id, name, (file.description ?? "").trim().slice(0, 300), JSON.stringify((file.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12)), storedName, file.mimeType, bytes.length, file.sourceUrl ?? null, file.sourceSite ?? null, storedPath, now, now);
      created.push(id);
    }))();
    return reply.code(201).send((store.db.prepare(`SELECT ${stickerColumns} FROM stickers WHERE id IN (${created.map(() => "?").join(",")})`).all(...created) as Array<Record<string, unknown>>)
      .map((sticker) => ({ ...sticker, tags: JSON.parse(String(sticker.tags)), imageUrl: `/v1/stickers/${encodeURIComponent(String(sticker.id))}/image` })));
  });

  app.patch("/v1/stickers/:id", async (request, reply) => {
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" });
    const patch = request.body as { name?: string; description?: string; tags?: string[]; enabled?: boolean };
    const existing = store.db.prepare("SELECT * FROM stickers WHERE id=?").get((request.params as { id: string }).id) as Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: "not found" });
    const name = patch.name === undefined ? String(existing.name) : patch.name.trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: "name is required" });
    store.db.prepare("UPDATE stickers SET name=?, description=?, tags=?, enabled=?, updated_at=? WHERE id=?").run(name, patch.description === undefined ? existing.description : patch.description.trim().slice(0, 300), patch.tags === undefined ? existing.tags : JSON.stringify(patch.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12)), patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0, new Date().toISOString(), existing.id);
    return store.db.prepare(`SELECT ${stickerColumns} FROM stickers WHERE id=?`).get(existing.id);
  });

  app.delete("/v1/stickers/:id", async (request, reply) => {
    if (stickerImportRunning) return reply.code(409).send({ code: "STICKER_IMPORT_ACTIVE" });
    const changed = store.db.prepare("UPDATE stickers SET enabled=0, updated_at=? WHERE id=?").run(new Date().toISOString(), (request.params as { id: string }).id).changes;
    return changed ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
  });

  app.get("/v1/stickers/:id/image", async (request, reply) => {
    const sticker = store.db.prepare("SELECT local_path, mime_type FROM stickers WHERE id=? AND enabled=1").get((request.params as { id: string }).id) as { local_path?: string; mime_type?: string } | undefined;
    if (!sticker?.local_path || !existsSync(sticker.local_path)) return reply.code(404).send({ error: "not found" });
    return reply.type(sticker.mime_type ?? "application/octet-stream").send(readFileSync(sticker.local_path));
  });
}
