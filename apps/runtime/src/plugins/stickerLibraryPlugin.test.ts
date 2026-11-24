import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import Fastify from "fastify";
import { zipSync } from "fflate";
import { mountStickerLibraryPlugin } from "./stickerLibraryPlugin.js";

const baseUrl = "/v1/stickers";
const replaceUrl = `${baseUrl}/replace-from-bundle`;
const headers = { authorization: "Bearer fixture-token" };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const upload = { files: [{ fileName: "Sample.PNG", mimeType: "image/png", dataBase64: png.toString("base64"), tags: [" hi ", ""] }] };

function fixture(t: TestContext, { hasRuntimeToken = true, relativeDatabasePath = false } = {}) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "lark-sticker-library-plugin-"));
  const databasePath = path.join(dataDirectory, "fixture.sqlite");
  const store = new SqliteAgentStore(relativeDatabasePath ? path.relative(process.cwd(), databasePath) : databasePath);
  const app = Fastify();
  t.after(async () => {
    try { await app.close(); }
    finally {
      store.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
  mountStickerLibraryPlugin({ app, store, dataDirectory, hasRuntimeToken,
    authenticated: request => !hasRuntimeToken || request.headers.authorization === headers.authorization });
  return { app, store, dataDirectory };
}

test("sticker library preserves the batch, list, patch, image and soft-delete contracts", async t => {
  const { app, store, dataDirectory } = fixture(t, { relativeDatabasePath: true });
  assert.deepEqual((await app.inject(baseUrl)).json(), []);
  const invalid = await app.inject({ method: "POST", url: `${baseUrl}/batch`, payload: { files: [] } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: "files must contain 1-50 stickers" });

  const batch = await app.inject({ method: "POST", url: `${baseUrl}/batch`, payload: upload });
  assert.equal(batch.statusCode, 201);
  const [item] = batch.json();
  assert.match(item.id, /^stk_[a-f0-9]{16}$/);
  assert.deepEqual(item, {
    id: item.id, name: "Sample", description: "", tags: ["hi"], fileName: `${item.id}.png`,
    mimeType: "image/png", sizeBytes: png.length, sourceUrl: null, sourceSite: null, enabled: 1,
    createdAt: item.createdAt, updatedAt: item.createdAt, imageUrl: `${baseUrl}/${item.id}/image`
  });
  assert.deepEqual((await app.inject(baseUrl)).json(), [item]);
  const image = await app.inject(item.imageUrl);
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.deepEqual(image.rawPayload, png);

  const itemUrl = `${baseUrl}/${item.id}`;
  const blankName = await app.inject({ method: "PATCH", url: itemUrl, payload: { name: " " } });
  assert.equal(blankName.statusCode, 400);
  assert.deepEqual(blankName.json(), { error: "name is required" });
  const patch = await app.inject({ method: "PATCH", url: itemUrl, payload: { tags: [" new ", ""] } });
  assert.equal(patch.statusCode, 200);
  const { imageUrl, ...row } = item;
  assert.deepEqual(patch.json(), { ...row, tags: '["new"]', updatedAt: patch.json().updatedAt });
  assert.equal((await app.inject({ method: "DELETE", url: itemUrl })).statusCode, 204);
  assert.equal((await app.inject(imageUrl)).statusCode, 404);
  assert.equal((await app.inject(baseUrl)).json()[0].enabled, 0);
  const localPath = path.join(dataDirectory, "stickers", item.fileName);
  assert.equal(store.db.prepare("SELECT local_path FROM stickers WHERE id=?").pluck().get(item.id), path.relative(process.cwd(), localPath));
  assert.equal(existsSync(localPath), true);
  assert.equal((await app.inject({ method: "DELETE", url: `${baseUrl}/missing` })).statusCode, 404);
});

test("bundle replacement rejects a tokenless runtime even on loopback", async t => {
  const { app, dataDirectory } = fixture(t, { hasRuntimeToken: false });
  const response = await app.inject({ method: "POST", url: replaceUrl, headers, payload: { bundleDirectory: dataDirectory } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { code: "STICKER_IMPORT_FORBIDDEN", message: "Local runtime token required" });
});

test("bundle replacement preserves authorization, path validation, and the import write lock", async t => {
  const { app, store, dataDirectory } = fixture(t);
  const bundleDirectory = path.join(dataDirectory, "bundle");
  const payload = { bundleDirectory };
  for (const options of [{}, { headers, remoteAddress: "192.0.2.1" }, { headers, remoteAddress: "::ffff:127.0.0.1" }]) {
    const response = await app.inject({ method: "POST", url: replaceUrl, payload, ...options });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "STICKER_IMPORT_FORBIDDEN");
  }
  const invalid = await app.inject({ method: "POST", url: replaceUrl, remoteAddress: "::1", headers, payload: { bundleDirectory: "relative" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "INVALID_STICKER_BUNDLE");
  const missing = await app.inject({ method: "POST", url: replaceUrl, headers, payload });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().code, "STICKER_IMPORT_FAILED");

  const batch = await app.inject({ method: "POST", url: `${baseUrl}/batch`, payload: upload });
  assert.equal(batch.statusCode, 201);
  const [oldItem] = batch.json();
  mkdirSync(bundleDirectory);
  const id = "stk_aaaaaaaaaaaaaaaa";
  const fileName = `${id}.png`;
  writeFileSync(path.join(bundleDirectory, "lark-sticker-manifest.csv"), [
    "表情 ID,名称,标注说明,标签,素材文件,格式,大小（字节）,来源链接,来源站点,状态,使用次数,创建时间,更新时间",
    [id, "New", "Fixture", "", fileName, "image/png", png.length, "", "", "启用", 0, oldItem.createdAt, oldItem.updatedAt].join(",")
  ].join("\n"));
  writeFileSync(path.join(bundleDirectory, "lark-sticker-assets-part-01-of-01.zip"), zipSync({ [fileName]: png }));
  let signalBackupStarted!: () => void;
  let releaseBackup!: () => void;
  const backupStarted = new Promise<void>(resolve => { signalBackupStarted = resolve; });
  const backupBarrier = new Promise<void>(resolve => { releaseBackup = resolve; });
  const backup = store.db.backup.bind(store.db);
  t.mock.method(store.db, "backup", async (destination: string) => {
    signalBackupStarted();
    await backupBarrier;
    return backup(destination);
  });

  const importing = app.inject({ method: "POST", url: replaceUrl, headers, payload });
  try {
    assert.equal(await Promise.race([backupStarted.then(() => "backup"), importing.then(response => response.body)]), "backup");
    const busy = await app.inject({ method: "POST", url: replaceUrl, headers, payload });
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), { code: "STICKER_IMPORT_ACTIVE", message: "A sticker import is already running" });
    const itemUrl = `${baseUrl}/${oldItem.id}`;
    for (const options of [
      { method: "POST", url: `${baseUrl}/batch`, payload: upload },
      { method: "PATCH", url: itemUrl, payload: { name: "Blocked" } },
      { method: "DELETE", url: itemUrl }
    ] as const) {
      const response = await app.inject(options);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { code: "STICKER_IMPORT_ACTIVE" });
    }
    assert.deepEqual((await app.inject(baseUrl)).json(), [oldItem]);
    assert.equal((await app.inject(oldItem.imageUrl)).statusCode, 200);
  } finally {
    releaseBackup();
    await importing;
  }
  const replaced = await importing;
  assert.equal(replaced.statusCode, 200);
  const result = replaced.json();
  assert.deepEqual(result, { imported: 1, enabled: 1, removed: 1, backupPath: result.backupPath, oldFilesRemoved: true });
  assert.equal(existsSync(result.backupPath), true);
  assert.equal((await app.inject(oldItem.imageUrl)).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `${baseUrl}/${id}` })).statusCode, 204);
});
