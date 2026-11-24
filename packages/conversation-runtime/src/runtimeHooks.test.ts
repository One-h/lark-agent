import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteAgentStore } from "../../adapter-sqlite/src/index.js";
import { applyLarkRoute, collectLarkTurnContext, registerLarkRouteBroker, registerLarkRuntimePlugin } from "./runtimeHooks.js";
import { recordLarkDeliveryConfirmation, readLarkDeliveryConfirmations } from "./deliveryConfirmations.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-extension-hooks-"));
  const file = path.join(root, "fixture.sqlite");
  const store = new SqliteAgentStore(file);
  return { store, file, close() { if (store.db.open) store.close(); fs.rmSync(root,{recursive:true,force:true}); } };
}

test("route brokers require verified scoped claims, ignore ordering, and roll back failed admission", () => {
  const f = fixture();
  const db = f.store.db;
  db.exec("CREATE TABLE fixture_work (claim TEXT PRIMARY KEY)");
  let matching = 0;
  const source = Object.freeze({ message_id: "om_reply", chat_id:"oc_target", sender_id:"ou_user",
    reply_to:"om_ask", message_type:"text", chat_type:"group", sender_type:"user", content:"private reply" });
  const workCount = () => db.prepare("SELECT count(*) FROM fixture_work").pluck().get();
  const primary = registerLarkRouteBroker(db,"group-question", {
    verify(input, key) { return key === "registered" && input.chatId === "oc_target" && input.senderId === "ou_user" && input.replyTo === "om_ask"; },
    commit(_input, key) { db.prepare("INSERT INTO fixture_work VALUES(?)").run(key); return true; }
  });
  const base = registerLarkRuntimePlugin(db,{id:"claimant",route(input) {
    matching++;
    assert(Object.isFrozen(input));
    assert(!Object.hasOwn(input,"content"));
    return {broker:"group-question",claimId:"registered"};
  }});
  const failing = registerLarkRuntimePlugin(db,{id:"failing",route() { throw Error("fixture"); }});
  try {
    assert.equal(applyLarkRoute(db,source,false),false);
    assert.equal(matching,0);
    assert.equal(applyLarkRoute(db,{...source,reply_to:"om_wrong"},true),false);
    assert.equal(workCount(),0);
    const other = registerLarkRouteBroker(db,"other-route", { verify:()=>true, commit:()=>assert.fail("conflict selected a broker") });
    const conflict = registerLarkRuntimePlugin(db,{id:"another",route:()=>({broker:"other-route",claimId:"another"})});
    assert.equal(applyLarkRoute(db,source,true),false); assert.equal(workCount(),0);
    conflict();other();
    assert.throws(db.transaction(() => {
      assert.equal(applyLarkRoute(db,source,true),true);
      throw Error("admission write failed");
    }), /admission write failed/);
    assert.equal(workCount(),0);
    assert.equal(applyLarkRoute(db,source,true),true);
    assert.equal(workCount(),1);
  } finally { failing();base();primary();f.close(); }
});

test("prepare callbacks see one immutable input and do not block or overwrite other fragments", async () => {
  const f = fixture();
  const db = f.store.db;
  let aborted = false;
  const remove = [
    registerLarkRuntimePlugin(db,{id:"z-last",prepare:async input=>input.text+" last"}),
    registerLarkRuntimePlugin(db,{id:"b-hangs",prepare(_i,signal) {
      signal.addEventListener("abort",()=>{aborted=true;},{once:true});
      return new Promise(()=>{});
    }}),
    registerLarkRuntimePlugin(db,{id:"c-throws",prepare:()=>{throw Error("fixture");}}),
    registerLarkRuntimePlugin(db,{id:"a-first",prepare(input) {
      assert(Object.isFrozen(input));
      return input.text+" first";
    }}),
  ];
  try {
    const result=await collectLarkTurnContext(db,{sourceMessageId:1,engineId:"codex",chatId:null,chatType:"p2p",trusted:false,text:"original"});
    assert(aborted);
    assert.match(result,/original first[^]*original last/);
    assert.doesNotMatch(result,/b-hangs|c-throws/);
    remove.forEach(stop=>stop());
    assert.equal(await collectLarkTurnContext(db,{sourceMessageId:1,engineId:"codex",chatId:null,chatType:"p2p",trusted:false,text:"original"}),"");
  } finally { remove.forEach(stop=>stop());f.close(); }
});

test("delivery confirmations require a receipt and replay by stable cursor after reopening", () => {
  const f = fixture();
  const db = f.store.db;
  db.prepare(`INSERT INTO lark_messages(id,direction,message_id,raw_json,received_at,created_at,codex_turn_id,codex_session_id)
    VALUES(1,'inbound','om_reply','{}','fixture','fixture','turn','session')`).run();
  const input = { messageId:1, confirmation:"send", deliveryKind:"attachment", confirmedAt:"fixture", expectedTurnId:"turn" } as const;
  try {
    assert.equal(recordLarkDeliveryConfirmation(db,{...input,receipt:null}),undefined);
    assert.equal(recordLarkDeliveryConfirmation(db,{...input,receipt:"om_attachment",expectedTurnId:"other"}),undefined);
    const result = recordLarkDeliveryConfirmation(db,{...input,receipt:"om_attachment"});
    assert(result?.eventId);
    assert.equal(recordLarkDeliveryConfirmation(db,{...input,receipt:"om_attachment"}),undefined);
    const notice = recordLarkDeliveryConfirmation(db,{...input,deliveryKind:"notice",receipt:"om_notice"});
    assert(notice?.eventId);
    f.store.close();
    const next = new SqliteAgentStore(f.file);
    try {
      assert.deepEqual(readLarkDeliveryConfirmations(next.db,0),[result,notice]);
      assert.deepEqual(readLarkDeliveryConfirmations(next.db,result.eventId),[notice]);
      assert(!JSON.stringify(result).includes("om_attachment"));
    } finally { next.close(); }
  } finally { f.close(); }
});
