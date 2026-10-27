import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";

export function privateProcessEnvironment(control: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: control, CODEX_HOME: control,
    TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "en_US.UTF-8", LC_ALL: process.env.LC_ALL,
    SYSTEMROOT: process.env.SYSTEMROOT };
}
export function filesystemProfile(root: string, writable = false): string[] {
  return ['default_permissions="lark-privacy"',
    `permissions.lark-privacy.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(root)}=${JSON.stringify(writable ? "write" : "read")}}`,
    'permissions.lark-privacy.network.enabled=false'];
}
// A separate CODEX_HOME prevents global plugins, MCPs, memories, project rules,
// environment credentials and other conversations from entering the group worker.
export async function isolatedPrivacyPlan<T>(options: { model: string; instructions: string; input: unknown;
  schema: Record<string, unknown>; timeoutMs?: number }): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-privacy-"));
  const control = path.join(root,"control"), work = path.join(root,"work");
  fs.mkdirSync(control,{mode:0o700}); fs.mkdirSync(work,{mode:0o700});
  const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(),".codex"),"auth.json");
  if (fs.existsSync(auth)) { fs.copyFileSync(auth,path.join(control,"auth.json")); fs.chmodSync(path.join(control,"auth.json"),0o600); }
  const client = new CodexAppServerClient(()=>work,{env:()=>privateProcessEnvironment(control),config:()=>[
    ...filesystemProfile(work), 'features.apps=false','features.plugins=false','features.shell_tool=false',
    'features.memories=false','features.skill_search=false','features.code_mode_host=false',
    'project_doc_max_bytes=0','web_search="disabled"'
  ]});
  let threadId="",answer="";
  let finish!:(value:T)=>void,fail!:(error:Error)=>void;
  const completed = new Promise<T>((resolve,reject)=>{finish=resolve;fail=reject;});
  void completed.catch(()=>undefined);
  const timer=setTimeout(()=>{fail(new Error("隔离分析超时，未向群发送。"));client.stop();},options.timeoutMs??90000);
  client.onExit(()=>fail(new Error("隔离分析服务中断，未向群发送。")));
  client.onRequest(request=>{
    client.rejectRequest(request.id,-32601,"No tools in the group privacy worker");
    fail(new Error("隔离分析请求了未授权工具。"));client.stop();return true;
  });
  client.onNotification(notification=>{
    const p=notification.params as any;if(!threadId||p?.threadId!==threadId)return;
    if(notification.method==="item/started" && !["userMessage","agentMessage","reasoning"].includes(p.item?.type)){
      fail(new Error("隔离分析尝试使用未开放的内置工具。"));client.stop();
    }
    if(notification.method==="item/completed" && p.item?.type==="agentMessage")answer=p.item.text??"";
    if(notification.method==="turn/completed"){
      if(p.turn?.status!=="completed")return fail(new Error("隔离分析未完成。"));
      try{finish(JSON.parse(answer));}catch{fail(new Error("隔离分析结果无效。"));}
    }
  });
  try{
    const started=await client.request<{thread:{id:string}}>("thread/start",{model:options.model,cwd:work,ephemeral:true,
      approvalPolicy:"never",permissions:"lark-privacy",baseInstructions:options.instructions,
      dynamicTools:[],config:{model_reasoning_effort:"low"}});
    threadId=started.thread.id;
    await client.request("turn/start",{threadId,input:[{type:"text",text:JSON.stringify(options.input)}],outputSchema:options.schema});
    return await completed;
  }finally{clearTimeout(timer);client.stop();fs.rmSync(root,{recursive:true,force:true});}
}
