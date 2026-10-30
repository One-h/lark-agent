import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime } from "./context.js";
import { attachmentToolPrompt, createReplyMarkdownAttachment, registerReplyAttachments, registeredReplyMedia, resolveReplyAttachment, validateRegisteredAttachment } from "./replyAttachments.js";
import { extractLarkReplyMedia, deliverLarkOutboxRow, retryPendingLarkTextReplies } from "./responder.js";

test("generated full Markdown attachments are idempotent and reject symlink or changed-file targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-generated-reply-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lark-generated-outside-"));
  try {
    const first = createReplyMarkdownAttachment(root, "# 完整结果\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    assert.deepEqual(createReplyMarkdownAttachment(root, fs.readFileSync(first.absolutePath, "utf8")), first);
    const original = fs.readFileSync(first.absolutePath, "utf8");
    const alternate = path.join(root, "output", "same-content.md");
    fs.writeFileSync(alternate, original); fs.unlinkSync(first.absolutePath); fs.symlinkSync(alternate, first.absolutePath);
    assert.throws(() => createReplyMarkdownAttachment(root, original), /校验失败/);
    assert.equal(fs.readFileSync(alternate, "utf8"), original);
    fs.unlinkSync(first.absolutePath); createReplyMarkdownAttachment(root, original);
    fs.writeFileSync(first.absolutePath, "tampered");
    assert.throws(() => createReplyMarkdownAttachment(root, "# 完整结果\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"), /校验失败/);
    fs.rmSync(path.join(root, "output", ".rendered"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "output", ".rendered"));
    assert.throws(() => createReplyMarkdownAttachment(root, "must stay inside"), /不安全/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-attachment-files-"));
  fs.mkdirSync(path.join(root, "output"));
  const context = { threadId: "thread", turnId: "turn", messageId: 1, taskDir: root };
  const write = (name: string, content = "fixture content") => fs.writeFileSync(path.join(root, "output", name), content);
  return { root, context, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function snapshotFiles(root: string): string[] {
  const directory = path.join(root, "output", ".attachments");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
}

test("source replacement at end of the read cannot copy outside bytes or leave rejected snapshots", () => {
  for (const replace of ["symlink", "in-place"]) {
    const f = fixture();
    f.write("report.csv", "original generated contents");
    const source = fs.realpathSync(path.join(f.root, "output", "report.csv"));
    const outside = path.join(f.root, "outside.csv"); fs.writeFileSync(outside, "private fixture must remain outside output");
    const open = fs.openSync, read = fs.readSync;
    let sourceFd: number | undefined, swapped = false;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (args[0] === source) sourceFd = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((...args: unknown[]) => {
      const count = Reflect.apply(read, fs, args);
      if (args[0] === sourceFd && count === 0 && !swapped) {
        swapped = true;
        if (replace === "symlink") { fs.unlinkSync(source); fs.symlinkSync(outside, source); }
        else fs.writeFileSync(source, "source changed after reading");
      }
      return count;
    }) as typeof fs.readSync;
    try {
      const result = registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context);
      assert.equal(swapped, true);
      assert.equal(result.result.success, false);
      assert.deepEqual(result.state.files, []);
      assert.deepEqual(snapshotFiles(f.root), []);
      assert.equal(fs.readFileSync(outside, "utf8"), "private fixture must remain outside output");
    } finally { fs.openSync = open; fs.readSync = read; f.close(); }
  }
});

test("failed batches and unsafe registration metadata remove only newly created snapshots", () => {
  const f = fixture();
  try {
    f.write("old.csv", "committed contents"); f.write("new.csv", "discarded contents");
    const first = registerReplyAttachments({ files: [{ path: "old.csv" }] }, f.context);
    assert.equal(first.result.success, true);
    const existing = snapshotFiles(f.root);
    const partial = registerReplyAttachments({ files: [{ path: "new.csv" }, { path: "missing.csv" }] }, f.context, first.state);
    assert.equal(partial.result.success, false); assert.deepEqual(partial.state, first.state);
    assert.deepEqual(snapshotFiles(f.root), existing);
    assert.equal(fs.readFileSync(existing[0], "utf8"), "committed contents");
    const outside = path.join(f.root, "outside.csv"); fs.writeFileSync(outside, "private fixture");
    const registration = path.join(f.root, "reply-attachments.json"); fs.unlinkSync(registration); fs.symlinkSync(outside, registration);
    const rejected = registerReplyAttachments({ files: [{ path: "new.csv" }] }, f.context, first.state);
    assert.equal(rejected.result.success, false); assert.deepEqual(rejected.state, first.state);
    assert.deepEqual(snapshotFiles(f.root), existing);
    assert.equal(fs.readFileSync(outside, "utf8"), "private fixture");
  } finally { f.close(); }
});

test("a partial snapshot write is removed before registration returns failure", () => {
  const f = fixture(); f.write("report.csv");
  const open = fs.openSync, write = fs.writeFileSync;
  let destinationFd: number | undefined;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]).includes(`${path.sep}.attachments${path.sep}`)) destinationFd = fd;
    return fd;
  }) as typeof fs.openSync;
  fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "number" && args[0] === destinationFd) {
      fs.writeSync(args[0], Buffer.from("partial"));
      throw Object.assign(new Error("fixture full storage"), { code: "ENOSPC" });
    }
    return write(...args);
  }) as typeof fs.writeFileSync;
  try {
    assert.equal(registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context).result.success, false);
    assert.deepEqual(snapshotFiles(f.root), []);
  } finally { fs.openSync = open; fs.writeFileSync = write; f.close(); }
});

test("a replaced snapshot parent and hard-linked files cannot escape attachment ownership", () => {
  const f = fixture();
  try {
    f.write("report.csv");
    const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const result = Reflect.apply(mkdir, fs, args);
      if (path.basename(String(args[0])) === ".attachments") {
        fs.renameSync(args[0], `${args[0]}-moved`); fs.symlinkSync(outside, args[0]);
      }
      return result;
    }) as typeof fs.mkdirSync;
    try { assert.equal(registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context).result.success, false); }
    finally { fs.mkdirSync = mkdir; }
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(f.root, "output", ".attachments"));
    fs.linkSync(path.join(f.root, "output", "report.csv"), path.join(outside, "linked.csv"));
    assert.equal(registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context).result.success, false);
  } finally { f.close(); }
});

test("attachment registration snapshots files, preserves names, deduplicates and binds the exact message/turn", () => {
  const f = fixture();
  try {
    f.write("report.csv", "id,value\n1,original\n"); f.write("image.png"); f.write("notes.md"); f.write("view.html");
    const first = registerReplyAttachments({ files: [{ path: "report.csv", name: "导出.csv" }, { path: "image.png" }] }, f.context);
    assert.equal(first.result.success, true); assert.equal(first.state.files.length, 2);
    const response = JSON.parse(first.result.contentItems[0].text);
    assert.equal(response.status, "staged"); assert.equal(response.sent, false);
    assert.equal(first.state.files[0].name, "导出.csv"); assert.equal(first.state.files[1].kind, "image");
    const same = registerReplyAttachments({ files: [{ path: "report.csv", name: "导出.csv" }] }, f.context, first.state);
    assert.deepEqual(same.state.files.map(file => file.id), first.state.files.map(file => file.id));
    f.write("report.csv", "changed source");
    assert.equal(fs.readFileSync(validateRegisteredAttachment(f.root, first.state.files[0]).absolutePath, "utf8"), "id,value\n1,original\n");
    const updated = registerReplyAttachments({ files: [{ path: "report.csv" }, { path: "notes.md" }, { path: "view.html" }] }, f.context, same.state);
    assert.equal(updated.state.files.length, 4); assert.notEqual(updated.state.files[0].id, first.state.files[0].id);
    assert.equal(fs.statSync(updated.state.files[0].absolutePath).mode & 0o777, 0o600);
    for (const changed of [{ messageId: 2 }, { turnId: "next" }, { threadId: "other" }]) assert.deepEqual(registeredReplyMedia(updated.state, { ...f.context, ...changed }), []);
    assert.equal(registerReplyAttachments({ files: [] }, f.context, updated.state).state.files.length, 0);
    assert.deepEqual(registerReplyAttachments({ files: [{ path: "notes.md" }] }, { ...f.context, turnId: "next" }, updated.state).state.files.map(file => file.name), ["notes.md"]);
  } finally { f.close(); }
});

test("unsafe paths, malformed arguments, size limits and partial failure cannot change a registered selection", () => {
  const f = fixture();
  try {
    f.write("ok.csv");
    fs.writeFileSync(path.join(f.root, "outside.csv"), "private");
    fs.symlinkSync(path.join(f.root, "outside.csv"), path.join(f.root, "output", "link.csv"));
    f.write("empty.csv", ""); f.write("big.png"); fs.truncateSync(path.join(f.root, "output", "big.png"), 10 * 1024 * 1024 + 1);
    f.write("big.csv"); fs.truncateSync(path.join(f.root, "output", "big.csv"), 50 * 1024 * 1024 + 1);
    const first = registerReplyAttachments({ files: [{ path: "ok.csv" }] }, f.context);
    for (const args of [
      { files: [{ path: "../outside.csv" }] }, { files: [{ path: path.join(f.root, "outside.csv") }] }, { files: [{ path: "link.csv" }] },
      { files: [{ path: "missing.csv" }] }, { files: [{ path: "empty.csv" }] }, { files: [{ path: "big.png" }] }, { files: [{ path: "big.csv" }] },
      { files: [{ path: "ok.csv", name: "../alias.csv" }] }, { files: [{ path: "ok.csv", name: "alias.png" }] },
      { files: [{ path: "ok.csv", recipient: "ou_other" }] }, { files: [{ path: "ok.csv" }], chat_id: "oc_other" },
      { files: Array.from({ length: 9 }, () => ({ path: "ok.csv" })) }, { files: [{ path: "ok.csv" }, { path: "missing.csv" }] }
    ]) {
      const result = registerReplyAttachments(args, f.context, first.state);
      assert.equal(result.result.success, false, JSON.stringify(args));
      assert.deepEqual(result.state, first.state);
    }
    for (let i = 1; i <= 8; i++) f.write(`${i}.csv`);
    assert.equal(registerReplyAttachments({ files: Array.from({ length: 8 }, (_, i) => ({ path: `${i + 1}.csv` })) }, f.context, first.state).result.success, false);
    const registrationFile = path.join(f.root, "reply-attachments.json"), outside = path.join(f.root, "outside.csv");
    fs.unlinkSync(registrationFile); fs.symlinkSync(outside, registrationFile);
    assert.equal(registerReplyAttachments({ files: [] }, f.context, first.state).result.success, false);
    assert.equal(fs.readFileSync(outside, "utf8"), "private");
    fs.unlinkSync(registrationFile); fs.linkSync(outside, registrationFile);
    assert.equal(registerReplyAttachments({ files: [] }, f.context, first.state).result.success, false);
    assert.equal(fs.readFileSync(outside, "utf8"), "private"); fs.unlinkSync(registrationFile);
    const other = path.join(f.root, "other"); fs.mkdirSync(other);
    fs.rmSync(path.join(f.root, "output", ".attachments"), { recursive: true });
    fs.symlinkSync(other, path.join(f.root, "output", ".attachments"));
    assert.equal(registerReplyAttachments({ files: [{ path: "ok.csv" }] }, f.context).result.success, false);
    assert.deepEqual(fs.readdirSync(other), []);
  } finally { f.close(); }
});

test("structured attachments and legacy declarations share validation without duplicate sends or raw malformed tags", () => {
  const f = fixture(); const store = new SqliteAgentStore(path.join(f.root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: f.root, larkStickerDirectory: f.root });
  try {
    f.write("report.csv");
    const selected = registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context);
    const combined = extractLarkReplyMedia('已准备。<lark-media>{"files":[{"path":"report.csv"}]}</lark-media>', f.root, null, selected.state.files);
    assert.equal(combined.media.length, 1); assert.equal(combined.text, "已准备。"); assert.deepEqual(combined.errors, []);
    assert.equal(extractLarkReplyMedia('<lark-media>{"files":[{"path":"report.csv"}]}</lark-media>', f.root, null, []).media.length, 0);
    assert.equal(extractLarkReplyMedia('<lark-media>{"files":[{"path":"report.csv"}]}</lark_media', f.root, null, selected.state.files).media.length, 1);
    const old = extractLarkReplyMedia('<forge-media>{"files":[{"path":"report.csv"}]}</forge-media>', f.root);
    assert.equal(old.media.length, 1);
    const partial = extractLarkReplyMedia('<lark-media>{"files":[{"path":"missing.csv"},{"path":"report.csv"}]}</lark-media>', f.root);
    assert.equal(partial.media.length, 1); assert.equal(partial.errors.length, 1);
    const bad = extractLarkReplyMedia('已导出。<lark-media>{"files":[{"path":"report.csv"}]}</lark_media', f.root);
    assert.equal(bad.media.length, 0); assert.equal(bad.text, "已导出。"); assert.equal(bad.errors.length, 1);
    fs.writeFileSync(selected.state.files[0].absolutePath, "tampered");
    assert.throws(() => validateRegisteredAttachment(f.root, selected.state.files[0]), /发生变化/);
    assert.equal(extractLarkReplyMedia("已准备", f.root, null, selected.state.files).errors.length, 1);
    assert.match(attachmentToolPrompt("a".repeat(32), path.join(f.root, "output")), /attach_files/);
    assert.doesNotMatch(attachmentToolPrompt("a".repeat(32), path.join(f.root, "output")), /<lark-media>/);
  } finally { store.close(); f.close(); }
});

test("registered file delivery survives store reopen and reports terminal integrity failure once", () => {
  const f = fixture(); const databasePath = path.join(f.root, "test.sqlite"); let store = new SqliteAgentStore(databasePath);
  const notices: string[] = [];
  const configure = () => configureConversationRuntime({ database: store.db, mode: "active", repoRoot: f.root, larkStickerDirectory: f.root,
    textReplySender: (_id, text) => { notices.push(text); return { ok: true, messageId: `om_notice_${notices.length}`, chatId: "oc_fixture", messageAt: null, messageType: "text" }; } });
  configure();
  try {
    f.write("report.csv"); const selected = registerReplyAttachments({ files: [{ path: "report.csv" }] }, f.context).state.files[0];
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,codex_turn_id,reply_status,reply_delivery_key,raw_json,received_at,created_at) VALUES(1,'om_fixture','oc_fixture','p2p','turn','pending','final','{}',?,?)").run(now, now);
    const payload = JSON.stringify({ messageId: "om_fixture", taskDir: f.root, paths: [selected.relativePath], turnId: "turn", afterTextKey: "final", expectedFiles: [{ path: selected.relativePath, sha256: selected.sha256 }] });
    store.db.prepare("INSERT INTO lark_delivery_outbox(id,lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at) VALUES(1,1,'media',?,'file-key',?,?)").run(payload, now, now);
    const row = { id: 1, lark_message_id: 1, kind: "media" as const, payload, idempotency_key: "file-key", attempts: 0 };
    let sends = 0; const send = () => { sends++; return { ok: true as const }; };
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 0); assert.equal(sends, 0);
    store.close(); store = new SqliteAgentStore(databasePath); configure();
    store.db.prepare("UPDATE lark_messages SET reply_status='sent',reply_sent_at=? WHERE id=1").run(now);
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 1); assert.equal(deliverLarkOutboxRow(row, send).sentCount, 0); assert.equal(sends, 1);
    store.db.prepare("UPDATE lark_delivery_outbox SET status='pending' WHERE id=1").run();
    fs.writeFileSync(selected.absolutePath, "changed snapshot");
    store.db.exec("CREATE TRIGGER reject_attachment_notice BEFORE INSERT ON lark_delivery_outbox WHEN NEW.kind='media-notice' BEGIN SELECT RAISE(FAIL,'fixture full storage'); END;");
    assert.throws(() => deliverLarkOutboxRow(row, send), /fixture full storage/);
    assert.equal((store.db.prepare("SELECT status FROM lark_delivery_outbox WHERE id=1").get() as { status: string }).status, "pending");
    store.db.exec("DROP TRIGGER reject_attachment_notice");
    assert.equal(deliverLarkOutboxRow(row, send).ok, false); assert.equal(sends, 1);
    assert.equal((store.db.prepare("SELECT count(*) n FROM lark_delivery_outbox WHERE kind='media-notice'").get() as { n: number }).n, 1);
    retryPendingLarkTextReplies(); retryPendingLarkTextReplies(); assert.equal(notices.length, 1);
    assert.match(notices[0], /未能送达/);
  } finally { store.close(); f.close(); }
});
