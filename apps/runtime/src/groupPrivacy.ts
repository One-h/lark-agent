import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance,FastifyRequest } from "fastify";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { inboxCli,type PersonalMessage } from "./personalInboxTransport.js";
import { CompanyFiles } from "./companyFiles.js";
import { executeCompanyOperation } from "./companyOperation.js";
import { planGroupReply,type GroupPlan } from "./groupPrivacyPlan.js";
type GroupRow={id:number;messageId:string;chatId:string;senderId:string;content:string;identity:"bot"|"user";
  category:string;status:string;draft:string;reason:string;error:string|null;version:number;notified:number;
  receivedAt:string;outreachId:string|null;operationJson:string|null;operationOutput:string|null;sentMessageId:string|null;approvedHash:string|null};
type ContextRow={message_id:string;sender_id:string;content:string};
const errorText=(error:unknown)=>error instanceof Error?error.message:"处理失败。";
export class GroupPrivacy {
  private timer?:ReturnType<typeof setInterval>;private busy=false;private closing=false;private locks=new Set<number>();
  constructor(readonly store:SqliteAgentStore,private options:{ownerId:()=>string;model:()=>string;cli?:typeof inboxCli;
    plan?:(input:unknown,model:string)=>Promise<GroupPlan>;execute?:(root:string,argv:string[])=>Promise<string>;
    approvedReceipt?:(outreachId:string,messageId:string,chatId:string)=>void;
    forward?:(message:PersonalMessage,identity:"bot"|"user")=>boolean}){
    store.db.exec(`CREATE TABLE IF NOT EXISTS group_privacy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,messageId TEXT NOT NULL UNIQUE,chatId TEXT NOT NULL,senderId TEXT NOT NULL,
      content TEXT NOT NULL,identity TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'pending',status TEXT NOT NULL DEFAULT 'pending',
      draft TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',error TEXT,version INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0,receivedAt TEXT NOT NULL,outreachId TEXT,operationJson TEXT,operationOutput TEXT,sentMessageId TEXT,approvedHash TEXT
    );CREATE INDEX IF NOT EXISTS group_privacy_status ON group_privacy(status,id);`);
    store.db.prepare("UPDATE group_privacy SET status='needs_owner',error='分析被重启中断，请人工确认。',version=version+1 WHERE status IN ('reviewing','researching')").run();
    store.db.prepare("UPDATE group_privacy SET status='operation_unknown',error='操作时服务重启，请先核对结果，禁止自动重试。',version=version+1 WHERE status='executing'").run();
    store.db.prepare("UPDATE group_privacy SET status='send_unknown',error='发送时服务重启，请先核对群消息。',version=version+1 WHERE status='sending'").run();
  }
  private get cli(){return this.options.cli??inboxCli;}
  roots():string[]{try{return JSON.parse(this.store.setting("groupPrivacy.companyRoots","[]"));}catch{return [];}}
  snapshot(){return {policy:{enabled:true,companyRoots:this.roots(),autoPublishGenerated:false,autoExecute:false,personalAccess:false},messages:this.store.db.prepare("SELECT * FROM group_privacy ORDER BY id DESC LIMIT 200").all()};}
  configure(body:Record<string,unknown>){
    if(Object.keys(body).some(key=>key!=="companyRoots")||!Array.isArray(body.companyRoots)||body.companyRoots.length>8)throw new Error("仅允许配置公司资料目录。");
    const roots=body.companyRoots.map(value=>{
      if(typeof value!=="string"||!path.isAbsolute(value)||value.length>1000)throw new Error("公司目录必须是绝对路径。");
      const root=path.resolve(value);
      if(root===path.parse(root).root||root===os.homedir()||root.split(path.sep).filter((part,index)=>!(process.platform==="darwin"&&index===1&&part==="private")).some(part=>/^(personal|private|\.codex|\.ssh|\.aws|\.kube|\.config)$/i.test(part))
        ||fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw new Error("目录过宽、属于个人范围或包含符号链接。");
      return root;
    });
    this.store.setSetting("groupPrivacy.companyRoots",JSON.stringify([...new Set(roots)]));return this.snapshot();
  }
  private row(id:number){return this.store.db.prepare("SELECT * FROM group_privacy WHERE id=?").get(id) as GroupRow|undefined;}
  private update(id:number,patch:Partial<GroupRow>){const entries=Object.entries(patch);this.store.db.prepare(`UPDATE group_privacy SET ${entries.map(([key])=>key+"=?").join(",")},version=version+1 WHERE id=?`).run(...entries.map(([,value])=>value),id);}
  propose(input:{outreachId:string;chatId:string;identity:"bot"|"user";text:string}){
    const result=this.store.db.prepare("INSERT INTO group_privacy(messageId,chatId,senderId,content,identity,receivedAt,outreachId,status,category,draft,reason) VALUES(?,?,?,?,?,?,?,'needs_owner','company',?,?)")
      .run(`proposal:${input.outreachId}`,input.chatId,this.options.ownerId(),input.text,input.identity,new Date().toISOString(),input.outreachId,input.text,"Agent 提议发送到群聊，请审核准确文本后单次批准。");
    return Number(result.lastInsertRowid);
  }
  ingest(message:PersonalMessage,identity:"bot"|"user"){
    if(message.chatType!=="group")return false;
    if(!/^om_[A-Za-z0-9]+$/.test(message.messageId)||!/^oc_[A-Za-z0-9]+$/.test(message.chatId))return true;
    this.store.db.prepare("INSERT OR IGNORE INTO group_privacy(messageId,chatId,senderId,content,identity,receivedAt) VALUES(?,?,?,?,?,?)")
      .run(message.messageId,message.chatId,message.senderId,message.content.slice(0,12000),identity,new Date().toISOString());return true;
  }
  ingestEvent(event:Record<string,unknown>){
    if(event.chat_type==="p2p")return false;
    if(event.chat_type!=="group")return true;
    // All group events are claimed, including the owner's. No legacy tools or
    // direct reply-to-Agent injection may bypass this boundary.
    if(!event.privacy_trigger||event.sender_type!=="user")return true;
    this.ingest({messageId:String(event.message_id??event.id??""),chatId:String(event.chat_id??""),chatType:"group",chatName:"",
      senderId:String(event.sender_id??""),senderName:String(event.sender_id??""),content:String(event.content??""),sourceTime:String(event.create_time??""),messageType:String(event.message_type??"")},"bot");return true;
  }
  private input(row:GroupRow){
    const source=this.store.db.prepare("SELECT id FROM lark_messages WHERE message_id=? AND chat_id=?").get(row.messageId,row.chatId) as {id:number}|undefined;
    const context=source?this.store.db.prepare("SELECT message_id,sender_id,substr(content,1,1200) AS content FROM lark_messages WHERE chat_id=? AND id<=? AND message_type IN ('text','post') ORDER BY id DESC LIMIT 20").all(row.chatId,source.id) as ContextRow[]:[];
    return {request:row.content,groupContext:context.reverse(),companyRoots:new CompanyFiles(()=>this.roots()).listRoots()};
  }
  async tick(){
    if(this.busy||this.closing)return;this.busy=true;
    try{
      const pending=this.store.db.prepare("SELECT * FROM group_privacy WHERE status='pending' ORDER BY id LIMIT 5").all() as GroupRow[];
      for(const row of pending){
        if(this.closing)break;
        try{
          this.update(row.id,{status:"reviewing"});
          const plan=await (this.options.plan??planGroupReply)(this.input(row),this.options.model());
          // Ignoring can only remove work; it never grants access, sends, or executes.
          if(plan.attention==="no_action"&&plan.category!=="operation"){
            this.update(row.id,{status:"ignored",category:plan.category,draft:"",reason:plan.reason,error:null});
            continue;
          }
          this.update(row.id,{status:"needs_owner",category:plan.category,draft:plan.draft,reason:plan.reason});
          if(plan.category==="company"&&this.roots().length)await this.research(row.id,plan.queries);
        }catch(error){this.update(row.id,{status:"needs_owner",draft:"",error:errorText(error),reason:"隔离分析失败，群中未自动发送。"});}
      }
      const notices=this.store.db.prepare("SELECT * FROM group_privacy WHERE status IN ('needs_owner','operation_unknown','send_unknown') AND notified=0 LIMIT 5").all() as GroupRow[];
      for(const row of notices){
        if(!this.options.ownerId())break;
        try{await this.cli(["im","+messages-send","--as","bot","--user-id",this.options.ownerId(),"--text",
          `群聊隐私确认 #${row.id}\n请求：${row.content.slice(0,400)}\n${row.reason||row.error||"请确认如何处理。"}\n${row.draft?`草稿：${row.draft.slice(0,700)}\n`:""}所有模型回复、承诺和操作均未自动发群或执行。请私下审核：http://127.0.0.1:4732/group-privacy`,"--idempotency-key",`group-privacy-${row.id}-${row.version}`]);
          this.store.db.prepare("UPDATE group_privacy SET notified=1 WHERE id=?").run(row.id);
        }catch{/* Retain the row for owner review; never fall back to a group notice. */}
      }
    }finally{this.busy=false;}
  }
  private async research(id:number,queries?:string[]){
    const row=this.row(id)!;if(row.category==="personal")throw new Error("个人资料不会通过公司研究入口读取。");
    const roots=this.roots();if(!roots.length)throw new Error("尚未指定公司资料目录。");
    this.update(id,{status:"researching"});
    const files=new CompanyFiles(()=>{if(JSON.stringify(this.roots())!==JSON.stringify(roots))throw new Error("公司资料范围已变更。");return roots;});
    const fallback=row.content.match(/[A-Za-z][A-Za-z0-9_-]{1,40}|[\u4e00-\u9fff]{2,10}/g)??[];
    const terms=(queries?.length?queries:fallback).filter(x=>x.trim().length>=2&&x.length<=120).slice(0,3);
    const sources=files.retrieve(terms);
    if(!sources.length)throw new Error("公司范围内没有取得匹配资料，请提供更具体的检索词；不能标为已研究。");
    const plan=await (this.options.plan??planGroupReply)({...this.input(row),companySources:sources},this.options.model());
    this.update(id,{status:"needs_owner",category:plan.category,draft:plan.draft,reason:plan.reason,notified:0,error:null});
  }
  async decide(id:number,body:Record<string,unknown>){
    const row=this.row(id);if(!row||row.version!==body.version||!['needs_owner','operation_unknown'].includes(row.status)||this.locks.has(id))throw new Error("状态已变化或正在处理，请刷新。");
    this.locks.add(id);
    try{
      if(row.status==="operation_unknown"&&body.action!=="dismiss")throw new Error("请先人工核对不确定的操作结果，不能重试。");
      if(body.action==="dismiss"){this.update(id,{status:"dismissed"});return this.row(id);}
      if(body.action==="research"){await this.research(id,typeof body.query==="string"&&body.query.trim()?[body.query.trim()]:undefined);return this.row(id);}
      if(body.action==="forward"){
        if(row.category==="personal")throw new Error("个人事项不能转交原 Agent 自动处理，请你私下决定。");
        const source=this.store.db.prepare("SELECT reply_to_message_id,root_message_id FROM lark_messages WHERE message_id=? AND chat_id=?").get(row.messageId,row.chatId) as {reply_to_message_id?:string;root_message_id?:string}|undefined;
        const accepted=this.options.forward?.({replyTo:source?.reply_to_message_id,rootId:source?.root_message_id,messageId:row.messageId,chatId:row.chatId,chatType:"group",chatName:"",senderId:row.senderId,senderName:row.senderId,content:row.content,sourceTime:row.receivedAt,messageType:"text"},row.identity);
        if(!accepted)throw new Error("没有匹配的协作请求。可改用审核后的群回复。");
        this.update(id,{status:"forwarded"});return this.row(id);
      }
      if(body.action==="execute"){
        if(row.category==="personal")throw new Error("个人事项不在公司操作通道执行。");
        const roots=this.roots(),root=Number.isInteger(body.root)?roots[Number(body.root)]:undefined,argv=body.argv;
        if(!root||!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=="string"||!x||x.length>2000)||argv.length>40)throw new Error("请选择公司目录并提供明确的命令参数列表。");
        const operationJson=JSON.stringify({root,argv});
        this.update(id,{status:"executing",operationJson,approvedHash:createHash("sha256").update(operationJson).digest("hex")});
        const output=await (this.options.execute??executeCompanyOperation)(root,argv);
        this.update(id,{status:"needs_owner",operationOutput:output,draft:"",reason:"批准的单次操作已结束。结果仅供你私下查看；如需发群，请另行填写并确认答复。",notified:0});return this.row(id);
      }
      if(body.action!=="publish"||typeof body.text!=="string"||!body.text.trim()||body.text.length>4000||row.status==='operation_unknown')throw new Error("请审核并填写要发回此群的准确文本。");
      const text=body.text.trim(),hash=createHash("sha256").update(text).digest("hex");
      this.update(id,{status:"sending",draft:text,approvedHash:hash,error:null});
      try{
        const {data}=await this.cli(["im",row.outreachId?"+messages-send":"+messages-reply","--as",row.identity,row.outreachId?"--chat-id":"--message-id",row.outreachId?row.chatId:row.messageId,"--text",`${text}\n（小龙的助手龙小祝，经小龙确认）`,"--idempotency-key",`gp-${id}-${hash.slice(0,28)}`]);
        if(!data?.message_id)throw new Error("没有完整回执，请核对群消息。");
        this.update(id,{status:"sent",sentMessageId:data.message_id});
        if(row.outreachId)this.options.approvedReceipt?.(row.outreachId,data.message_id,row.chatId);
      }catch(error){this.update(id,{status:"send_unknown",error:errorText(error)});}
      return this.row(id);
    }catch(error){if(['researching','executing'].includes(this.row(id)?.status??''))this.update(id,{status:this.row(id)?.status==='executing'?'operation_unknown':'needs_owner',draft:"",error:errorText(error)});throw error;}
    finally{this.locks.delete(id);}
  }
  start(){this.timer??=setInterval(()=>void this.tick(),5000);this.timer.unref();}
  async stop(){this.closing=true;if(this.timer)clearInterval(this.timer);while(this.busy||this.locks.size)await new Promise(resolve=>setTimeout(resolve,100));}
}
export function registerGroupPrivacyRoutes(app:FastifyInstance,privacy:GroupPrivacy,authenticated:(request:FastifyRequest)=>boolean){
  app.addHook("onClose",()=>privacy.stop());
  app.route({method:["GET","PATCH"],url:"/v1/group-privacy",handler:async(request,reply)=>{
    if(!authenticated(request))return reply.code(401).send({error:"unauthorized"});
    try{return request.method==='PATCH'?privacy.configure((request.body??{}) as Record<string,unknown>):privacy.snapshot();}
    catch(error){return reply.code(400).send({error:errorText(error)});}
  }});
  app.post("/v1/group-privacy/:id/decision",async(request,reply)=>{
    if(!authenticated(request))return reply.code(401).send({error:"unauthorized"});
    const id=Number((request.params as {id:string}).id);if(!Number.isSafeInteger(id)||id<1)return reply.code(400).send({error:"invalid id"});
    try{return await privacy.decide(id,(request.body??{}) as Record<string,unknown>);}catch(error){return reply.code(409).send({error:errorText(error)});}
  });
}
