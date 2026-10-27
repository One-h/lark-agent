import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLarkExecutionApprovalCard, buildLarkExecutionApprovalResultCard, buildLarkExecutionReceiptCard, buildLarkImagePostReplyArgs, larkAtTag, larkReplyIdempotencyKey } from "@lark-agent/adapter-lark-cli";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { configureConversationRuntime } from "./context.js";
import { findLarkContactByAlias, larkContactAliases, larkContactSearchFromCliOutput, upsertLarkContact } from "./contacts.js";
import { ensureLarkStickerSelection, larkStickerImage, resolveLarkStickerQuery, softDeleteLarkSticker, stageLarkStickerSelection, updateLarkSticker, uploadLarkStickers } from "./stickers.js";
import { ingestLarkEvent, isAtMeMessage, parseLarkExecutionApprovalAction, shouldStartSpontaneousLarkReply } from "./worker.js";
import { config, setAppSettingValue } from "./context.js";
import { approvalRequestDetails, buildLarkCodexDeltaPrompt, buildLarkCodexPrompt, buildLarkCodexThreadParams, buildLarkCodexTurnParams, buildLarkCodexUserInput, extractAgentMessageEventsFromCodexJsonl, extractStreamableAgentMessageEventsFromCodexJsonl, formatLarkFinalReply, formatRecentLarkMessages, isLarkCodexAuthenticationFailure, isLarkNoReplyDecision, isLikelyMutatingCommand, larkCodexCompletedMessageEvent, larkCodexSessionKeyForMessage, larkCodexStartedSubstantiveWorkItem, larkCodexTaskPaths, larkCwdRecoveryStrategy, larkFileResourcesFromMessage, larkFinalTextDeliveryDecision, larkImageResourceFromMessage, larkMessageTopicKey, loadLarkGroupContext, parseLarkCodexModels, reconcileOrphanedLarkCodexRuns, sanitizeLarkCodexReply, shouldRecoverLarkStartupStall, shouldRetryLarkTurnWithoutCwd, shouldSendLarkInterimReply } from "./responder.js";

test("Codex model catalog keeps available models and their supported efforts", () => {
  assert.deepEqual(parseLarkCodexModels([
    { id: "gpt-5.6-terra", displayName: "Terra", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], inputModalities: ["text", 1] },
    { id: "custom-model", displayName: "", supportedReasoningEfforts: null },
    { id: "", displayName: "Invalid" },
    null
  ]), [
    { id: "gpt-5.6-terra", displayName: "Terra", efforts: ["low", "medium"], inputModalities: ["text"] },
    { id: "custom-model", displayName: "custom-model", efforts: [], inputModalities: [] }
  ]);
  assert.deepEqual(parseLarkCodexModels(null), []);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-agent-conversation-runtime-"));
  const store = new SqliteAgentStore(path.join(root, "agent.sqlite"));
  const stickers = path.join(root, "stickers");
  configureConversationRuntime({ database: store.db, larkStickerDirectory: stickers, repoRoot: root });
  return { root, store };
}

test("conversation runtime contacts preserve aliases and CLI parsing", () => {
  const { store } = fixture();
  try {
    assert.deepEqual(larkContactAliases("林小夏（测试）"), ["林小夏（测试）", "测试", "林小夏"]);
    upsertLarkContact({ openId: "ou_owner", name: "林小夏（测试）", aliases: ["example"], enterpriseEmail: "owner@example.com", p2pChatId: "oc_owner", hasChatted: true });
    assert.equal(findLarkContactByAlias("林小夏")?.open_id, "ou_owner");
    assert.equal(findLarkContactByAlias("example")?.p2p_chat_id, "oc_owner");
    const parsed = larkContactSearchFromCliOutput(JSON.stringify({ ok: true, data: { users: [{ open_id: "ou_owner", name: "林小夏" }], has_more: true } }));
    assert.equal(parsed.users.length, 1);
    assert.equal(parsed.hasMore, true);
  } finally { store.close(); }
});

test("conversation runtime stickers preserve upload, ranking, staging and soft delete", () => {
  const { root, store } = fixture();
  try {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
    const [created] = uploadLarkStickers([{ name: "无语", description: "离谱场景", tags: ["无语", "离谱"], fileName: "sticker.png", mimeType: "image/png", dataBase64: png }]);
    assert.ok(created.id.startsWith("stk_"));
    assert.ok(larkStickerImage(created.id)?.path);
    assert.equal(resolveLarkStickerQuery("oc_group", "无语、离谱")?.id, created.id);
    assert.ok(ensureLarkStickerSelection(`回答。<forge-sticker>{"id":"${created.id}"}</forge-sticker>`, "oc_group").includes(created.id));
    const staged = stageLarkStickerSelection(`行吧。<forge-sticker>{"query":"无语、离谱"}</forge-sticker>`, path.join(root, "task"), "oc_group");
    assert.equal(staged.media[0]?.stickerId, created.id);
    assert.equal(stageLarkStickerSelection(`行吧。<lark-sticker>{"query":"无语、离谱"}</lark-sticker>`, path.join(root, "task-lark"), "oc_group").media[0]?.stickerId, created.id);
    assert.equal(updateLarkSticker(created.id, { description: "已更新" })?.description, "已更新");
    assert.equal(softDeleteLarkSticker(created.id), true);
    assert.equal(larkStickerImage(created.id), null);
  } finally { store.close(); }
});

test("conversation runtime worker preserves mention, spontaneous and approval policies", () => {
  assert.equal(isAtMeMessage({ chat_type: "p2p" }, "ou_bot"), true);
  assert.equal(isAtMeMessage({ chat_type: "group", mentions: [{ id: { open_id: "ou_other" } }] }, "ou_bot"), false);
  assert.equal(isAtMeMessage({ chat_type: "group", mentions: [{ id: { open_id: "ou_bot" } }] }, "ou_bot"), true);
  assert.equal(shouldStartSpontaneousLarkReply({ chat_id: "oc_group", chat_type: "group", sender_type: "user", message_type: "text", content: "hello" }, false, false, 0.01, true, 0.08, ["oc_group"]), true);
  assert.equal(shouldStartSpontaneousLarkReply({ chat_id: "oc_group", chat_type: "group", sender_type: "bot", message_type: "text", content: "hello" }, false, false, 0.01, true, 0.08, ["oc_group"]), false);
  assert.deepEqual(parseLarkExecutionApprovalAction({ action_tag: "button", action_value: JSON.stringify({ action: "approve-turn", approval_token: "token" }) }), { token: "token", decision: "approve-turn" });
});

test("conversation runtime acknowledgement reactions do not masquerade as text replies", () => {
  const { root, store } = fixture();
  const originalPath = process.env.PATH;
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const fakeCli = path.join(bin, "lark-cli");
    fs.writeFileSync(fakeCli, "#!/bin/sh\nprintf '%s\\n' '{\"data\":{\"messages\":[]}}'\n");
    fs.chmodSync(fakeCli, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const reactions: Array<{ messageId: string; emoji: string }> = [];
    configureConversationRuntime({
      database: store.db,
      mode: "shadow",
      larkStickerDirectory: path.join(root, "stickers"),
      repoRoot: root,
      reactionSender: (messageId, emoji) => {
        reactions.push({ messageId, emoji });
        return { ok: true };
      }
    });
    const ingested = ingestLarkEvent({
      event_id: "evt-ack",
      message_id: "om-ack",
      chat_id: "oc-ack",
      chat_type: "p2p",
      sender_id: "ou-sender",
      sender_type: "user",
      message_type: "text",
      content: "hello"
    });
    assert.equal(reactions.length, 1);
    assert.equal((store.db.prepare("SELECT reply_status FROM lark_messages WHERE id=?").get(ingested.id) as { reply_status: string }).reply_status, "skipped");
  } finally {
    process.env.PATH = originalPath;
    store.close();
  }
});

test("conversation runtime responder preserves prompts, trust profiles and group mentions", () => {
  const { store } = fixture();
  try {
    config.workspaceRoot = "/tmp/lark-agent-workspace";
    config.repoRoot = "/tmp/lark-agent";
    config.larkCodexModel = "gpt-5.6-terra";
    setAppSettingValue("larkSenderReplyProfiles", JSON.stringify({ ou_sender: { replyTone: "友好、简洁" } }));
    const prompt = buildLarkCodexPrompt({ content: "帮我排查", chat_type: "p2p", sender_id: "ou_sender", reply_to_message_id: null, reply_to_message_type: null, reply_to_content: null }, { trustedSender: true, referencedImagePaths: ["/tmp/image.png"] });
    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /当前发送人已通过可信校验/);
    assert.match(prompt, /referenced_image_paths: \/tmp\/image\.png/);
    assert.match(prompt, /友好、简洁/);
    const trusted = buildLarkCodexThreadParams(true);
    assert.equal(trusted.sandbox, "danger-full-access");
    assert.equal(trusted.approvalPolicy, "never");
    assert.equal(trusted.model, "gpt-5.6-terra");
    assert.equal(buildLarkCodexThreadParams(true, "resume").model, "gpt-5.6-terra");
    assert.equal(buildLarkCodexTurnParams({ input: [], messageId: "om_test", trustedSender: true }, "thread_test").model, "gpt-5.6-terra");
    store.registerCapabilities([{ id: "host.demo", title: "Demo", description: "Demo capability", inputSchema: { type: "object" }, risk: "read" }]);
    config.larkAgentRuntimeUrl = "http://127.0.0.1:4780";
    const dynamicTools = buildLarkCodexThreadParams(true).dynamicTools as Array<{ name?: string }>;
    assert(dynamicTools.some((tool) => tool.name === "host__demo"));
    assert.deepEqual(buildLarkCodexUserInput("prompt", ["/tmp/image.png"]).at(-1), { type: "localImage", path: "/tmp/image.png" });
    assert.equal(larkAtTag("ou_sender"), '<at user_id="ou_sender"></at>');
    assert.equal(formatLarkFinalReply({ chat_type: "group", sender_id: "ou_sender" }, "收到。"), '<at user_id="ou_sender"></at> 收到。');
  } finally { store.close(); }
});

test("conversation runtime responder preserves no-reply, sanitization and recovery decisions", () => {
  assert.equal(isLarkNoReplyDecision("<forge-no-reply/>"), true);
  assert.equal(isLarkNoReplyDecision("正常回复"), false);
  assert.doesNotMatch(sanitizeLarkCodexReply("依据当前 本机工作区规则，需要可信用户授权。", false), /本机工作区|可信用户/);
  assert.equal(larkCwdRecoveryStrategy(new Error("invalid cwd: Operation not permitted (os error 1)")), "restart-app-server");
  assert.equal(shouldRetryLarkTurnWithoutCwd(new Error("invalid cwd: No such file or directory")), true);
  assert.equal(isLarkCodexAuthenticationFailure("HTTP 401 token_revoked"), true);
  assert.equal(shouldRecoverLarkStartupStall(60_000, false, 60_000), true);
  assert.equal(isLikelyMutatingCommand("git push origin main"), true);
  assert.equal(isLikelyMutatingCommand("node deploy-app.mjs --execute"), true);
  assert.equal(isLikelyMutatingCommand("git status --short"), false);
  assert.equal(isLikelyMutatingCommand("rg -n TODO src"), false);
});

test("full and incremental prompts refresh one compact timestamp while preserving the original send time", t => {
  const { root, store } = fixture();
  try {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T11:16:26Z") });
    const message = { content: "今天的订单", chat_type: "p2p", sender_id: "ou_sender", reply_to_message_id: null,
      reply_to_message_type: null, reply_to_content: null, message_at: "2026-10-22T11:16:20Z" };
    const full = buildLarkCodexPrompt(message);
    assert.equal(full.match(/时间\(\+08:00\)/g)?.length, 1);
    assert.match(full, /时间\(\+08:00\)：消息 2026-10-22 19:16/);
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    const delta = buildLarkCodexDeltaPrompt(message);
    assert.equal(delta.match(/时间\(\+08:00\)/g)?.length, 1);
    assert.match(delta, /消息 2026-10-22 19:16；当前 2026-10-23 19:16/);
    assert.doesNotMatch(delta, /当前日期是/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("conversation runtime responder preserves approval protocol and card contracts", () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: ["/tmp/read"], write: ["/tmp/write"] } };
  const details = approvalRequestDetails({ id: "request", method: "item/permissions/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item", permissions } });
  assert.deepEqual(details?.approvedResponse, { permissions });
  assert.deepEqual(details?.rejectedResponse, { permissions: {} });
  const pending = JSON.stringify(buildLarkExecutionApprovalCard({ requester: "同事", originalMessage: "发布", operation: "deploy", cwd: "/tmp", reason: "release", approvalToken: "token" }));
  assert.match(pending, /允许本次/);
  assert.match(pending, /允许当前任务/);
  const decided = JSON.stringify(buildLarkExecutionApprovalResultCard({ requester: "同事", originalMessage: "发布", operation: "deploy", cwd: "/tmp", reason: "release", status: "approved", approvalScope: "turn", decidedAt: new Date().toISOString() }));
  assert.doesNotMatch(decided, /"tag":"action"/);
  const receipt = JSON.stringify(buildLarkExecutionReceiptCard({ status: "verified", entries: [{ capability: "host.deploy", title: "生产发布", status: "verified", summary: "发布完成并验证。", evidence: ["revision: abc123", "health: healthy"] }] }));
  assert.match(receipt, /执行回执 · 已验证/);
  assert.match(receipt, /revision: abc123/);
  assert.doesNotMatch(receipt, /"tag":"action"/);
});

test("conversation runtime responder preserves stream extraction and idempotency", () => {
  const text = [JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "先检查。" } }), JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "最终答复。" } })].join("\n");
  assert.deepEqual(extractAgentMessageEventsFromCodexJsonl(text), [{ id: "item_0", text: "先检查。" }, { id: "item_1", text: "最终答复。" }]);
  assert.deepEqual(extractStreamableAgentMessageEventsFromCodexJsonl(text, new Set(["item_0"])), [{ id: "item_1", text: "最终答复。" }]);
  assert.match(larkReplyIdempotencyKey("final", "om_message"), /^afc-final-[a-f0-9]{16}$/);
  assert.equal(shouldSendLarkInterimReply({ enabled: true, elapsedMs: 29_999, hasStartedSubstantiveWork: true, sentCount: 0 }), false);
  assert.equal(shouldSendLarkInterimReply({ enabled: false, elapsedMs: 60_000, hasStartedSubstantiveWork: true, sentCount: 0 }), false);
  assert.equal(shouldSendLarkInterimReply({ enabled: true, elapsedMs: 60_000, hasStartedSubstantiveWork: false, sentCount: 0 }), false);
  assert.equal(shouldSendLarkInterimReply({ enabled: true, elapsedMs: 30_000, hasStartedSubstantiveWork: true, sentCount: 0 }), true);
  assert.equal(larkCodexStartedSubstantiveWorkItem({ method: "item/started", params: { item: { type: "mcpToolCall", server: "lark_stickers" } } }), false);
  assert.equal(larkCodexStartedSubstantiveWorkItem({ method: "item/started", params: { item: { type: "commandExecution" } } }), true);
  assert.deepEqual(larkFinalTextDeliveryDecision({ reply: "相同答复", previousReply: "相同答复", previousKey: "interim-key", hasSticker: true, newKey: "final-key" }), { shouldQueue: false, dependencyKey: "interim-key" });
  assert.deepEqual(larkFinalTextDeliveryDecision({ reply: "完整结论", previousReply: "处理中", previousKey: "interim-key", hasSticker: false, newKey: "final-key" }), { shouldQueue: true, dependencyKey: "final-key" });
});

test("conversation runtime responder preserves attachment resolution and multi-image payloads", () => {
  assert.deepEqual(larkImageResourceFromMessage({ message_id: "om_text", message_type: "text", content: "看图", reply_to_message_id: "om_parent", reply_to_message_type: "image", reply_to_content: "[Image: img_parent]" }), { messageId: "om_parent", imageKey: "img_parent" });
  assert.deepEqual(larkFileResourcesFromMessage({ message_id: "om_file", message_type: "file", content: JSON.stringify({ file_key: "file_md", file_name: "需求.md" }), reply_to_message_id: null, reply_to_message_type: null, reply_to_content: null }), [{ messageId: "om_file", fileKey: "file_md", fileName: "需求.md" }]);
  assert.deepEqual(larkFileResourcesFromMessage({ message_id: "om_reply", message_type: "text", content: "读取附件", reply_to_message_id: "om_parent", reply_to_message_type: "file", reply_to_content: '<file key="file_html" name="验收.html"/>' }), [{ messageId: "om_parent", fileKey: "file_html", fileName: "验收.html" }]);
  const args = buildLarkImagePostReplyArgs("om_test", ["img_one", "img_two"], "images-key");
  assert.equal(args.includes("post"), true);
  assert.match(args[args.indexOf("--content") + 1], /img_one/);
  assert.match(args[args.indexOf("--content") + 1], /img_two/);
});

test("conversation runtime responder preserves bounded group context and stable task paths", () => {
  const { store } = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,raw_json,received_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const now = new Date().toISOString();
    for (let index = 1; index <= 6; index += 1) insert.run(`evt-${index}`, `om-${index}`, "oc_group", "group", `ou_${index}`, "text", `第${index}条`, 0, "{}", now, now);
    upsertLarkContact({ openId: "ou_4", name: "林小夏" });
    store.db.prepare("UPDATE lark_messages SET reply_to_message_id='om-4', reply_to_content='第4条' WHERE message_id='om-5'").run();
    store.db.prepare("UPDATE lark_messages SET direction='outbound', sender_id=NULL WHERE message_id='om-6'").run();
    const currentId = Number(insert.run("evt-current", "om-current", "oc_group", "group", "ou_current", "text", "当前", 1, "{}", now, now).lastInsertRowid);
    const current = { id: currentId, chat_id: "oc_group", chat_type: "group", root_message_id: null, thread_id: null };
    const context = loadLarkGroupContext(current, false, 3);
    assert.deepEqual(context.messages.map((item) => item.content), ["第4条", "第5条", "第6条"]);
    const formatted = formatRecentLarkMessages(context.messages, 1000, 0, context.hasMore);
    const [fourth, fifth, sixth] = context.messages;
    assert.equal(context.hasMore, true);
    assert.match(formatted, /已省略更早的消息/);
    assert.match(formatted, new RegExp(`\\[L${fourth.id}\\] \\[[^\\]]+\\] 林小夏：第4条`));
    assert.match(formatted, new RegExp(`\\[L${fifth.id}\\] \\[[^\\]]+\\] ou_5（回复 L${fourth.id}）：第5条`));
    assert.doesNotMatch(formatted, new RegExp(`回复 L${fourth.id}「第4条」`));
    assert.match(formatted, new RegExp(`\\[L${sixth.id}\\] \\[[^\\]]+\\] 机器人：第6条`));
    assert.ok(formatted.indexOf(`[L${fourth.id}]`) < formatted.indexOf(`[L${fifth.id}]`));
    assert.ok(formatted.indexOf(`[L${fifth.id}]`) < formatted.indexOf(`[L${sixth.id}]`));

    const outsideParentContext = loadLarkGroupContext(current, false, 2);
    const outsideParentFormatted = formatRecentLarkMessages(outsideParentContext.messages, 1000, 0, outsideParentContext.hasMore);
    assert.match(outsideParentFormatted, new RegExp(`回复窗口外的 L${fourth.id}「第4条」`));

    const delta = buildLarkCodexDeltaPrompt({
      id: currentId,
      message_id: "om-current",
      chat_id: "oc_group",
      chat_type: "group",
      sender_id: "ou_current",
      content: "当前",
      reply_to_message_id: "om-5",
      reply_to_message_type: "text",
      reply_to_content: "第5条"
    }, { recentMessages: context.messages, recentMessagesHasMore: context.hasMore });
    assert.ok(delta.indexOf(`[L${sixth.id}]`) < delta.indexOf("最新追加消息："));
    assert.match(delta, new RegExp(`\\[L${currentId}\\] ou_current（回复 L${fifth.id}）：当前`));
    assert.doesNotMatch(delta, /reply_to_message_id: om-5|reply_to_content: 第5条/);
    const paths = larkCodexTaskPaths({ id: currentId, message_id: "om-current", chat_id: "oc_group" }, false);
    assert.match(paths.taskDir, /lark-sessions/);
    assert.match(paths.taskDir, /untrusted/);
  } finally { store.close(); }
});

test("conversation runtime isolates Lark topics and bootstraps them with ordinary group background", () => {
  const { store } = fixture();
  try {
    const now = new Date().toISOString();
    const insert = store.db.prepare(`
      INSERT INTO lark_messages (
        event_id,message_id,chat_id,chat_type,sender_id,message_type,content,
        root_message_id,thread_id,mentioned,raw_json,received_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const add = (eventId: string, messageId: string, content: string, rootMessageId: string | null = null, threadId: string | null = null) => Number(insert.run(
      eventId, messageId, "oc_topics", "group", "ou_sender", "text", content,
      rootMessageId, threadId, 0, "{}", now, now
    ).lastInsertRowid);
    add("evt-main-1", "om-main-1", "普通背景一");
    add("evt-other-root", "om-other-root", "其他话题根消息");
    add("evt-other-reply", "om-other-reply", "其他话题回复", "om-other-root", "omt_other");
    add("evt-main-2", "om-main-2", "普通背景二");
    const mainReplyId = add("evt-main-reply", "om-main-reply", "普通直接回复", "om-main-2");
    const topicRootId = add("evt-topic-root", "om-topic-root", "当前话题根消息");
    add("evt-topic-reply", "om-topic-reply", "当前话题已有回复", "om-topic-root", "omt_topic");
    add("evt-other-late", "om-other-late", "其他话题后续", "om-other-root", "omt_other");
    const currentTopicId = add("evt-topic-current", "om-topic-current", "当前话题新消息", "om-topic-root", "omt_topic");
    const currentMainId = add("evt-main-current", "om-main-current", "普通群新消息");

    const topicMessage = { id: currentTopicId, chat_id: "oc_topics", chat_type: "group", root_message_id: "om-topic-root", thread_id: "omt_topic" };
    const topicContext = loadLarkGroupContext(topicMessage, false, 50, true);
    assert.equal(topicContext.contextKind, "topic");
    assert.deepEqual(topicContext.backgroundMessages.map((item) => item.content), ["普通背景一", "普通背景二", "普通直接回复"]);
    assert.deepEqual(topicContext.messages.map((item) => item.content), ["当前话题根消息", "当前话题已有回复"]);
    assert.equal(topicContext.messages[0]?.id, topicRootId);
    const topicPrompt = buildLarkCodexPrompt({
      id: currentTopicId,
      message_id: "om-topic-current",
      chat_id: "oc_topics",
      chat_type: "group",
      sender_id: "ou_sender",
      content: "当前话题新消息",
      reply_to_message_id: "om-topic-reply",
      reply_to_message_type: "text",
      reply_to_content: "当前话题已有回复"
    }, {
      backgroundMessages: topicContext.backgroundMessages,
      recentMessages: topicContext.messages,
      recentMessagesHasMore: topicContext.hasMore,
      contextKind: topicContext.contextKind
    });
    assert.ok(topicPrompt.indexOf("话题创建前的群聊背景") < topicPrompt.indexOf("当前话题上下文"));
    assert.ok(topicPrompt.indexOf("当前话题上下文") < topicPrompt.lastIndexOf("最新用户消息："));
    assert.doesNotMatch(topicPrompt, /其他话题根消息|其他话题回复|其他话题后续/);

    const mainMessage = { id: currentMainId, chat_id: "oc_topics", chat_type: "group", root_message_id: null, thread_id: null };
    const mainContext = loadLarkGroupContext(mainMessage, false, 50);
    assert.equal(mainContext.contextKind, "main");
    assert.deepEqual(mainContext.messages.map((item) => item.content), ["普通背景一", "普通背景二", "普通直接回复"]);
    const mainPrompt = buildLarkCodexDeltaPrompt({
      id: currentMainId,
      message_id: "om-main-current",
      chat_id: "oc_topics",
      chat_type: "group",
      sender_id: "ou_sender",
      content: "普通群新消息",
      reply_to_message_id: null,
      reply_to_message_type: null,
      reply_to_content: null
    }, {
      recentMessages: mainContext.messages,
      contextKind: mainContext.contextKind
    });
    assert.match(mainPrompt, /普通群聊上下文（不含任何话题消息/);
    assert.doesNotMatch(mainPrompt, /其他话题|当前话题/);

    const directReplyContext = loadLarkGroupContext({
      id: mainReplyId,
      chat_id: "oc_topics",
      root_message_id: "om-main-2",
      thread_id: null
    }, false, 50);
    assert.equal(directReplyContext.contextKind, "main");
    assert.deepEqual(directReplyContext.messages.map((item) => item.content), ["普通背景一", "普通背景二"]);

    assert.equal(larkMessageTopicKey(topicMessage), "omt_topic");
    assert.notEqual(larkCodexSessionKeyForMessage(topicMessage, false), larkCodexSessionKeyForMessage(mainMessage, false));
    assert.notEqual(larkCodexSessionKeyForMessage(topicMessage, false), larkCodexSessionKeyForMessage(topicMessage, true));
    assert.match(larkCodexSessionKeyForMessage(mainMessage, false) ?? "", /::main-v2::untrusted$/);
    assert.equal(larkCodexSessionKeyForMessage({ chat_id: "oc_private", chat_type: "p2p" }, false), "oc_private::untrusted");
    assert.match(larkCodexTaskPaths({ ...topicMessage, message_id: "om-topic-current" }, false).sessionDir, /topics[/\\]omt_topic/);
  } finally { store.close(); }
});

test("conversation runtime responder preserves steer ownership and orphan recovery", () => {
  const notifications = [{ method: "item/completed", params: { item: { type: "userMessage", clientId: "om_a", text: "A" } } }, { method: "item/completed", params: { item: { type: "agentMessage", phase: "commentary", text: "A progress" } } }, { method: "item/completed", params: { item: { type: "userMessage", clientId: "om_b", text: "B" } } }, { method: "item/completed", params: { item: { type: "agentMessage", phase: "final_answer", text: "B final" } } }];
  assert.deepEqual(notifications.map(larkCodexCompletedMessageEvent).filter(Boolean).map((item) => item?.type), ["user", "agent", "user", "agent"]);
  const { store } = fixture();
  try {
    const old = new Date(Date.now() - 180_000).toISOString();
    store.db.prepare("INSERT INTO lark_messages (event_id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,codex_status,codex_started_at,codex_last_heartbeat_at,raw_json,received_at,created_at) VALUES ('evt-orphan','om-orphan','oc','p2p','ou','text','hi',1,'running',?,?, '{}',?,?)").run(old, old, old, old);
    assert.equal(reconcileOrphanedLarkCodexRuns(Date.now(), true), 1);
    assert.equal((store.db.prepare("SELECT codex_status FROM lark_messages WHERE event_id='evt-orphan'").get() as { codex_status: string }).codex_status, "failed");
  } finally { store.close(); }
});
