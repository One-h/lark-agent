import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { TaskOrchestration, type TaskEngineHost, type TaskOrigin } from "./taskOrchestration.js";

const engines = ["codex", "claude", "dsh", "opencode", "agy"];
const origin: TaskOrigin = { messageId: 1, chatId: "chat", senderId: "requester", trusted: true, policy: "policy" };
type Native = {
  engineId: string; status: { state: string; sessionId?: string; result?: { status: string; text: string } };
  inputs: { id: string; state: string }[]; approvals: { id: string }[];
};

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-task-orchestration-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  const starts: Record<string, unknown>[] = [];
  const steering: Record<string, unknown>[] = [];
  const native = new Map<string, Native>();
  const sent: string[] = [];
  const answers: Record<string, unknown>[] = [];
  let sendReceipt: string | undefined = "om_delivery";
  let returnedReceipt: string | undefined;
  let steeringState = "accepted";
  let allowed = true;
  let loseStart = false;
  let loseSteer = false;
  let generation = "generation";
  const host: TaskEngineHost = {
    supports: id => engines.includes(id),
    async call<T>(request: Record<string, unknown>): Promise<T> {
      const id = String(request.id);
      let result: unknown;
      switch (request.method) {
        case "status": result = { generation, workspace: dir,
          engines: engines.map(id => ({ id, models: [], restricted: id !== "codex", trusted: true })) }; break;
        case "start":
          starts.push(request);
          native.set(id, { engineId: String(request.engineId), status: { state: "active", sessionId: String(request.sessionId ?? `session-${id}`) }, approvals: [], inputs: [] });
          if (loseStart) throw new Error("lost start response");
          break;
        case "attach":
          if (request.generation !== generation) throw new Error("generation changed");
          result = native.get(id) ?? null;
          break;
        case "steer":
          steering.push(request);
          native.get(id)!.inputs.push({ id: String(request.inputId), state: steeringState });
          if (loseSteer) throw new Error("lost steer response");
          result = { state: steeringState };
          break;
        case "answerApproval": answers.push(request); native.get(id)!.approvals = []; break;
        case "acknowledge": result = { acknowledged: true }; break;
        default: throw new Error("unexpected call");
      }
      return result as T;
    }
  };
  const mount = () => new TaskOrchestration({ db, host, workspace: () => dir, allows: () => allowed,
    send: (_id, text) => { sent.push(text); return { receipt: sendReceipt }; },
    readback: async () => returnedReceipt, report: () => {} });
  let service = mount();
  const finish = (index: number, text: string) => {
    const state = native.get(String(starts[index].id))!;
    state.status = { ...state.status, state: "finished", result: { status: "completed", text } };
  };
  t.after(() => { service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, get service() { return service; }, starts, steering, native, sent, answers, finish,
    restart() { service.close(); service = mount(); },
    uncertainSend() { sendReceipt = undefined; }, readback() { returnedReceipt = "om_readback"; },
    deny() { allowed = false; }, loseStart() { loseStart = true; },
    loseSteer() { loseSteer = true; }, unsupportedSteer() { steeringState = "notAccepted"; },
    replaceHost() { generation = "replacement"; } };
}

const dispatch = { action: "dispatch", goal: "Research three approaches", worker: { engine: "codex" } };
const approved = async () => "approved" as const;
const tick = async (f: ReturnType<typeof fixture>, n = 1) => { for (let i = 0; i < n; i++) await f.service.tick(); };
const taskId = (value: unknown) => (value as { taskId: string }).taskId;

test("blocked admission cannot start; duplicates share the same task and do not reapprove", async t => {
  const f = fixture(t);
  let release!: (value: "expired") => void;
  const pending = f.service.command(origin, dispatch, () => new Promise(resolve => { release = resolve; }));
  await tick(f);
  assert.equal(f.starts.length, 0);
  const duplicate = await f.service.command(origin, dispatch, approved);
  assert.equal((duplicate as { status: string }).status, "authorizing");
  release("expired");
  assert.equal(taskId(await pending), taskId(duplicate));
  await tick(f);
  assert.equal(f.starts.length, 0);
  await assert.rejects(f.service.command(origin, { ...dispatch, goal: "different intent" }, approved), /different task action/);
});

test("delegation and plain-text reviewer result survive a runtime restart", async t => {
  for (const engine of engines) await t.test(engine, async t => {
    const f = fixture(t);
    f.loseStart();
    const result = await f.service.command(origin, { ...dispatch, worker: { engine }, reviewer: { engine: "claude", criteria: "verify sources" } }, approved);
    assert.match(taskId(result), /^[a-f0-9-]+$/);
    await tick(f);
    assert.equal(f.starts.length, 1);
    f.restart();
    f.finish(0, "Result: deliver\nResearch report");
    await tick(f);
    assert.equal(f.starts.length, 2);
    assert.match(String(f.starts[1].text), /Frozen worker result:\nResearch report/);
    f.finish(1, "Verdict: pass\nSources verified.");
    await tick(f, 3);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /Sources verified/);
    assert.equal(f.db.prepare("SELECT status FROM lark_orchestration_tasks").pluck().get(), "accepted");
  });
});

test("the original worker receives follow-up and can finish without an artifact or reviewer", async t => {
  const f = fixture(t);
  const result = await f.service.command(origin, { ...dispatch, reviewer: { engine: "claude", criteria: "verify sources" } }, approved);
  await tick(f);
  await f.service.command({ ...origin, messageId: 2 }, { action: "follow_up", taskId: taskId(result), text: "No need to continue", expandsScope: false },
    async () => { assert.fail("same-scope follow-up must not ask for approval"); });
  f.loseSteer();
  await tick(f);
  assert.equal(f.steering.length, 1);
  f.restart();
  f.finish(0, "Result: done\nNo further work needed.");
  await tick(f, 3);
  assert.equal(f.steering.length, 1);
  assert.equal(f.starts.length, 1);
  assert.match(f.sent[0], /No further work/);
});

test("unsupported steering opens the next turn in the same worker session, once", async t => {
  const f = fixture(t);
  const result = await f.service.command(origin, dispatch, approved);
  await tick(f);
  const sessionId = f.native.get(String(f.starts[0].id))!.status.sessionId;
  f.unsupportedSteer();
  await f.service.command({ ...origin, messageId: 2 }, { action: "follow_up", taskId: taskId(result), text: "Narrow the period", expandsScope: false }, approved);
  await tick(f, 2);
  assert.equal(f.starts.length, 1);
  assert.equal(f.steering.length, 1);
  f.finish(0, "Result: deliver\nFirst report");
  await tick(f);
  assert.equal(f.starts[1].sessionId, sessionId);
  await tick(f);
  assert.match(f.sent[0], /First report/);
});

test("receipt readback never resends, and a lost engine generation never replays work", async t => {
  const f = fixture(t);
  f.uncertainSend();
  await f.service.command(origin, dispatch, approved);
  await tick(f);
  f.finish(0, "Result: done\nAlready finished");
  await tick(f, 2);
  f.restart();
  f.db.prepare("UPDATE lark_orchestration_outbox SET attempted_at=?").run(new Date(Date.now() - 30_000).toISOString());
  f.readback();
  await tick(f, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.db.prepare("SELECT receipt FROM lark_orchestration_outbox").pluck().get(), "om_readback");
  await f.service.command({ ...origin, messageId: 2 }, dispatch, approved);
  await tick(f);
  f.replaceHost();
  await tick(f, 2);
  assert.equal(f.starts.length, 2);
  assert.equal(f.db.prepare("SELECT status FROM lark_orchestration_tasks WHERE message_id=2").pluck().get(), "uncertain");
});

test("approval of dispatch cannot silently elevate a restricted engine or cross task owners", async t => {
  const f = fixture(t);
  const ordinary = { ...origin, trusted: false };
  await assert.rejects(f.service.command(ordinary, dispatch, approved), /does not provide/);
  const result = await f.service.command(ordinary, { ...dispatch, worker: { engine: "claude" } }, approved);
  await assert.rejects(f.service.command({ ...ordinary, messageId: 2, senderId: "another" }, {
    action: "follow_up", taskId: taskId(result), text: "change scope", expandsScope: false
  }, approved), /not accessible/);
  await tick(f);
  const active = f.native.get(String(f.starts[0].id))!;
  active.approvals.push({ id: "approval" });
  await tick(f);
  assert.equal(f.answers[0].allow, false);
  f.finish(0, "Result: deliver\nOutput must not leave revoked scope");
  f.deny();
  await tick(f, 2);
  assert.deepEqual(f.sent, []);
});

test("requester acceptance is fenced to the original sender and delivered result", async t => {
  const f = fixture(t);
  const task = await f.service.command(origin, { ...dispatch, reviewer: { engine: "requester", criteria: "Verify the dates" } }, approved);
  await tick(f);
  f.finish(0, "Result: deliver\nA dated report.");
  await tick(f, 2);
  assert.equal(f.starts.length, 1);
  const resultId = String(f.starts[0].id);
  const acceptance = { action: "accept", taskId: taskId(task), resultId, verdict: "pass", reason: "Dates verified" };
  await assert.rejects(f.service.command({ ...origin, senderId: "other", messageId: 2 }, acceptance, approved), /not accessible/);
  const accepted = await f.service.command({ ...origin, messageId: 2 }, acceptance, async () => {
    assert.fail("acceptance is not a new execution authorization");
  });
  assert.equal((accepted as { status: string }).status, "approved");
  assert.equal(f.db.prepare("SELECT status FROM lark_orchestration_tasks").pluck().get(), "accepted");
});
