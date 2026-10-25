import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime } from "./context.js";
import { buildLarkCodexPrompt, buildLarkCodexDeltaPrompt, extractLarkReplyMedia, isLarkNoReplyDecision } from "./responder.js";
import { ensureLarkStickerSelection, larkStickerPrompt, uploadLarkStickers } from "./stickers.js";

test("sticker intent prompts defer matching to the server in full and delta inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sticker-intent-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: path.join(root, "stickers") });
  try {
    const prompt = larkStickerPrompt();
    assert.match(prompt, /无需知道素材标签、图片 ID 或提前确认候选存在/);
    assert.match(prompt, /情绪表达、接话或加强语气/);
    assert.match(prompt, /lark_stickers MCP/);
    assert.match(larkStickerPrompt("a".repeat(32)), new RegExp("a".repeat(32)));
    assert.match(larkStickerPrompt(undefined, { usageMode: "off" }), /不要调用 lark_stickers MCP/);
    assert.doesNotMatch(larkStickerPrompt(undefined, { usageMode: "off" }), /使用 search 搜索情绪/);
    assert.match(larkStickerPrompt(undefined, { usageMode: "explicit" }), /只有用户明确要求/);
    assert.match(larkStickerPrompt(undefined, { usageMode: "natural" }), /情绪表达、接话或加强语气/);
    assert.match(larkStickerPrompt(undefined, { usageMode: "always" }), /每次准备产生可见的最终文字回复时，都必须调用/);
    assert.match(larkStickerPrompt(undefined, { usageMode: "always" }), /只有最终决定不回复/);
    assert.doesNotMatch(prompt, /没有贴切候选就不声明|正式回答默认不发/);
    const message = { chat_id: "oc_group", chat_type: "group", sender_id: "ou_user", content: "来个无语的表情包", reply_to_message_id: null, reply_to_message_type: null, reply_to_content: null };
    for (const build of [buildLarkCodexPrompt, buildLarkCodexDeltaPrompt]) {
      assert.equal(build(message).split(prompt).length, 2);
      const withHistory = build(message, { stickerContextToken: "a".repeat(32), missingImageCount: 2, trustedSender: true });
      assert.match(withHistory, /history_images_search/);
      assert.match(withHistory, /history_images_open/);
      assert.match(withHistory, /另有 2 张.*未能取得/);
      assert.match(build(message, { stickerContextToken: "a".repeat(32), trustedSender: false }), /history_images_search/);
      assert.match(build({...message,chat_type:"p2p"}, { stickerContextToken: "a".repeat(32), trustedSender: false }), /history_images_open/);
    }
    store.setSetting("stickerUsageMode", "off");
    assert.match(buildLarkCodexDeltaPrompt(message, { stickerContextToken: "a".repeat(32), trustedSender: true }), /history_images_search/);
    assert.match(buildLarkCodexDeltaPrompt(message, { stickerContextToken: "a".repeat(32), trustedSender: false }), /history_images_open/);
    store.setSetting("stickerUsageMode", "natural");
    store.setSetting("stickerUsageMode", "explicit");
    store.setSetting("conversation.stickerUsageMode:oc_group", "always");
    for (const build of [buildLarkCodexPrompt, buildLarkCodexDeltaPrompt]) {
      assert.match(build(message), /表情包（每次回复）/);
      assert.match(build({ ...message, chat_id: "oc_other" }), /表情包（仅明确请求）/);
    }
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
    const [sticker] = uploadLarkStickers([{ name: "无语", tags: ["无语", "自嘲"], fileName: "test.png", mimeType: "image/png", dataBase64: png }]);
    const answer = '行吧。<lark-sticker>{"query":"无语、自嘲"}</lark-sticker>';
    const result = extractLarkReplyMedia(ensureLarkStickerSelection(answer, "oc_group"), path.join(root, "matched"), "oc_group");
    assert.equal(result.text, "行吧。");
    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].stickerId, sticker.id);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(result.media[0].absolutePath), true);
    const unmatched = '文字保留。<lark-sticker>{"query":"zzzz,qqqq"}</lark-sticker>';
    assert.equal(ensureLarkStickerSelection(unmatched, "oc_group"), unmatched);
    const miss = extractLarkReplyMedia(unmatched, path.join(root, "miss"), "oc_group");
    assert.equal(miss.text, "文字保留。");
    assert.deepEqual(miss.media, []);
    assert.deepEqual(miss.errors, []);
    assert.equal(ensureLarkStickerSelection("纯文字回答", "oc_group"), "纯文字回答");
    assert.equal(isLarkNoReplyDecision(ensureLarkStickerSelection("<lark-no-reply/>", "oc_group")), true);
    assert.equal(extractLarkReplyMedia(answer + answer, path.join(root, "multiple"), "oc_group").media.length, 0);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
