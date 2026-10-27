#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
if (!['send','receive','wait','ack'].includes(command)) {
  console.log('Usage: agent-messaging.mjs send < request.json | receive | wait [seconds] | ack <ids...>\nSource is CODEX_THREAD_ID and current working directory. send JSON: {recipientId,sourceLabel,text,requestKey,identity?:"bot"|"user",chatId?:string}.'); process.exit(command ? 1 : 0);
}
const threadId = process.env.CODEX_THREAD_ID;
if (!/^[0-9a-f-]{36}$/i.test(threadId ?? '')) throw new Error('CODEX_THREAD_ID missing: run inside the originating Codex conversation.');
let token = process.env.LARK_AGENT_RUNTIME_TOKEN;
if (!token) {
  const env = fs.readFileSync(process.env.LARK_AGENT_ENV_FILE ?? path.join(root,'data/runtime.env'),'utf8');
  const match = env.match(/^(?:export\s+)?LARK_AGENT_RUNTIME_TOKEN=['"]?([^\s'"\n]+)['"]?\s*$/m); token = match?.[1];
}
if (!token) throw new Error('Runtime authentication is not configured.');
const url = new URL(process.env.LARK_AGENT_RUNTIME_URL ?? 'http://127.0.0.1:4780');
if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Only loopback runtime URLs are supported.');
async function request(route,body) {
  const response=await fetch(new URL(`/v1/agent-messaging${route}`,url),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);return result;
}
const input = async () => { let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>20000)throw new Error('Input too large.');}return JSON.parse(text); };
try {
  if(command==='send') {
    const body=await input(); const result=await request('/send',{...body,sourceThreadId:threadId,sourceCwd:process.cwd()});
    console.log(JSON.stringify(result)); if(result.status!=='open')process.exitCode=2;
  } else if(command==='ack') console.log(JSON.stringify(await request(`/receive/${threadId}/ack`,{ids:process.argv.slice(3).map(Number)})));
  else {
    const seconds=command==='wait'?Number(process.argv[3]??300):0;
    if(!Number.isFinite(seconds)||seconds<0||seconds>86400)throw new Error('Wait must be 0–86400 seconds.');
    const until=Date.now()+seconds*1000;
    do {
      const result=await request(`/receive/${threadId}/claim`,{});
      if(result.replies.length){console.log(JSON.stringify({trust:'third-party-message-data',...result}));break;}
      if(Date.now()>=until){console.log(JSON.stringify({replies:[],waiting:true}));break;}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }while(true);
  }
} catch(error){console.error(error instanceof Error?error.message:'Request failed.');process.exitCode=1;}
