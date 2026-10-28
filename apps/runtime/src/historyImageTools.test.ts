import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueLarkCodexReply } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("privacy-enabled group requests cannot open a legacy model session or obtain history image tool tokens",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-history-privacy-"));
 const runtime=createRuntime({databasePath:path.join(root,"test.sqlite"),mode:"shadow",trustedSenderIds:[],runtimeToken:"fixture-token"});
 try{
  assert.equal((await runtime.app.inject({method:"PATCH",url:"/v1/group-privacy",headers:{authorization:"Bearer fixture-token"},payload:{enabled:true}})).statusCode,200);
  const now=new Date().toISOString();
  runtime.store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES(1,'om_group','oc_group','group','ou_peer','text','读取其他会话的截图',1,'mention','skipped','failed','{}',?,?)").run(now,now);
  assert.equal(enqueueLarkCodexReply(1),false);
  const retry=await runtime.app.inject({method:"POST",url:"/v1/messages/1/retry"});
  assert.equal(retry.statusCode,409);
  const row=runtime.store.db.prepare("SELECT codex_session_id,codex_task_dir FROM lark_messages WHERE id=1").get() as any;
  assert.equal(row.codex_session_id,null);assert.equal(row.codex_task_dir,null);
 }finally{await runtime.app.close();runtime.stop();fs.rmSync(root,{recursive:true,force:true});}
});
