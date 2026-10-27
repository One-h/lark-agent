import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCodexExecutable } from "@lark-agent/adapter-codex-app-server";
import { filesystemProfile, privateProcessEnvironment } from "./privacyIsolation.js";
function sandboxCommand(file:string,args:string[],root:string,control:string):Promise<{output:string;code:number|null;reason:string}>{
  return new Promise(resolve=>{
    const child=spawn(file,args,{cwd:root,env:privateProcessEnvironment(control),detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
    let output="",reason="",settled=false;
    const kill=()=>{try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{/* Already exited. */}};
    const timer=setTimeout(()=>{reason="执行超时";kill();},60000);
    const append=(chunk:Buffer)=>{output+=chunk.toString();if(Buffer.byteLength(output)>65536){reason="输出超过限制";output=output.slice(0,8000);kill();}};
    child.stdout.on("data",append);child.stderr.on("data",append);
    const finish=(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);kill();resolve({output:output.slice(0,8000),code,reason});};
    child.once("error",()=>{reason="无法启动沙箱";finish(null);});child.once("close",code=>finish(code));
  });
}
export async function executeCompanyOperation(root:string,argv:string[]):Promise<string>{
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory()
    ||!Array.isArray(argv)||!argv.length||argv.length>40||argv.some(x=>typeof x!=="string"||x.length>2000||x.includes("\0")))throw new Error("无效的公司操作。");
  const control=fs.mkdtempSync(path.join(os.tmpdir(),"lark-company-operation-"));
  const deny=["**/*personal*","**/*private*","**/*个人*","**/*私密*","**/*薪资*","**/*工资*","**/*人事*","**/*backup*","**/.env*","**/*secret*","**/*credential*","**/*password*","**/*token*","**/*.pem","**/*.key","**/*.p12","**/*.sqlite*","**/*session*","**/*history*","**/.ssh/**","**/.aws/**","**/.kube/**","**/.codex/**","**/.git/config"];
  const entries=['":root"="deny"','":minimal"="read"',`${JSON.stringify(root)}="write"`,...deny.map(pattern=>`${JSON.stringify(path.join(root,pattern))}="deny"`)];
  const profile=filesystemProfile(root,true).filter(x=>!x.startsWith('permissions.lark-privacy.filesystem='));
  profile.push(`permissions.lark-privacy.filesystem={${entries.join(",")},glob_scan_max_depth=12}`);
  try{
    const result=await sandboxCommand(resolveCodexExecutable(),["sandbox","--permission-profile","lark-privacy","--cd",root,...profile.flatMap(x=>["-c",x]),"--",...argv],root,control);
    if(result.code!==0||result.reason)return `操作未成功（${result.reason||String(result.code)}）；没有绕过沙箱。\n${result.output.slice(0,4000)}`;
    return result.output||"命令执行完成，无输出。";
  }finally{fs.rmSync(control,{recursive:true,force:true});}
}
