import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { createHistoryImageBudget, createHistoryImageState, historyImagesAllowed, openLarkHistoryImage, searchLarkHistoryImages } from "./historyImages.js";

test("history image search and open stay within the current chat, topic and turn candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-history-images-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const taskDir = path.join(root, "task");
  fs.mkdirSync(taskDir);
  const insert = store.db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,chat_type,direction,sender_type,message_type,content,thread_id,root_message_id,message_at,raw_json,received_at,created_at)
    VALUES (?,?,?,'inbound','user',?,?,?,?,?,'{}',?,?)`);
  const add = (messageId: string, chatId: string, type: string, content: string, threadId: string | null = null, rootId: string | null = null) =>
    Number(insert.run(messageId, chatId, "group", type, content, threadId, rootId, "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z").lastInsertRowid);
  try {
    assert.equal(historyImagesAllowed(false, "group"), true);
    assert.equal(historyImagesAllowed(true, "group"), true);
    assert.equal(historyImagesAllowed(false, "p2p"), true);
    assert.equal(historyImagesAllowed(true, null), false);
    assert.equal(historyImagesAllowed(false, "unknown"), false);
    const single = add("om_single", "oc_group", "image", "[Image: img_single]");
    const post = add("om_post", "oc_group", "post", "![Image](img_first) ![Image](img_second)");
    const rootId = add("om_root", "oc_group", "post", "![Image](img_topic_root)");
    const topic = add("om_topic", "oc_group", "image", "[Image: img_topic]", "thread_A", "om_root");
    const other = add("om_other", "oc_other", "image", "[Image: img_other]");
    const currentId = add("om_current", "oc_group", "text", "请找之前的图");
    const main = { id: currentId, chat_id: "oc_group", chat_type: "group", thread_id: null, root_message_id: null };
    const state = createHistoryImageState();
    const search = searchLarkHistoryImages(store.db, main, state, { limit: 10 });
    assert.equal(search.success, true);
    const listed = JSON.parse((search.contentItems[0] as { text: string }).text) as { images: Array<{ localId: number; imageCount: number }> };
    assert.deepEqual(listed.images.map((item) => [item.localId, item.imageCount]), [[post, 2], [single, 1]]);
    const firstPage = searchLarkHistoryImages(store.db, main, createHistoryImageState(), { limit: 1 });
    const firstPageBody = JSON.parse((firstPage.contentItems[0] as { text: string }).text) as { nextBeforeLocalId: number };
    assert.equal(firstPageBody.nextBeforeLocalId, post);
    const secondPage = searchLarkHistoryImages(store.db, main, createHistoryImageState(), { limit: 1, beforeLocalId: firstPageBody.nextBeforeLocalId });
    const secondPageBody = JSON.parse((secondPage.contentItems[0] as { text: string }).text) as { images: Array<{ localId: number }> };
    assert.equal(secondPageBody.images[0]?.localId, single);
    assert.equal((await openLarkHistoryImage(store.db, main, taskDir, state, { localId: topic, imageIndex: 1 })).success, false);
    assert.equal((await openLarkHistoryImage(store.db, main, taskDir, state, { localId: other, imageIndex: 1 })).success, false);
    let downloaded: { messageId: string; imageKey: string } | null = null;
    const opened = await openLarkHistoryImage(store.db, main, taskDir, state, { localId: post, imageIndex: 2 }, (messageId, imageKey) => {
      downloaded = { messageId, imageKey };
      const file = path.join(taskDir, "history.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      fs.writeFileSync(file, bytes);
      return { path: file, mimeType: "image/png", bytes };
    });
    assert.equal(opened.success, true);
    assert.deepEqual(downloaded, { messageId: "om_post", imageKey: "img_second" });
    assert.equal(opened.contentItems[1].type, "inputImage");
    const topicCurrent = { id: currentId + 1, chat_id: "oc_group", chat_type: "group", thread_id: "thread_A", root_message_id: "om_root" };
    const topicResults = searchLarkHistoryImages(store.db, topicCurrent, createHistoryImageState(), {});
    const topicListed = JSON.parse((topicResults.contentItems[0] as { text: string }).text) as { images: Array<{ localId: number }> };
    assert.deepEqual(topicListed.images.map((item) => item.localId), [topic, rootId]);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("parallel calls and steered messages share the four-image turn budget",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-image-budget-"));
  const store=new SqliteAgentStore(path.join(root,"test.sqlite"));
  try {
    const now=new Date().toISOString();
    const insert=store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,message_type,content,raw_json,received_at,created_at) VALUES (?,?,'oc_current','group','image',?,'{}',?,?)");
    for(let id=1;id<=6;id++)insert.run(id,`om_${id}`,`[Image: img_${id}]`,now,now);
    const current={id:10,chat_id:"oc_current",chat_type:"group",thread_id:null,root_message_id:null};
    const budget=createHistoryImageBudget();const first=createHistoryImageState();const second=createHistoryImageState();first.budget=budget;second.budget=budget;
    searchLarkHistoryImages(store.db,current,first,{});searchLarkHistoryImages(store.db,{...current,id:11},second,{});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let downloads=0;
    const download=async(_message:string,_key:string,_directory:string,id:number)=>{downloads++;await gate;return {path:path.join(root,`${id}.png`),mimeType:"image/png",bytes:Buffer.from([1])};};
    const pending=[1,2,3,4].map(id=>openLarkHistoryImage(store.db,current,root,first,{localId:id,imageIndex:1},download));
    const denied=await openLarkHistoryImage(store.db,current,root,second,{localId:5,imageIndex:1},download);
    assert.equal(denied.success,false);assert.equal(downloads,4);release();
    assert((await Promise.all(pending)).every(result=>result.success));
    assert.equal((await openLarkHistoryImage(store.db,current,root,second,{localId:6,imageIndex:1},download)).success,false);
    assert.equal(budget.opened.size,4);
    const fresh=createHistoryImageState();searchLarkHistoryImages(store.db,current,fresh,{});
    assert.equal((await openLarkHistoryImage(store.db,current,root,fresh,{localId:5,imageIndex:1},download)).success,true);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("a real historical Feishu image opens from an isolated database", {
  skip: !process.env.LARK_HISTORY_IMAGE_SMOKE_MESSAGE_ID || !process.env.LARK_HISTORY_IMAGE_SMOKE_IMAGE_KEY
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-history-image-smoke-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  const messageId = process.env.LARK_HISTORY_IMAGE_SMOKE_MESSAGE_ID!;
  const imageKey = process.env.LARK_HISTORY_IMAGE_SMOKE_IMAGE_KEY!;
  const now = new Date().toISOString();
  try {
    const insert = store.db.prepare(`INSERT INTO lark_messages
      (message_id,chat_id,chat_type,direction,sender_type,message_type,content,message_at,raw_json,received_at,created_at)
      VALUES (?,'oc_smoke','group','inbound','user',?,? ,?,'{}',?,?)`);
    const oldId = Number(insert.run(messageId, "post", `![Image](${imageKey})`, now, now, now).lastInsertRowid);
    const currentId = Number(insert.run("om_current_smoke", "text", "看看之前那张图", now, now, now).lastInsertRowid);
    const current = { id: currentId, chat_id: "oc_smoke", chat_type: "group", thread_id: null, root_message_id: null };
    const state = createHistoryImageState();
    const search = searchLarkHistoryImages(store.db, current, state, {});
    assert.equal(search.success, true);
    const opened = await openLarkHistoryImage(store.db, current, root, state, { localId: oldId, imageIndex: 1 });
    assert.equal(opened.success, true, (opened.contentItems[0] as { text?: string }).text);
    assert.equal(opened.contentItems[1]?.type, "inputImage");
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
