import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { createRuntime } from "./index.js";
import { replaceStickersFromBundle } from "./stickerBundleImport.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-import-"));
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(bundle);
  const first = "stk_aaaaaaaaaaaaaaaa.png";
  const second = "stk_bbbbbbbbbbbbbbbb.gif";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const gif = Buffer.from("GIF89a12345", "ascii");
  const now = "2026-09-16T00:00:00.000Z";
  const rows = [
    ["stk_aaaaaaaaaaaaaaaa", "开心", "开心表情", "开心、庆祝", first, "image/png", String(png.length), "", "", "启用", "3", now, now],
    ["stk_bbbbbbbbbbbbbbbb", "稍等", "等待表情", "等待", second, "image/gif", String(gif.length), "", "", "停用", "0", now, now]
  ];
  const header = ["表情 ID", "名称", "标注说明", "标签", "素材文件", "格式", "大小（字节）", "来源链接", "来源站点", "状态", "使用次数", "创建时间", "更新时间"];
  fs.writeFileSync(path.join(bundle, "lark-sticker-manifest.csv"), [header, ...rows].map((row) => row.map((value) => `"${value}"`).join(",")).join("\n"));
  fs.writeFileSync(path.join(bundle, "lark-sticker-assets-part-01-of-01.zip"), zipSync({ [first]: png, [second]: gif }));
  const databasePath = path.join(root, "agent.sqlite");
  const store = new SqliteAgentStore(databasePath);
  const oldDirectory = path.join(root, "stickers");
  fs.mkdirSync(oldDirectory);
  fs.writeFileSync(path.join(oldDirectory, "old.png"), png);
  store.db.prepare("INSERT INTO stickers (id,name,description,tags,file_name,mime_type,size_bytes,enabled,local_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("stk_old", "old", "old", "[]", "old.png", "image/png", png.length, 1, path.join(oldDirectory, "old.png"), now, now);
  return { root, bundle, databasePath, store };
}

test("bundle replacement preserves annotations, backs up the old database and removes old assets", async () => {
  const { root, bundle, databasePath, store } = fixture();
  try {
    const result = await replaceStickersFromBundle({ db: store.db, databasePath, bundleDirectory: bundle, ensureIdle: () => {} });
    assert.deepEqual({ imported: result.imported, enabled: result.enabled, removed: result.removed, oldFilesRemoved: result.oldFilesRemoved },
      { imported: 2, enabled: 1, removed: 1, oldFilesRemoved: true });
    const rows = store.db.prepare("SELECT id,name,description,tags,enabled,usage_count,local_path FROM stickers ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.id), ["stk_aaaaaaaaaaaaaaaa", "stk_bbbbbbbbbbbbbbbb"]);
    assert.deepEqual(JSON.parse(String(rows[0].tags)), ["开心", "庆祝"]);
    assert.equal(rows[0].usage_count, 3);
    assert.equal(rows[1].enabled, 0);
    assert.equal(fs.existsSync(String(rows[0].local_path)), true);
    assert.equal(fs.existsSync(path.join(root, "stickers", "old.png")), false);
    const backup = new Database(result.backupPath, { readonly: true });
    try { assert.equal((backup.prepare("SELECT count(*) AS count FROM stickers").get() as { count: number }).count, 1); }
    finally { backup.close(); }
    const repeated = await replaceStickersFromBundle({ db: store.db, databasePath, bundleDirectory: bundle, ensureIdle: () => {} });
    assert.equal(repeated.alreadyApplied, true);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an incomplete bundle leaves the existing sticker library unchanged", async () => {
  const { root, bundle, databasePath, store } = fixture();
  try {
    fs.writeFileSync(path.join(bundle, "lark-sticker-assets-part-01-of-01.zip"), zipSync({ "stk_aaaaaaaaaaaaaaaa.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) }));
    await assert.rejects(replaceStickersFromBundle({ db: store.db, databasePath, bundleDirectory: bundle, ensureIdle: () => {} }), /Incomplete sticker bundle/);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM stickers").get() as { count: number }).count, 1);
    assert.equal(fs.existsSync(path.join(root, "stickers", "old.png")), true);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("bundle replacement route requires the runtime token", async () => {
  const { root, bundle, databasePath, store } = fixture();
  store.close();
  const runtime = createRuntime({ databasePath, mode: "shadow", trustedSenderIds: [], runtimeToken: "secret" });
  try {
    const url = "/v1/stickers/replace-from-bundle";
    assert.equal((await runtime.app.inject({ method: "POST", url, payload: { bundleDirectory: bundle } })).statusCode, 403);
    const response = await runtime.app.inject({ method: "POST", url, headers: { authorization: "Bearer secret" }, payload: { bundleDirectory: bundle } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().imported, 2);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a full external bundle imports into a new isolated database", { skip: !process.env.LARK_STICKER_BUNDLE_DIR }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-bundle-e2e-"));
  const databasePath = path.join(root, "agent.sqlite");
  const store = new SqliteAgentStore(databasePath);
  try {
    const result = await replaceStickersFromBundle({
      db: store.db, databasePath, bundleDirectory: process.env.LARK_STICKER_BUNDLE_DIR!, ensureIdle: () => {}
    });
    assert.equal(result.imported, 1745);
    assert.equal(result.enabled, 1744);
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM stickers").get() as { count: number }).count, result.imported);
    assert.equal(fs.readdirSync(path.join(root, "stickers")).length, result.imported);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
