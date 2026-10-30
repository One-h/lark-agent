import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import type { LarkReplyPresentation } from "@lark-agent/adapter-lark-cli";
import { enqueueLarkCodexReply, retryPendingLarkTextReplies, retryPendingLarkMediaReplies, retryPendingLarkCompletionReactions } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

async function until(check: () => boolean) {
  const deadline = performance.now() + 7000;
  while (!check()) { assert(performance.now() < deadline, "rich reply fixture timed out"); await immediate(); }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-rich-replies-"));
  const executable = path.join(root, "codex.mjs"), answer = path.join(root, "answer.txt");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";import readline from "node:readline";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");let turn=0;
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);
 if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"rich-thread"}}});
 else if(m.method==="thread/loaded/list")send({id:m.id,result:{data:["rich-thread"],nextCursor:null}});
 else if(m.method==="thread/list")send({id:m.id,result:{data:m.params.archived?[]:[{id:"rich-thread"}],nextCursor:null}});
 else if(m.method==="turn/start"){
  const id="rich-turn-"+(++turn);send({id:m.id,result:{turn:{id,status:"inProgress"}}});
  setTimeout(()=>{const item={id:"answer",type:"agentMessage",phase:"final_answer",text:fs.readFileSync(${JSON.stringify(answer)},"utf8")};
   send({method:"item/completed",params:{threadId:"rich-thread",turnId:id,item}});
   send({method:"turn/completed",params:{threadId:"rich-thread",turn:{id,status:"completed",items:[item]}}});},20);
 }else if(m.method)send({id:m.id,result:{}});
});`);
  fs.chmodSync(executable, 0o755);
  const previousExecutable = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = executable;
  const sent: Array<{ text: string; key: string; presentation?: LarkReplyPresentation }> = [], media: string[] = [], events: string[] = [];
  let failText = false, failMedia = false, missingReceipt = false;
  const options = { databasePath: path.join(root, "test.sqlite"), mode: "active" as const, workspaceRoot: root, trustedSenderIds: [],
    textReplySender: (_id: string, text: string, key: string, presentation?: LarkReplyPresentation) => {
      sent.push({ text, key, presentation: presentation ? JSON.parse(JSON.stringify(presentation)) : undefined });
      events.push(failText ? "text-failed" : "text-sent");
      return failText ? { ok: false as const, error: "fixture network failure" } : { ok: true as const, messageId: missingReceipt ? null : `om_sent${sent.length}`, chatId: "oc_fixture", messageAt: new Date().toISOString(), messageType: presentation?.msgType ?? "text" };
    }, reactionSender: (_id: string, emoji: string) => { events.push(emoji); return { ok: true as const }; }
  };
  let runtime = createRuntime(options);
  const mediaSender = (_id: string, taskDir: string, relative: string) => {
    events.push(failMedia ? "media-failed" : "media-sent");
    if (failMedia) return { ok: false as const, error: "fixture media failure" };
    media.push(fs.readFileSync(path.resolve(taskDir, relative), "utf8")); return { ok: true as const };
  };
  // Use the public configuration seam; production transport is never invoked by this fixture.
  const installMedia = async () => { const context = await import("../../../packages/conversation-runtime/src/context.js");
    context.configureConversationRuntime({ database: runtime.store.db, mode: "active", repoRoot: root, workspaceRoot: root,
      larkStickerDirectory: path.join(root, "stickers"), textReplySender: options.textReplySender, mediaReplySender: mediaSender, reactionSender: options.reactionSender }); };
  const row = (id = 1) => runtime.store.db.prepare("SELECT * FROM lark_messages WHERE id=?").get(id) as any;
  const due = () => { runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='1970-01-01' WHERE reply_status='pending'").run();
    runtime.store.db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at='1970-01-01' WHERE status='pending'").run(); };
  return { root, sent, media, events, row, due, get runtime() { return runtime; },
    failText(value: boolean) { failText = value; }, failMedia(value: boolean) { failMedia = value; }, missingReceipt(value: boolean) { missingReceipt = value; },
    async start(source: string) {
      await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { stickerUsageMode: "off", executionReceiptsEnabled: false, interimRepliesEnabled: false } });
      await installMedia(); fs.writeFileSync(answer, source);
      const now = new Date().toISOString();
      runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,sender_type,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at)
        VALUES(1,'om_source','oc_fixture','group','ou_sender','user','text','fixture request',1,'mention','skipped','failed','{}',?,?)`).run(now, now);
      assert.equal(enqueueLarkCodexReply(1), true); await until(() => row()?.codex_status === "answered");
    },
    async reopen() { await runtime.app.close(); runtime.stop(); runtime = createRuntime(options); await installMedia(); },
    async close() { await runtime.app.close(); runtime.stop(); if (previousExecutable === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previousExecutable; fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test("native final replies deliver post/card snapshots and archive readable original Markdown", async () => {
  for (const source of ["## Result\n\n- Explanation one\n- Explanation two", "| Name | Count |\n| --- | --- |\n| Demo | 2 |"] ) {
    const f = fixture(); try {
      await f.start(source);
      const expected = source.startsWith("|") ? "interactive" : "post";
      assert.equal(f.sent.length, 1); assert.equal(f.sent[0].presentation?.msgType, expected);
      const archived = f.runtime.store.db.prepare("SELECT content,message_type FROM lark_messages WHERE direction='outbound'").get() as any;
      assert.equal(archived.message_type, expected); assert.ok(archived.content.endsWith(source));
      assert.doesNotMatch(archived.content, /\"schema\":\"2.0\"/);
      assert.equal(f.row().codex_reply, source); assert.equal(f.row().reply_status, "sent");
      assert.equal(f.events.filter(item => item === "DONE").length, 1);
    } finally { await f.close(); }
  }
});

test("failed rich replies survive restart and retry the exact snapshot and idempotency key", async () => {
  const f = fixture(); try {
    f.failText(true); await f.start("| A | B |\n| --- | --- |\n| Demo | 2 |");
    const snapshot = f.row().reply_delivery_payload, key = f.row().reply_delivery_key;
    assert.equal(f.row().reply_status, "pending"); assert.equal(f.events.includes("DONE"), false);
    f.runtime.store.db.prepare("UPDATE lark_messages SET reply_next_attempt_at='2999-01-01',codex_reply='later diagnostics are not a delivery template' WHERE id=1").run();
    await f.reopen(); f.failText(false); f.due(); retryPendingLarkTextReplies(); retryPendingLarkCompletionReactions();
    assert.equal(f.row().reply_delivery_payload, snapshot); assert.equal(f.sent[1].key, key);
    assert.deepEqual(f.sent[0].presentation, f.sent[1].presentation);
    assert.equal(f.row().reply_status, "sent"); assert.equal(f.events.filter(item => item === "DONE").length, 1);
  } finally { await f.close(); }
});

test("large results keep the complete attachment, wait for text receipt and wait for media before DONE", async () => {
  const f = fixture(); try {
    const source = "| Name | Count |\n| --- | --- |\n" + Array.from({ length: 30 }, (_, i) => `| item ${i} | ${i} |`).join("\n");
    f.failText(true); f.failMedia(true); await f.start(source);
    assert.equal(f.media.length, 0); assert.equal(f.events.includes("media-failed"), false); assert.equal(f.events.includes("DONE"), false);
    assert.match(f.row().reply_delivery_payload, /共 30 行/);
    f.failText(false); f.due(); retryPendingLarkTextReplies(); retryPendingLarkMediaReplies(); retryPendingLarkCompletionReactions();
    assert.equal(f.events.includes("media-failed"), true); assert.equal(f.events.includes("DONE"), false);
    f.failMedia(false); f.due(); retryPendingLarkMediaReplies(); retryPendingLarkCompletionReactions();
    assert.equal(f.media.length, 1); assert.equal(f.media[0], source); assert.match(f.media[0], /^\| Name \| Count \|/);
    assert.doesNotMatch(f.media[0], /<at user_id/); assert.match(f.media[0], /item 29/);
    assert.ok(f.events.indexOf("text-sent") < f.events.indexOf("media-sent"));
    assert.ok(f.events.indexOf("media-sent") < f.events.indexOf("DONE"));
    retryPendingLarkMediaReplies(); retryPendingLarkCompletionReactions(); assert.equal(f.media.length, 1);
  } finally { await f.close(); }
});

test("missing rich delivery receipts and corrupt snapshots never mark delivery complete", async () => {
  const f = fixture(); try {
    f.missingReceipt(true); await f.start("**Ready**");
    assert.equal(f.row().reply_status, "pending"); assert.equal(f.events.includes("DONE"), false);
    const attempts = f.sent.length;
    f.runtime.store.db.prepare("UPDATE lark_messages SET reply_delivery_payload='{}' WHERE id=1").run();
    f.due(); retryPendingLarkTextReplies(); retryPendingLarkCompletionReactions();
    assert.equal(f.sent.length, attempts); assert.equal(f.row().reply_status, "failed"); assert.equal(f.events.includes("DONE"), false);
  } finally { await f.close(); }
});

test("legacy pending replies have no snapshot and retain their original literal text transport", async () => {
  const f = fixture(); try {
    const now = new Date().toISOString();
    f.runtime.store.db.prepare(`INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,content,reply_status,codex_status,reply_delivery_text,reply_delivery_key,reply_next_attempt_at,raw_json,received_at,created_at)
      VALUES(1,'om_legacy','oc_fixture','p2p','ou_sender','legacy','pending','answered','literal **stars**','legacy-key','1970-01-01','{}',?,?)`).run(now, now);
    retryPendingLarkTextReplies();
    assert.equal(f.sent[0].presentation, undefined); assert.equal(f.sent[0].text, "literal **stars**"); assert.equal(f.sent[0].key, "legacy-key");
    assert.equal(f.row().reply_status, "sent");
  } finally { await f.close(); }
});
