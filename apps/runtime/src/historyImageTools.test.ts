import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config as conversationConfig, enqueueLarkCodexReply } from "@lark-agent/conversation-runtime";
import { createRuntime } from "./index.js";

test("untrusted group turn can search and open history pixels through MCP with stickers off",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-history-tool-"));
  const codex=path.join(root,"codex.mjs");
  fs.writeFileSync(codex,`#!${process.execPath}
import readline from "node:readline";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="thread/start"||m.method==="thread/resume")send({id:m.id,result:{thread:{id:"image-thread"},model:m.params.model}});
 else if(m.method==="thread/loaded/list")send({id:m.id,result:{data:["image-thread"],nextCursor:null}});
 else if(m.method==="turn/start"){send({id:m.id,result:{turn:{id:"image-turn",status:"inProgress"}}});send({method:"turn/started",params:{threadId:"image-thread",turn:{id:"image-turn",status:"inProgress"}}});}
 else if(m.method)send({id:m.id,result:{}});
});
`);fs.chmodSync(codex,0o755);
  const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==";
  const downloads=path.join(root,"downloads.jsonl");
  const cli=path.join(root,"lark-cli");
  fs.writeFileSync(cli,`#!${process.execPath}
import fs from "node:fs";import path from "node:path";
const args=process.argv.slice(2);
if(args.includes("+messages-resources-download")){
 const output=args[args.indexOf("--output")+1];fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(${JSON.stringify(png)},"base64"));
 fs.appendFileSync(${JSON.stringify(downloads)},JSON.stringify(args)+"\\n");console.log(JSON.stringify({ok:true,data:{saved_path:output}}));
}else console.log(JSON.stringify({ok:true,data:{message_id:"om_fixture"}}));
`);fs.chmodSync(cli,0o755);
  const previousPath=process.env.PATH;const previousCodex=process.env.CODEX_EXECUTABLE;
  process.env.PATH=`${root}:${previousPath ?? ""}`;process.env.CODEX_EXECUTABLE=codex;
  const runtime=createRuntime({databasePath:path.join(root,"test.sqlite"),mode:"active",workspaceRoot:root,trustedSenderIds:[],runtimeToken:"fixture-secret",port:0});
  const client=new Client({name:"history-image-test",version:"1"});
  try {
    await runtime.app.inject({method:"PATCH",url:"/v1/settings",payload:{stickerUsageMode:"off",executionReceiptsEnabled:false,interimRepliesEnabled:false}});
    const now=new Date().toISOString();
    const insert=runtime.store.db.prepare("INSERT INTO lark_messages(id,message_id,chat_id,chat_type,sender_id,message_type,content,thread_id,root_message_id,mentioned,reply_trigger,reply_status,codex_status,raw_json,received_at,created_at) VALUES (?,?,?,'group','ou_untrusted',?,?,?,?,1,'mention','skipped','failed','{}',?,?)");
    insert.run(1,"om_old","oc_current","image","[Image: img_fixture]",null,null,now,now);
    insert.run(2,"om_other","oc_other","image","[Image: img_other]",null,null,now,now);
    insert.run(3,"om_topic","oc_current","image","[Image: img_topic]","thread_a","om_root",now,now);
    insert.run(4,"om_root","oc_current","image","[Image: img_root]",null,null,now,now);
    insert.run(10,"om_current","oc_current","text","查看之前的截图",null,null,now,now);
    await runtime.app.listen({host:"127.0.0.1",port:0});
    const address=runtime.app.server.address();assert(address&&typeof address!=="string");
    conversationConfig.larkAgentRuntimeUrl=`http://127.0.0.1:${address.port}`;
    assert.equal(enqueueLarkCodexReply(10),true);
    let token="";let taskDir="";
    for(let i=0;i<200;i++){
      await new Promise(resolve=>setTimeout(resolve,25));
      const row=runtime.store.db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id=10").get() as {codex_task_dir:string|null};
      if(!row.codex_task_dir)continue;taskDir=row.codex_task_dir;
      const promptFile=path.join(taskDir,"prompt.md");if(!fs.existsSync(promptFile))continue;
      const prompt=fs.readFileSync(promptFile,"utf8");assert.match(prompt,/history_images_search/);
      token=prompt.match(/context_token=([A-Za-z0-9_-]{32})/)?.[1] ?? "";
      const sessionFile=path.join(taskDir,"resume-session.json");
      if(token&&fs.existsSync(sessionFile)&&JSON.parse(fs.readFileSync(sessionFile,"utf8")).currentTurnId==="image-turn")break;
    }
    assert.equal(token.length,32);
    assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir,"resume-session.json"),"utf8")).currentTurnId,"image-turn");
    const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(sourceRoot,"node_modules/tsx/dist/cli.mjs"),path.join(sourceRoot,"packages/mcp-stickers/src/index.ts")],cwd:sourceRoot,
      env:{...process.env,LARK_AGENT_RUNTIME_URL:`http://127.0.0.1:${address.port}`,LARK_AGENT_RUNTIME_TOKEN:"fixture-secret"} as Record<string,string>}));
    const search=await client.callTool({name:"history_images_search",arguments:{context_token:token}});
    assert.equal(search.isError,false,JSON.stringify({search,row:runtime.store.db.prepare("SELECT codex_status,codex_error FROM lark_messages WHERE id=10").get(),log:fs.readFileSync(path.join(taskDir,"codex.stdout.jsonl"),"utf8").slice(-2500)}));
    const entries=search.content as Array<{type:string;text?:string}>;
    assert.equal(entries.some(item=>item.type==="image"),false);
    const metadata=JSON.parse(entries.find(item=>item.type==="text")!.text!);
    assert.deepEqual(metadata.images.map((item:{localId:number})=>item.localId),[1]);
    const open=await client.callTool({name:"history_images_open",arguments:{context_token:token,local_id:1,image_index:1}});
    assert.equal(open.isError,false,JSON.stringify(open));
    assert((open.content as Array<{type:string;mimeType?:string;data?:string}>).some(item=>item.type==="image"&&item.mimeType==="image/png"&&item.data===png));
    for(const id of [2,3,4,10])assert.equal((await client.callTool({name:"history_images_open",arguments:{context_token:token,local_id:id,image_index:1}})).isError,true);
    assert.equal((await client.callTool({name:"history_images_search",arguments:{context_token:"z".repeat(32)}})).isError,true);
    assert.equal(fs.readFileSync(downloads,"utf8").trim().split("\n").length,1);
    assert.match(fs.readFileSync(path.join(taskDir,"codex.stdout.jsonl"),"utf8"),/history_images_open/);
  } finally {
    await client.close();await runtime.app.close();runtime.stop();
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousCodex===undefined)delete process.env.CODEX_EXECUTABLE;else process.env.CODEX_EXECUTABLE=previousCodex;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
