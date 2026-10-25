import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { codexAppServerArgs } from "@lark-agent/adapter-codex-app-server";
import { configureConversationRuntime } from "./context.js";
import { uploadLarkStickers } from "./stickers.js";
import { applySelectedSticker, runStickerTool } from "./stickerTools.js";
import { buildLarkCodexThreadParams, deliverLarkOutboxRow, extractLarkReplyMedia } from "./responder.js";
import { larkStickerMcpCodexConfig } from "./codexRuntime.js";

test("sticker tools bind selection to message and turn and never send during selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticker-tools-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: path.join(root, "stickers"), runtimeUrl: "http://127.0.0.1:4782" });
  try {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
    const [sticker] = uploadLarkStickers([{ name: "得意", tags: ["得意", "自夸"], fileName: "image.png", mimeType: "image/png", dataBase64: png }]);
    const context = { threadId: "thread-1", turnId: "turn-1", messageId: 1, taskDir: root };
    const tools = buildLarkCodexThreadParams(false).dynamicTools as Array<{ name: string }>;
    assert.equal(tools.some((tool) => tool.name.startsWith("lark_stickers_")), false);
    const mcpConfig = larkStickerMcpCodexConfig().join("\n");
    assert.match(mcpConfig, /mcp_servers\.lark_stickers/);
    assert.match(mcpConfig, /mcp-stickers/);
    assert.doesNotMatch(mcpConfig, /LARK_AGENT_RUNTIME_TOKEN=/);
    const launchArgs = codexAppServerArgs(larkStickerMcpCodexConfig());
    assert.deepEqual(launchArgs.slice(0, 5), ["app-server", "--disable", "hooks", "--listen", "stdio://"]);
    assert.equal(launchArgs.filter((arg) => arg === "-c").length, larkStickerMcpCodexConfig().length);
    assert.equal(runStickerTool("lark_stickers_select", { sticker_id: sticker.id }, context).result.success, false);
    const search = runStickerTool("lark_stickers_search", { query: "得意" }, context);
    assert.equal(search.result.success, true);
    assert.deepEqual(search.state.candidateIds, [sticker.id]);
    if (process.platform === "darwin") assert(search.result.contentItems.some((item) => item.type === "inputImage"));
    const selected = runStickerTool("lark_stickers_select", { sticker_id: sticker.id }, context, search.state);
    assert.equal(selected.result.success, true);
    assert.match(JSON.stringify(selected.result), /selected_pending_final_text/);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM sticker_sends").get() as { n: number }).n, 0);
    const answer = applySelectedSticker("文字先到。", selected.state, context)!;
    assert.equal(extractLarkReplyMedia(answer, root).stickerIds[0], sticker.id);
    assert.equal(applySelectedSticker("<lark-no-reply/>", selected.state, context), "<lark-no-reply/>");
    assert.equal(applySelectedSticker("下一条", selected.state, { ...context, messageId: 2 }), "下一条");
    assert.equal(applySelectedSticker("下一轮", selected.state, { ...context, turnId: "turn-2" }), "下一轮");
    assert.equal(runStickerTool("lark_stickers_select", { sticker_id: sticker.id }, { ...context, threadId: "other" }, search.state).result.success, false);
    assert.equal(runStickerTool("lark_stickers_select", { sticker_id: sticker.id, chat_id: "oc_other" }, context, search.state).result.success, false);
    const cleared = runStickerTool("lark_stickers_select", { sticker_id: null }, context, selected.state);
    assert.equal(applySelectedSticker(answer, cleared.state, context), "文字先到。");
    assert.deepEqual(runStickerTool("lark_stickers_search", { query: "zzzz" }, context).state.candidateIds, []);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("sticker outbox waits for its exact final text receipt, survives reopen and sends once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticker-order-"));
  const file = path.join(root, "test.sqlite");
  let store = new SqliteAgentStore(file);
  const configure = () => configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: root });
  configure();
  const now = new Date().toISOString();
  const row = { id: 1, lark_message_id: 1, kind: "media" as const, idempotency_key: "sticker-1", attempts: 0, payload: JSON.stringify({ messageId: "om_one", taskDir: root, paths: ["output/sticker.png"], afterTextKey: "final-one" }) };
  let sends = 0;
  const send = () => { sends++; return { ok: true as const }; };
  try {
    store.db.prepare("INSERT INTO lark_messages (id,message_id,chat_id,mentioned,reply_status,reply_delivery_key,raw_json,received_at,created_at) VALUES (1,'om_one','oc_one',1,'pending','final-one','{}',?,?)").run(now, now);
    store.db.prepare("INSERT INTO lark_delivery_outbox (id,lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at) VALUES (1,1,'media',?,'sticker-1',?,?)").run(row.payload, now, now);
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 0);
    assert.equal(sends, 0);
    store.close(); store = new SqliteAgentStore(file); configure();
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 0);
    store.db.prepare("UPDATE lark_messages SET reply_status='sent',reply_sent_at=? WHERE id=1").run(now);
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 1);
    assert.equal(deliverLarkOutboxRow(row, send).sentCount, 0);
    assert.equal(sends, 1);
    for (const [status, key] of [["failed", "final-one"], ["sent", "different-turn"]]) {
      store.db.prepare("UPDATE lark_delivery_outbox SET status='pending' WHERE id=1").run();
      store.db.prepare("UPDATE lark_messages SET reply_status=?,reply_delivery_key=?,reply_sent_at=NULL WHERE id=1").run(status, key);
      assert.equal(deliverLarkOutboxRow(row, send).ok, false);
      assert.equal(sends, 1);
    }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
