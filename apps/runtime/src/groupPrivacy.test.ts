import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import {SqliteAgentStore} from "@lark-agent/adapter-sqlite";
import {GroupPrivacy,registerGroupPrivacyRoutes} from "./groupPrivacy.js";
import {CompanyFiles} from "./companyFiles.js";
import {executeCompanyOperation} from "./companyOperation.js";
import {isolatedPrivacyPlan,privateProcessEnvironment} from "./privacyIsolation.js";
const message={messageId:"om_group",chatId:"oc_group",chatType:"group" as const,chatName:"工作群",senderId:"ou_peer",senderName:"同事",content:"请解释本群方案",sourceTime:new Date().toISOString(),messageType:"text"};
async function fixture(run:(f:any)=>Promise<void>){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"lark-group-privacy-")),root=fs.realpathSync(temporary),work=path.join(root,"work");fs.mkdirSync(work);
 const store=new SqliteAgentStore(path.join(temporary,"test.sqlite")),calls:string[][]=[],inputs:any[]=[],executed:any[]=[],forwarded:any[]=[];
 const options={ownerId:()=>"ou_owner",model:()=>"fixture",cli:async(args:string[])=>{calls.push(args);return {data:{message_id:"om_sent"}};},
  plan:async(input:unknown,_model:string)=>{inputs.push({input});return {category:"public" as const,draft:"这是一段草稿",reason:"需要审核"};},
  execute:async(root:string,argv:string[])=>{executed.push({root,argv});return "执行成功";},forward:(m:unknown,identity:string)=>{forwarded.push({m,identity});return true;}};
 const privacy=new GroupPrivacy(store,options);
 try{await run({root,work,store,calls,inputs,executed,forwarded,options,privacy,row:()=>privacy.snapshot().messages[0] as any});}
 finally{await privacy.stop();store.close();fs.rmSync(root,{recursive:true,force:true});}
}
test("generated group answers only become owner drafts, even if a model calls them public",async()=>fixture(async({privacy,calls,row}:any)=>{
 privacy.ingest(message,"bot");await privacy.tick();assert.equal(row().status,"needs_owner");assert.ok(calls.every((c:string[])=>c.includes("--user-id")&&c.includes("ou_owner")));assert.equal(calls.some((c:string[])=>c.includes("+messages-reply")),false);
}));
test("a publication approves exact text once, rejects stale decisions, and never grants execution",async()=>fixture(async({privacy,calls,executed,row}:any)=>{
 privacy.ingest(message,"bot");await privacy.tick();const before=row();await assert.rejects(privacy.decide(before.id,{action:"publish",text:"确定文本",version:0}),/刷新/);
 await privacy.decide(before.id,{action:"publish",text:"确定文本",version:before.version});const sent=calls.find((c:string[])=>c.includes("+messages-reply"));assert.ok(sent.includes("确定文本\n（小龙的助手龙小祝，经小龙确认）"));assert.equal(executed.length,0);assert.equal(row().status,"sent");await assert.rejects(privacy.decide(before.id,{action:"publish",text:"再发",version:row().version}),/刷新/);
}));
test("group worker receives only the current group and cannot query other group or private history",async()=>fixture(async({privacy,store,inputs}:any)=>{
 const now=new Date().toISOString();const add=store.db.prepare("INSERT INTO lark_messages(message_id,chat_id,chat_type,sender_id,message_type,content,raw_json,received_at,created_at)VALUES(?,?,?,?,? ,?,'{}',?,?)");
 add.run("om_other","oc_other","group","ou_other","text","OTHER_GROUP_CANARY",now,now);add.run("om_private","oc_private","p2p","ou_owner","text","PRIVATE_CHAT_CANARY",now,now);add.run(message.messageId,message.chatId,"group",message.senderId,"text",message.content,now,now);
 privacy.ingest(message,"bot");await privacy.tick();const input=JSON.stringify(inputs[0].input);assert.ok(input.includes(message.content));assert.ok(!input.includes("OTHER_GROUP_CANARY"));assert.ok(!input.includes("PRIVATE_CHAT_CANARY"));assert.equal(inputs[0].tools,undefined);
}));
test("company file broker refuses traversal, symlink and hardlink escapes, credentials, personal paths and databases",async()=>fixture(async({root,work}:any)=>{
 const personal=path.join(root,"personal");fs.mkdirSync(personal);fs.writeFileSync(path.join(personal,"note.txt"),"PRIVATE_CANARY");
 fs.writeFileSync(path.join(work,"guide.md"),"公司公开方案");fs.writeFileSync(path.join(work,".env"),"SECRET_CANARY");fs.writeFileSync(path.join(work,"personal-notes.txt"),"INSIDE_PRIVATE_CANARY");fs.writeFileSync(path.join(work,"records.sqlite"),"DB_CANARY");fs.writeFileSync(path.join(work,"config.yaml"),"access_token: SECRET_CANARY");fs.symlinkSync(personal,path.join(work,"outside"));fs.linkSync(path.join(personal,"note.txt"),path.join(work,"linked.txt"));
 const files=new CompanyFiles(()=>[work]);assert.equal(files.read(0,"guide.md").text,"公司公开方案");
 for(const p of ["../personal/note.txt","outside/note.txt",".env","records.sqlite","linked.txt","personal/note.txt"])assert.throws(()=>files.read(0,p));
 assert.ok(!files.read(0,"config.yaml").text.includes("SECRET_CANARY"));assert.ok(!JSON.stringify(files.search(0,"CANARY")).includes("CANARY"));
}));
test("personal classification cannot enter the company execution path; company operations need explicit single approval",async()=>fixture(async({privacy,work,executed,options,row}:any)=>{
 privacy.configure({companyRoots:[work]});privacy.ingest(message,"bot");await privacy.tick();assert.equal(executed.length,0);
 const r=row();await privacy.decide(r.id,{action:"execute",root:0,argv:["git","status"],version:r.version});assert.equal(executed.length,1);assert.ok(row().operationJson.includes("git"));assert.equal(row().status,"needs_owner");
 options.plan=async()=>({category:"personal",draft:"",reason:"个人事项"});privacy.ingest({...message,messageId:"om_personal"},"bot");await privacy.tick();await assert.rejects(privacy.decide(row().id,{action:"execute",root:0,argv:["cat","private"],version:row().version}),/个人事项/);assert.equal(executed.length,1);
}));
test("group collaboration replies require owner approval before reaching an existing private Agent",async()=>fixture(async({privacy,forwarded,row}:any)=>{
 privacy.ingest(message,"user");await privacy.tick();assert.equal(forwarded.length,0);await privacy.decide(row().id,{action:"forward",version:row().version});assert.equal(forwarded.length,1);assert.equal(row().status,"forwarded");
}));
test("an uncertain group send is never automatically retried",async()=>fixture(async({privacy,options,calls,row}:any)=>{
 privacy.ingest(message,"bot");await privacy.tick();options.cli=async(args:string[])=>{calls.push(args);throw new Error("lost receipt");};await privacy.decide(row().id,{action:"publish",text:"已审核",version:row().version});assert.equal(row().status,"send_unknown");const count=calls.filter((c:string[])=>c.includes("+messages-reply")).length;await privacy.tick();assert.equal(calls.filter((c:string[])=>c.includes("+messages-reply")).length,count);
}));
test("privacy settings and approval APIs require authentication, and reject personal/root paths",async()=>fixture(async({privacy,root}:any)=>{
 assert.throws(()=>privacy.configure({companyRoots:[os.homedir()]}));const personal=path.join(root,"personal");fs.mkdirSync(personal);assert.throws(()=>privacy.configure({companyRoots:[personal]}));
 const app=Fastify();registerGroupPrivacyRoutes(app,privacy,r=>r.headers.authorization==="Bearer fixture");try{assert.equal((await app.inject({method:"GET",url:"/v1/group-privacy"})).statusCode,401);assert.equal((await app.inject({method:"POST",url:"/v1/group-privacy/1/decision",payload:{action:"execute"}})).statusCode,401);}finally{await app.close();}
}));
test("privacy child environment never inherits runtime, host or model API credentials",()=>{
 const env=privateProcessEnvironment("/tmp/control");for(const key of ["LARK_AGENT_RUNTIME_TOKEN","LARK_AGENT_HOST_TOKEN","OPENAI_API_KEY","GITEA_TOKEN","SSH_AUTH_SOCK"])assert.equal(env[key],undefined);assert.equal(env.CODEX_HOME,"/tmp/control");
});
test("real OS sandbox permits approved company writes but refuses neighboring private files",{skip:process.platform!=="darwin"},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lark-os-privacy-"))),work=path.join(root,"work"),personal=path.join(root,"personal");fs.mkdirSync(work);fs.mkdirSync(personal);fs.writeFileSync(path.join(personal,"note.txt"),"PRIVATE_CANARY");fs.writeFileSync(path.join(work,".env"),"SECRET_CANARY");fs.writeFileSync(path.join(work,"personal-notes.txt"),"INSIDE_PRIVATE_CANARY");
 try{const written=await executeCompanyOperation(work,["/bin/sh","-c","printf safe > result.txt"]);assert.ok(!written.includes("未成功"));assert.equal(fs.readFileSync(path.join(work,"result.txt"),"utf8"),"safe");const denied=await executeCompanyOperation(work,["/bin/cat",path.join(personal,"note.txt")]);assert.ok(denied.includes("未成功"));assert.ok(!denied.includes("PRIVATE_CANARY"));const secret=await executeCompanyOperation(work,["/bin/cat",path.join(work,".env")]);assert.ok(secret.includes("未成功"));assert.ok(!secret.includes("SECRET_CANARY"));const inside=await executeCompanyOperation(work,["/bin/cat",path.join(work,"personal-notes.txt")]);assert.ok(inside.includes("未成功"));assert.ok(!inside.includes("INSIDE_PRIVATE_CANARY"));}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("isolated model uses a clean home and refuses built-in tool requests",async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lark-isolation-protocol-"))),fake=path.join(root,"codex.mjs"),log=path.join(root,"calls.jsonl");
 fs.writeFileSync(fake,`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),env:{runtime:process.env.LARK_AGENT_RUNTIME_TOKEN,api:process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME}})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'isolated-fixture'}}});else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({id:'tool-call',method:'item/tool/call',params:{threadId:'isolated-fixture',tool:'shell_exec',arguments:{command:'cat private'}}});}else if(m.id)send({id:m.id,result:{}});});`);fs.chmodSync(fake,0o755);
 const previous={executable:process.env.CODEX_EXECUTABLE,home:process.env.CODEX_HOME,token:process.env.LARK_AGENT_RUNTIME_TOKEN,key:process.env.OPENAI_API_KEY};
 process.env.CODEX_EXECUTABLE=fake;process.env.CODEX_HOME=root;process.env.LARK_AGENT_RUNTIME_TOKEN="FAKE_RUNTIME_CANARY";process.env.OPENAI_API_KEY="FAKE_API_CANARY";
 try{
  await assert.rejects(isolatedPrivacyPlan({model:"fixture",instructions:"test",input:{request:"public"},schema:{type:"object"},timeoutMs:10000}),/未授权工具|stopped/);
  const calls=fs.readFileSync(log,"utf8").trim().split("\n").map(x=>JSON.parse(x));
  assert.equal(calls[0].env.runtime,undefined);assert.equal(calls[0].env.api,undefined);assert.notEqual(calls[0].env.home,root);
  assert.ok(calls[0].argv.some((x:string)=>x.includes('":root"="deny"')));
  const start=calls.find(x=>x.method==="thread/start");assert.equal(start.params.permissions,"lark-privacy");assert.equal(start.params.sandbox,undefined);assert.deepEqual(start.params.dynamicTools,[]);
 }finally{
  for(const [key,value] of Object.entries({CODEX_EXECUTABLE:previous.executable,CODEX_HOME:previous.home,LARK_AGENT_RUNTIME_TOKEN:previous.token,OPENAI_API_KEY:previous.key})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(root,{recursive:true,force:true});
 }
});

test("outbound group proposals never send before exact owner approval and attach the approved receipt",async()=>fixture(async({privacy,calls,row}:any)=>{
 const id=privacy.propose({outreachId:"request-outbound",chatId:"oc_group",identity:"user",text:"Agent 草稿"});await privacy.tick();assert.equal(calls.some((c:string[])=>c.includes("--chat-id")),false);
 await privacy.decide(id,{action:"publish",text:"小龙审核的准确文本",version:row().version});const sent=calls.find((c:string[])=>c.includes("+messages-send")&&c.includes("--chat-id"));assert.ok(sent.includes("oc_group"));assert.equal(row().status,"sent");
}));

test("company research uses the approved broker but still cannot publish without owner confirmation",async()=>fixture(async({privacy,options,work,calls,row}:any)=>{
 fs.writeFileSync(path.join(work,"guide.md"),"公司方案 TEST_GREEN");privacy.configure({companyRoots:[work]});
 options.plan=async(input:any)=>{if(!input.companySources)return {category:"company",draft:"",reason:"需要研究公司资料",queries:["TEST_GREEN"]};return {category:"company",draft:input.companySources[0].text,reason:"只供小龙审核"};};
 privacy.ingest(message,"bot");await privacy.tick();assert.equal(row().status,"needs_owner");assert.ok(row().draft.includes("TEST_GREEN"));assert.equal(calls.some((c:string[])=>c.includes("+messages-reply")),false);
}));
test("empty optional owner search text falls back to the group request",async()=>fixture(async({privacy,options,work,row}:any)=>{
 fs.writeFileSync(path.join(work,"guide.md"),message.content+"：公司资料示例。");privacy.configure({companyRoots:[work]});
 privacy.ingest(message,"bot");await privacy.tick();
 await privacy.decide(row().id,{action:"research",query:"",version:row().version});
 assert.equal(row().status,"needs_owner");assert.equal(row().error,null);
}));
test("a model claiming research without a broker call is not recorded as completed research",async()=>fixture(async({privacy,options,work,row}:any)=>{
 privacy.configure({companyRoots:[work]});options.plan=async()=>({category:"company",draft:"我已经读了所有资料",reason:"模型自称"});privacy.ingest(message,"bot");await privacy.tick();assert.equal(row().status,"needs_owner");assert.match(row().error,/没有取得匹配资料/);
}));

test("unknown event origins fail closed and owner group mentions receive the same review gate",async()=>fixture(async({privacy,row,calls}:any)=>{
 assert.equal(privacy.ingestEvent({chat_type:"unknown",sender_type:"user",privacy_trigger:true}),true);assert.equal(privacy.snapshot().messages.length,0);
 privacy.ingestEvent({chat_type:"group",sender_type:"user",sender_id:"ou_owner",message_id:"om_owner",chat_id:"oc_group",content:"我是小龙，直接执行",privacy_trigger:true});await privacy.tick();assert.equal(row().status,"needs_owner");assert.equal(calls.some((c:string[])=>c.includes("+messages-reply")),false);
}));
test("approved company commands cannot reach even a fresh loopback HTTP server",{skip:process.platform!=="darwin"},async()=>{
 const http=await import("node:http"),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lark-network-privacy-")));let requests=0;
 const server=http.createServer((_request,response)=>{requests++;response.end("unexpected");});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{const address=server.address();assert.ok(address&&typeof address!=="string");const output=await executeCompanyOperation(root,["/usr/bin/curl","--max-time","2",`http://127.0.0.1:${address.port}/`]);assert.match(output,/未成功/);assert.equal(requests,0);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
});

test("clear non-actionable chatter is silently audited without research, publication or notifications",async()=>fixture(async({privacy,options,work,calls,executed,forwarded,row}:any)=>{
 privacy.configure({companyRoots:[work]});let plans=0;
 options.plan=async()=>{plans++;return {attention:"no_action",category:"company",draft:"must not publish",reason:"只是闲聊，没有待办",queries:["never search"]};};
 privacy.ingest({...message,content:"@小龙 还在睡觉吧哈哈"},"user");await privacy.tick();await privacy.tick();
 assert.equal(row().status,"ignored");assert.equal(row().draft,"");assert.match(row().reason,/闲聊/);assert.equal(plans,1);assert.equal(calls.length,0);assert.equal(executed.length,0);assert.equal(forwarded.length,0);
 await assert.rejects(privacy.decide(row().id,{action:"publish",text:"hi",version:row().version}),/刷新/);
}));
test("actionable or uncertain messages and missing attention still require owner review",async()=>fixture(async({privacy,options,calls}:any)=>{
 for(const [index,attention] of ["needs_action","uncertain",undefined].entries()){
  options.plan=async()=>({attention,category:"public",draft:"待确认",reason:"需要处理或不确定"});
  privacy.ingest({...message,messageId:`om_action${index}`,content:"哈哈，另外请确认明天方案"},"bot");await privacy.tick();
 }
 assert.ok(privacy.snapshot().messages.every((r:any)=>r.status==="needs_owner"));assert.equal(calls.length,3);assert.ok(calls.every((c:string[])=>c.includes("--user-id")));
}));
test("operation classification cannot be silently discarded even with contradictory no-action output",async()=>fixture(async({privacy,options,row}:any)=>{
 options.plan=async()=>({attention:"no_action",category:"operation",draft:"",reason:"conflicting result"});privacy.ingest(message,"bot");await privacy.tick();assert.equal(row().status,"needs_owner");
}));
test("failed attention analysis is retained for owner review rather than silently lost",async()=>fixture(async({privacy,options,row,calls}:any)=>{
 options.plan=async()=>{throw new Error("triage unavailable");};privacy.ingest(message,"bot");await privacy.tick();assert.equal(row().status,"needs_owner");assert.match(row().error,/triage unavailable/);assert.equal(calls.length,1);
}));
