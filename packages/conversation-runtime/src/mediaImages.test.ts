import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageMarkersWithoutKeys, larkImageResourcesFromMessage } from "./mediaImages.js";
import { buildLarkCodexUserInput, downloadReferencedImages } from "./responder.js";
import type { LarkMessageRow } from "./context.js";
import { configureConversationRuntime } from "./context.js";
import { ingestLarkEvent } from "./worker.js";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";

test("current and directly quoted rich-text images are collected in order without prior context", () => {
  const images = larkImageResourcesFromMessage({
    message_id: "om_current", message_type: "text", content: "再看这张 [Image: img_current]",
    reply_to_message_id: "om_parent", reply_to_message_type: "post",
    reply_to_content: "![Image](img_first) 正文 ![Image](img_second)",
    reply_to_raw_json: JSON.stringify({ content: "![Image](img_first) 正文 ![Image](img_second)" })
  });
  assert.deepEqual(images, [
    { messageId: "om_parent", imageKey: "img_first" },
    { messageId: "om_parent", imageKey: "img_second" },
    { messageId: "om_current", imageKey: "img_current" }
  ]);
  assert.equal(imageMarkersWithoutKeys("图在这里 ![Image]"), 1);
});

test("structured post images and direct image quotes do not depend on earlier Codex turns", () => {
  const structured = JSON.stringify({ zh_cn: { content: [[{ tag: "img", image_key: "img_structured" }], [{ tag: "img", image_key: "img_more" }]] } });
  assert.deepEqual(larkImageResourcesFromMessage({ message_id: "om_new", message_type: "text", content: "看看", reply_to_message_id: "om_post",
    reply_to_message_type: "post", reply_to_content: structured }), [
    { messageId: "om_post", imageKey: "img_structured" }, { messageId: "om_post", imageKey: "img_more" }
  ]);
  assert.deepEqual(larkImageResourcesFromMessage({ message_id: "om_new", message_type: "text", content: "看看", reply_to_message_id: "om_image",
    reply_to_message_type: "image", reply_to_content: "[Image: img_older]" }), [{ messageId: "om_image", imageKey: "img_older" }]);
});

test("quoted post images become multiple Codex attachments and partial failures stay visible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-quoted-images-"));
  const bin = path.join(root, "bin");
  const taskDir = path.join(root, "task");
  fs.mkdirSync(bin);
  fs.mkdirSync(taskDir);
  const cli = path.join(bin, "lark-cli");
  fs.writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");\nconst arg=(key)=>process.argv[process.argv.indexOf(key)+1];\nif(arg("--file-key")==="img_second"){process.stderr.write("simulated image download failure");process.exit(1)}\nconst file=path.resolve(arg("--output")+".png");fs.writeFileSync(file,Buffer.from([137,80,78,71,13,10,26,10,1]));\nprocess.stdout.write(JSON.stringify({data:{saved_path:file}}));\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const message = { message_id: "om_current", message_type: "text", content: "请看引用",
      reply_to_message_id: "om_quoted", reply_to_message_type: "post", reply_to_content: "![Image](img_first) ![Image](img_second)" } as LarkMessageRow;
    const result = await downloadReferencedImages(message, taskDir);
    assert.equal(result.paths.length, 1);
    assert.equal(result.missingCount, 1);
    assert.equal(buildLarkCodexUserInput("问题", result.paths).filter((item) => item.type === "localImage").length, 1);
    assert.match(fs.readFileSync(path.join(taskDir, "image-download-error.log"), "utf8"), /img_second[\s\S]*simulated image download failure/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two quoted images are both attached to the same Codex turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-two-quoted-images-"));
  const bin = path.join(root, "bin");
  const taskDir = path.join(root, "task");
  fs.mkdirSync(bin);
  fs.mkdirSync(taskDir);
  fs.writeFileSync(path.join(bin, "lark-cli"), `#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");\nconst output=process.argv[process.argv.indexOf("--output")+1];\nconst file=path.resolve(output+".png");fs.writeFileSync(file,Buffer.from([137,80,78,71,13,10,26,10,1]));\nprocess.stdout.write(JSON.stringify({data:{saved_path:file}}));\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const message = { message_id: "om_current", message_type: "text", content: "请看引用", reply_to_message_id: "om_quoted",
      reply_to_message_type: "post", reply_to_content: "![Image](img_first) ![Image](img_second)" } as LarkMessageRow;
    const result = await downloadReferencedImages(message, taskDir);
    assert.equal(result.missingCount, 0);
    assert.equal(result.paths.length, 2);
    assert.equal(buildLarkCodexUserInput("问题", result.paths).filter((item) => item.type === "localImage").length, 2);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an event quote falls back to the stored parent when remote lookup fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-quoted-fallback-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const cli = path.join(bin, "lark-cli");
  fs.writeFileSync(cli, "#!/usr/bin/env node\nprocess.stderr.write('simulated mget failure');process.exit(1);\n", { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: root, mode: "shadow" });
  try {
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_type,message_type,content,raw_json,received_at,created_at) VALUES ('om_parent','oc_group','group','user','post',?,'{}',?,?)")
      .run("![Image](img_from_local)", now, now);
    ingestLarkEvent({ event_id: "evt_child", message_id: "om_child", chat_id: "oc_group", chat_type: "group", sender_id: "ou_sender", sender_type: "user",
      message_type: "text", content: "看引用图", reply_to: "om_parent" });
    const child = store.db.prepare("SELECT reply_to_message_id,reply_to_message_type,reply_to_content FROM lark_messages WHERE message_id='om_child'").get() as Record<string, string>;
    assert.equal(child.reply_to_message_id, "om_parent");
    assert.equal(child.reply_to_message_type, "post");
    assert.deepEqual(larkImageResourcesFromMessage({ ...child, message_id: "om_child", message_type: "text", content: "看引用图" } as LarkMessageRow),
      [{ messageId: "om_parent", imageKey: "img_from_local" }]);
  } finally {
    store.close();
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stripped remote rich-text quote uses the locally stored image keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-quoted-richtext-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lark-cli"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({data:{messages:[{message_id:"om_parent",msg_type:"post",content:"![Image]"}]}}));\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: root, mode: "shadow" });
  try {
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO lark_messages (message_id,chat_id,chat_type,sender_type,message_type,content,raw_json,received_at,created_at) VALUES ('om_parent','oc_group','group','user','post',?,'{}',?,?)")
      .run("![Image](img_saved)", now, now);
    ingestLarkEvent({ event_id: "evt_rich_child", message_id: "om_rich_child", chat_id: "oc_group", chat_type: "group", sender_id: "ou_sender", sender_type: "user",
      message_type: "text", content: "看引用图", reply_to: "om_parent" });
    const child = store.db.prepare("SELECT reply_to_content FROM lark_messages WHERE message_id='om_rich_child'").get() as { reply_to_content: string };
    assert.match(child.reply_to_content, /img_saved/);
  } finally {
    store.close();
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
