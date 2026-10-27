import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { DesktopReplyBridge, SourceNotLoadedError } from "./agentReplyBridge.js";
test("desktop bridge sends standalone tool output to the loaded source and never resumes a notLoaded source",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-bridge-")),socket=path.join(root,"bridge.sock"),server=http.createServer(),ws=new WebSocketServer({server});
 let status="active";const calls:any[]=[];
 ws.on("connection",peer=>peer.on("message",raw=>{const message=JSON.parse(raw.toString());if(!message.id)return;calls.push(message);const result=message.method==="thread/read"?{thread:{id:"source",cwd:root,status:{type:status}}}:message.method==="turn/start"?{turn:{id:"routed-turn"}}:{};peer.send(JSON.stringify({id:message.id,result}));}));
 await new Promise<void>(resolve=>server.listen(socket,resolve));
 try{
  const bridge=new DesktopReplyBridge(socket);
  assert.equal((await bridge.inspect("source")).status.type,"active");
  assert.equal(await bridge.deliver("source",{message:{content:"third-party text"}}),"routed-turn");
  const turn=calls.find(row=>row.method==="turn/start");assert.deepEqual(turn.params.input,[]);assert.equal(turn.params.threadId,"source");
  assert.equal(turn.params.toolOutput.name,"lark_colleague_reply");assert.equal(JSON.parse(turn.params.toolOutput.output).trust,"third-party-message-data");
  status="notLoaded";await assert.rejects(bridge.deliver("source",{}),SourceNotLoadedError);
  assert.equal(calls.filter(row=>row.method==="turn/start").length,1);assert.equal(calls.some(row=>["thread/start","thread/resume"].includes(row.method)),false);
 }finally{for(const peer of ws.clients)peer.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
});
