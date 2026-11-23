import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeAcpEngineId } from "./nativeAcpExecutionEngine.js";
import type { RetainedExecutionTurns } from "./retainedExecutionTurns.js";

function launcher(dir: string, engine: NativeAcpEngineId, restricted: boolean): string {
  const file = path.join(dir, restricted ? "restricted.mjs" : "trusted.mjs");
  writeFileSync(file, `#!${process.execPath}
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const profile = ${JSON.stringify(engine)};
const flags = process.argv.slice(2);
const requiredFlags = { claude: [], dsh: ["--profile","acp"], opencode: ["acp"], agy: ["acp","--disable-telemetry","--sandbox"] };
assert.deepEqual(flags, requiredFlags[profile]);
if (profile === "dsh") assert.equal(process.env.DSH_PERMISSION_MODE, "read-only");
const sessionId = "fixture-" + profile;
const write = message => console.log(JSON.stringify({jsonrpc:"2.0",...message}));
const result = (id, value) => write({id,result:value});
const update = value => write({method:"session/update",params:{sessionId,update:value}});
let promptId;
const tool = {toolCallId:"one", title:"Read", kind:"read", status:"pending", rawInput:{fixture:true}};
createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  const {id,method,params} = message;
  if (method === "initialize") result(id,{protocolVersion:1});
  if (method === "session/new") result(id,{sessionId,modes:{currentModeId:"default",availableModes:[{id:"default",name:"Default"}]}});
  if (method === "session/prompt") {
    assert.equal(promptId, undefined);
    assert.equal(params.prompt[0].text, "fixture");
    promptId = id;
    update({sessionUpdate:"tool_call",...tool});
    write({id:999,method:"session/request_permission",params:{sessionId,toolCall:tool,
      options:[{optionId:"allow",name:"Allow",kind:"allow_once"}]}});
  }
  if (!method && id === 999) {
    const selected = message.result?.outcome?.optionId === "allow";
    update({sessionUpdate:"tool_call_update",toolCallId:"one",status:selected?"completed":"failed"});
    update({sessionUpdate:"agent_message_chunk",messageId:"final",content:{type:"text",text:selected?"approved":"not executed"}});
    result(promptId,{stopReason:"end_turn"});
  }
  if (method === "session/cancel" && promptId !== undefined) result(promptId,{stopReason:"cancelled"});
});
`, { mode: 0o700 });
  return file;
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for fixture");
}

type Snapshot = NonNullable<ReturnType<RetainedExecutionTurns["attach"]>>;

for (const id of ["claude", "dsh", "opencode", "agy"] as const) {
  test(`${id}: a new client process attaches to original ACP prompt and answers its original permission once`, { timeout: 35_000 }, async () => {
    const root = mkdtempSync("/tmp/lark-retained-acp-");
    const socketPath = path.join(root, "h.sock");
    const token = randomBytes(32).toString("hex");
    const hosted = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { listenRetainedExecutionHost } from ${JSON.stringify(new URL("./retainedExecutionHost.ts", import.meta.url).href)};
      import { createNativeAcpExecutionEngine } from ${JSON.stringify(new URL("./nativeAcpExecutionEngine.ts", import.meta.url).href)};
      const [socketPath, workspace, engine, launcher, restrictedLauncher] = process.argv.slice(1);
      const server = await listenRetainedExecutionHost({ socketPath, workspace, token: process.env.FIXTURE_TOKEN,
        engines: [createNativeAcpExecutionEngine(engine,{launcher,restrictedLauncher,models:[]})] });
      process.on("SIGTERM", () => { void server.close(); });
      console.log("ready");
    `, socketPath, root, id, launcher(root, id, false), launcher(root, id, true)],
    { env: { ...process.env, FIXTURE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    const stopped = once(hosted, "exit");
    let generation: string;
    function send<T>(method: string, params = {}, auth = token): Promise<{ status: number; body: T }> {
      return new Promise((resolve, reject) => {
        const call = http.request({ socketPath, method: "POST", path: "/turns", headers: { authorization: `Bearer ${auth}` } },
          res => {
            const chunks: Buffer[] = [];
            res.on("data", data => chunks.push(data));
            res.on("error", reject);
            res.on("end", () => {
              try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
              catch (error) { reject(error); }
            });
          });
        call.on("error", reject);
        call.setTimeout(3_000, () => call.destroy(new Error("Test RPC timed out")));
        call.end(JSON.stringify({ method, ...(method === "status" ? {} : { generation }), ...params }));
      });
    }
    async function subscriber(afterSequence: number, approve: boolean): Promise<{ snapshot: Snapshot; answers: boolean[] }> {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import http from "node:http";
        const [socketPath, generation, after, approve] = process.argv.slice(1);
        const call = (method, params) => new Promise((resolve,reject) => {
          const req = http.request({socketPath,method:"POST",path:"/turns",headers:{authorization:"Bearer " + process.env.FIXTURE_TOKEN}},
            res => { let body = ""; res.setEncoding("utf8"); res.on("data", c => body += c);
              res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body))); });
          req.on("error",reject);
          req.setTimeout(3000,()=>req.destroy(new Error("Fixture RPC timed out")));
          req.end(JSON.stringify({method,generation,id:"message-one",...params}));
        });
        const snapshot = await call("attach",{afterSequence:Number(after)});
        const answers = [];
        if (approve === "true") {
          const [request] = snapshot.approvals;
          for (let index=0; index<2; index++) {
            answers.push((await call("answerApproval",{requestId:request.id,allow:true})).accepted);
          }
        }
        console.log(JSON.stringify({snapshot,answers}));
      `, socketPath, generation, String(afterSequence), String(approve)],
      { env: { ...process.env, FIXTURE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
      child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
      const [status] = await once(child, "close");
      assert.equal(status, 0, stderr);
      return JSON.parse(stdout);
    }
    try {
      const [ready] = await Promise.race([once(hosted.stdout, "data"), stopped]);
      assert.match(String(ready), /ready/);
      assert.equal((await send("status", {}, "wrong-token")).status, 401);
      generation = (await send<{ generation: string }>("status")).body.generation;
      const start = { id: "message-one", engineId: id, model: null, sessionId: null, trusted: false, text: "fixture" };
      assert.equal((await send("start", { ...start, generation: randomUUID() })).status, 409);
      assert.equal((await send("start", start)).status, 202);
      await eventually(async () => {
        const { body } = await send<Snapshot | null>("attach", { id: "message-one", afterSequence: 0 });
        return body?.approvals.length ? true : undefined;
      });
      const { snapshot: first } = await subscriber(0, false);
      assert.deepEqual(first.status, { state: "active", sessionId: `fixture-${id}` });
      assert.equal(first.events.length, 1);
      const requestId = first.approvals[0]!.id;
      assert.equal(first.approvals[0]!.operation.engineId, id);
      assert.deepEqual((await send("answerApproval", { id: "different-turn", requestId, allow: true })).body, { accepted: false });
      assert.deepEqual((await send("answerApproval", { id: "message-one", requestId: randomUUID(), allow: true })).body, { accepted: false });
      const resumed = await subscriber(first.sequence, true);
      assert.deepEqual(resumed.snapshot.events, []);
      assert.equal(resumed.snapshot.approvals[0]!.id, requestId);
      assert.deepEqual(resumed.answers, [true, false]);
      const finished = await eventually(async () => {
        const { body } = await send<Snapshot | null>("attach", { id: "message-one", afterSequence: first.sequence });
        return body?.status.state === "finished" ? body : undefined;
      });
      assert.deepEqual(finished.status, { state: "finished", sessionId: `fixture-${id}`, result: { status: "completed", text: "approved" } });
      assert.deepEqual(finished.events.map(({event}) => event), [{ type: "text-delta", text: "approved" }]);
      assert.deepEqual(finished.approvals, []);
      assert.deepEqual((await send("acknowledge", { id: "message-one" })).body, { acknowledged: true });
      assert.deepEqual((await send("acknowledge", { id: "message-one" })).body, { acknowledged: true });
      assert.equal((await send<Snapshot>("attach", { id: "message-one", afterSequence: 0 })).body.status.state, "acknowledged");
      assert.equal((await send("start", start)).status, 409);
      assert.equal((await send("start", { ...start, id: "message-two" })).status, 202);
      const cancelled = { id: "message-two", afterSequence: 0 };
      const pending = await eventually(async () => {
        const { body } = await send<Snapshot>("attach", cancelled);
        return body.approvals[0];
      });
      assert.deepEqual((await send("cancel", { id: cancelled.id })).body, { cancelled: true });
      assert.deepEqual((await send("answerApproval", { id: cancelled.id, requestId: pending.id, allow: true })).body, { accepted: false });
      assert.equal(hosted.exitCode, null);
    } finally {
      hosted.kill("SIGTERM");
      const deadline = AbortSignal.timeout(3_000);
      try { await Promise.race([stopped, once(deadline, "abort", { signal: deadline })]); }
      catch { if (hosted.exitCode === null) hosted.kill("SIGKILL"); }
      await stopped;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
