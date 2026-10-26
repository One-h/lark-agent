import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime } from "./context.js";
import { attachmentToolPrompt, registerReplyAttachments, registeredReplyMedia, resolveReplyAttachment, validateRegisteredAttachment } from "./replyAttachments.js";
import { extractLarkReplyMedia, deliverLarkOutboxRow, retryPendingLarkTextReplies } from "./responder.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-attachment-files-"));
  fs.mkdirSync(path.join(root, "output"));
  const context = { threadId: "thread", turnId: "turn", messageId: 1, taskDir: root };
  const write = (name: string, content = "fixture content") => fs.writeFileSync(path.join(root, "output", name), content);
  return { root, context, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

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
