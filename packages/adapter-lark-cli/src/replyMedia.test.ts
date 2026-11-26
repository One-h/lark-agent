import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendLarkMediaReply } from "./reply.js";

test("video attachments use a stream upload and a file reply without changing image or document delivery", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-reply-media-"));
  const executable = path.join(root, "lark-cli");
  const log = path.join(root, "calls.jsonl");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[1] === "files") {
  const data = JSON.parse(args[args.indexOf("--data") + 1]);
  console.log(JSON.stringify({ok: data.file_name !== "refused.mp4", identity: "bot", data: {file_key: "file_fixture"}}));
} else {
  const key = args[args.indexOf("--idempotency-key") + 1];
  console.log(JSON.stringify({ok: true, data: key === "no-receipt" ? {} : {message_id: "om_fixture"}}));
}
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = root + path.delimiter + (previousPath ?? "");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = fs.realpathSync(root);
  const calls = (): Array<{ args: string[]; cwd: string }> =>
    fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(sendLarkMediaReply("om_source", cwd, "output/my clip.MP4", "video-key"), { ok: true, messageId: "om_fixture" });
  assert.deepEqual(calls(), [
    { cwd, args: ["im", "files", "create", "--as", "bot", "--data",
      JSON.stringify({ file_name: "my clip.MP4", file_type: "stream" }),
      "--file", "file=output/my clip.MP4", "--format", "json"] },
    { cwd: process.cwd(), args: ["im", "+messages-reply", "--as", "bot", "--message-id", "om_source",
      "--msg-type", "file", "--content", JSON.stringify({ file_key: "file_fixture" }),
      "--idempotency-key", "video-key", "--format", "json"] }
  ]);

  for (const [file, flag] of [["output/photo.png", "--image"], ["output/report.pdf", "--file"]]) {
    assert.equal(sendLarkMediaReply("om_source", cwd, file, "attachment-key").ok, true);
    assert.deepEqual(calls().at(-1)?.args, ["im", "+messages-reply", "--as", "bot", "--message-id", "om_source",
      flag, file, "--idempotency-key", "attachment-key"]);
  }
  assert.equal(calls().length, 4);

  assert.deepEqual(sendLarkMediaReply("om_source", cwd, "output/refused.mp4", "refused-key"),
    { ok: false, error: "No confirmed video attachment upload receipt" });
  assert.equal(calls().length, 5);
  assert.deepEqual(sendLarkMediaReply("om_source", cwd, "../unsafe.mp4", "unsafe-key"),
    { ok: false, error: "Invalid video attachment path" });
  assert.equal(calls().length, 5);

  assert.deepEqual(sendLarkMediaReply("om_source", cwd, "output/clip.mov", "no-receipt"),
    { ok: false, error: "No confirmed video attachment reply receipt" });
  assert.equal(calls().length, 7);
});
