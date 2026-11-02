import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { serializeCodexAppServerMessage } from "@lark-agent/adapter-codex-app-server";
import { configureConversationRuntime } from "./context.js";
import { buildLarkCodexDeltaPrompt, buildLarkCodexPrompt, buildLarkCodexUserInput, formatRecentLarkMessages } from "./responder.js";

test("quoted emoji at the incident boundary produces valid full, delta and native-topic requests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-unicode-context-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  try {
    configureConversationRuntime({ database: store.db, repoRoot: root, larkStickerDirectory: path.join(root, "stickers") });
    const quote = "x".repeat(118) + "\u{1f4dd}" + " reference tail";
    const broken = quote.slice(0, 119) + "...";
    assert.match(broken, /[\uD800-\uDFFF]/u);
    assert.throws(() => serializeCodexAppServerMessage({ input: broken }), /invalid Unicode/);
    const message = { id: 2, message_id: "om_current", content: "Clarify the referenced reply", chat_id: "oc_fixture", chat_type: "group", sender_id: "ou_fixture",
      reply_to_message_id: "om_parent", reply_to_message_type: "post", reply_to_content: quote };
    const attachments = { referencedFiles: [{ name: "notes.md", path: path.join(root, "notes.md"), mimeType: "text/markdown", size: 20_006, text: "a".repeat(19_999) + "\u{1f4dd}" + " tail" }] };
    for (const prompt of [buildLarkCodexPrompt(message, attachments), buildLarkCodexDeltaPrompt(message, attachments),
      buildLarkCodexDeltaPrompt(message, { ...attachments, nativeTopicMode: true, includeStableInstructions: false })]) {
      assert.doesNotMatch(prompt, /[\uD800-\uDFFF]/u);
      assert.match(prompt, /x{118}…/);
      const wire = serializeCodexAppServerMessage({ id: 1, method: "turn/start", params: { threadId: "fixture", input: buildLarkCodexUserInput(prompt) } });
      assert.equal(JSON.parse(wire).params.input[0].text, prompt);
    }
    for (let budget = 1; budget < 200; budget++) {
      const context = formatRecentLarkMessages([{ id: 1, message_id: "om_1", direction: "inbound", sender_id: "ou_fixture", sender_name: "\u{1f4dd}".repeat(50),
        message_type: "text", content: "中\u{1f4dd}".repeat(200), message_at: null, reply_to_message_id: null, reply_to_content: null, reply_to_local_id: null }], budget);
      assert.doesNotMatch(context, /[\uD800-\uDFFF]/u);
    }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
