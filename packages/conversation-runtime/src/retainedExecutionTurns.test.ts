import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionEngine, ExecutionTurnResult } from "./executionEngines.js";
import type { NativeAcpEngineId } from "./nativeAcpExecutionEngine.js";
import { RetainedExecutionClient } from "./retainedExecutionClient.js";
import { listenRetainedExecutionHost } from "./retainedExecutionHost.js";
import type { RetainedExecutionTurns, RetainedInputStatus } from "./retainedExecutionTurns.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("retained steering survives a new subscriber and settles before the terminal result", { timeout: 10_000 }, async () => {
  const root = mkdtempSync("/tmp/lark-retained-steer-");
  const config = { socketPath: path.join(root, "h.sock"), token: randomBytes(32).toString("hex"), engineIds: ["fixture"] };
  const result = deferred<ExecutionTurnResult>();
  const first = deferred<"injected">();
  const uncertain = deferred<"idle">();
  const submitted: string[] = [];
  let closed = false;
  const engine: ExecutionEngine = {
    descriptor: { id: "fixture", label: "Fixture", models: [] },
    supportsPolicy: () => true,
    async open({ model }) {
      assert.equal(model, "provider/unlisted-model");
      return {
        id: "fixture-session",
        async run(_text, _signal, event) {
          event?.({ type: "text-delta", text: "progress" });
          return result.promise;
        },
        async steer(text) {
          submitted.push(text);
          if (text === "first") return first.promise;
          if (text === "uncertain") return uncertain.promise;
          return "idle";
        },
        close() { closed = true; }
      };
    }
  };
  const host = await listenRetainedExecutionHost({ ...config, workspace: root, engines: [engine] });
  try {
    const client = new RetainedExecutionClient(config);
    const recovered = new RetainedExecutionClient(config);
    const { generation } = await client.call<{ generation: string }>({ method: "status" });
    const identity = { generation, id: "turn-one" };
    const attach = (afterSequence = 0) => recovered.call<Snapshot>({ ...identity, method: "attach", afterSequence });
    const steer = (inputId: string, text: string) => client.call<RetainedInputStatus>({ ...identity, method: "steer", inputId, text });
    await client.call({ ...identity, method: "start", engineId: "fixture", text: "original", sessionId: null, model: "provider/unlisted-model", trusted: true });
    const active = await eventually(async () => {
      const snapshot = await attach();
      return snapshot.status.state === "active" ? snapshot : undefined;
    });
    assert.deepEqual(active.inputs, []);
    await assert.rejects(steer("invalid/id", "first"), { status: 400 });
    await assert.rejects(client.call({ ...identity, generation: randomUUID(), method: "steer", inputId: "first", text: "first" }), { status: 409 });
    assert.deepEqual(await steer("first", "first"), { id: "first", state: "pending" });
    assert.deepEqual(await steer("uncertain", "uncertain"), { id: "uncertain", state: "pending" });
    await steer("idle", "idle");
    assert.deepEqual(await recovered.call({ ...identity, method: "steer", inputId: "first", text: "duplicate" }), { id: "first", state: "pending" });
    assert.deepEqual((await attach(active.sequence)).inputs, [
      { id: "first", state: "pending" }, { id: "uncertain", state: "pending" }, { id: "idle", state: "notAccepted" }
    ]);

    result.resolve({ status: "completed", text: "done" });
    assert.deepEqual(await steer("late", "must not submit"), { id: "late", state: "notAccepted" });
    assert.equal((await attach()).status.state, "active");
    assert.equal(closed, false);
    assert.deepEqual(await recovered.call({ ...identity, method: "acknowledge" }), { acknowledged: false });
    first.resolve("injected");
    assert.deepEqual(await steer("first", "duplicate"), { id: "first", state: "accepted" });
    assert.equal((await attach()).status.state, "active");
    uncertain.reject(new Error("transport closed after submit"));
    const finished = await eventually(async () => {
      const snapshot = await attach(active.sequence);
      return snapshot.status.state === "finished" ? snapshot : undefined;
    });
    assert.deepEqual(finished.status, { state: "finished", sessionId: "fixture-session", result: { status: "completed", text: "done" } });
    assert.deepEqual(finished.events, []);
    assert.deepEqual(finished.inputs, [
      { id: "first", state: "accepted" }, { id: "uncertain", state: "uncertain" },
      { id: "idle", state: "notAccepted" }, { id: "late", state: "notAccepted" }
    ]);
    assert.deepEqual(await steer("uncertain", "duplicate"), { id: "uncertain", state: "uncertain" });
    assert.deepEqual(await steer("idle", "duplicate"), { id: "idle", state: "notAccepted" });
    assert.deepEqual(submitted, ["first", "uncertain", "idle"]);
    assert.deepEqual(await recovered.call({ ...identity, method: "acknowledge" }), { acknowledged: true });
    assert.deepEqual((await attach(active.sequence)).inputs, finished.inputs);
  } finally {
    result.resolve({ status: "cancelled" });
    first.resolve("injected");
    uncertain.resolve("idle");
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
      const unsupported = { id: "message-one", inputId: "unsupported", text: "not submitted" };
      assert.deepEqual((await send("steer", unsupported)).body, { id: unsupported.inputId, state: "notAccepted" });
      if (id === "claude") {
        for (let i = 0; i < 32; i++) {
          assert.deepEqual((await send("steer", { ...unsupported, inputId: `input-${i}` })).body, { id: `input-${i}`, state: "notAccepted" });
        }
        const snapshot = (await subscriber(first.sequence, false)).snapshot;
        assert.equal(snapshot.inputs.length, 32);
        assert.deepEqual(snapshot.inputs[0], { id: unsupported.inputId, state: "notAccepted" });
        assert.equal(snapshot.inputs.some(input => input.id === "input-31"), false);
      }
      const requestId = first.approvals[0]!.id;
      assert.equal(first.approvals[0]!.operation.engineId, id);
      assert.deepEqual((await send("answerApproval", { id: "different-turn", requestId, allow: true })).body, { accepted: false });
      assert.deepEqual((await send("answerApproval", { id: "message-one", requestId: randomUUID(), allow: true })).body, { accepted: false });
      const resumed = await subscriber(first.sequence, true);
      assert.deepEqual(resumed.snapshot.events, []);
      assert.deepEqual(resumed.snapshot.inputs[0], { id: unsupported.inputId, state: "notAccepted" });
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
