import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchLarkReplyReceipt, readLarkReplyReceipt } from "./replyReadback.js";

test("reply readback requires unique exact content, creation time, bot and quoted message", () => {
  const attemptedAt = "2026-11-23T12:00:00.000Z", bot = { appId:"cli_fixture",openId:"ou_fixture" };
  const input = { chatId:"oc_fixture",threadId:null,replyTo:"om_input",attemptedAt,msgType:"text",content:{ text:"fixture result" } };
  const found = { message_id:"om_output",chat_id:"oc_fixture",parent_id:"om_input",msg_type:"text",create_time:String(Date.parse(attemptedAt)+3),
    sender:{sender_type:"app",id_type:"app_id",id:"cli_fixture"},body:{content:JSON.stringify(input.content)},deleted:false };
  assert.equal(matchLarkReplyReceipt(input,[found],bot)?.messageId,"om_output");
  for (const impostor of [
    { ...found,parent_id:"om_other" }, { ...found,chat_id:"oc_other" }, { ...found,updated:true },
    { ...found,create_time:String(Date.parse(attemptedAt)-1) }, { ...found,sender:{...found.sender,id:"cli_other"} },
    { ...found,body:{content:'{"text":"different"}'} }, { ...found,deleted:true }
  ]) assert.equal(matchLarkReplyReceipt(input,[impostor],bot),undefined);
  assert.equal(matchLarkReplyReceipt(input,[found,{...found,message_id:"om_duplicate"}],bot),undefined);
});

test("reply readback uses only bot history GET and accepts a matching receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"lark-reply-receipt-"));
  const oldPath = process.env.PATH;
  try {
    const at = Date.now()-10_000;
    const payload = {ok:true,identity:"bot",data:{items:[{
      message_id:"om_output",chat_id:"oc_fixture",parent_id:"om_input",msg_type:"text",create_time:String(at+500),
      sender:{sender_type:"app",id_type:"app_id",id:"cli_fixture"},body:{content:'{"text":"result"}'},deleted:false
    }],has_more:false}};
    fs.writeFileSync(path.join(root,"lark-cli"), `#!/bin/sh
if [ "$1" = auth ]; then
  printf '%s\\n' '{"appId":"cli_fixture","verified":true,"identities":{"bot":{"verified":true,"openId":"ou_fixture"}}}'
elif [ "$1 $2 $3 $4 $5" = 'api GET /open-apis/im/v1/messages --as bot' ]; then
  printf '%s\\n' '${JSON.stringify(payload)}'
else
  exit 42
fi
`, {mode:0o700});
    process.env.PATH = root;
    const receipt = await readLarkReplyReceipt({chatId:"oc_fixture",threadId:null,replyTo:"om_input",attemptedAt:new Date(at).toISOString(),
      msgType:"text",content:{text:"result"}});
    assert.equal(receipt?.messageId,"om_output");
  } finally {
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
