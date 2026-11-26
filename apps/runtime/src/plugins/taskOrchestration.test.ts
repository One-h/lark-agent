import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { TaskOrchestration, type TaskEngineHost, type TaskOrigin } from "./taskOrchestration.js";
import { TaskArtifacts } from "./taskArtifacts.js";
import { registerTaskOrchestrationReadRoutes } from "./taskOrchestrationReadRoutes.js";

const engines = ["codex", "claude", "dsh", "opencode", "agy"];
const origin: TaskOrigin = { messageId: 1, chatId: "chat", senderId: "requester", trusted: true, policy: "policy" };
type Native = {
  engineId: string; status: { state: string; sessionId?: string; result?: { status: string; text: string } };
  inputs: { id: string; state: string }[]; approvals: { id: string }[];
};

function fixture(t: { after(fn: () => void): void }, options: { concurrent?: boolean; artifacts?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lark-task-orchestration-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  const starts: Record<string, unknown>[] = [];
  const steering: Record<string, unknown>[] = [];
  const native = new Map<string, Native>();
  const sent: string[] = [];
  const files: { name: string; bytes: Buffer }[] = [];
  const postedFiles: string[] = [];
  const artifacts = new TaskArtifacts(path.join(dir, "artifacts"));
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
    ...(options.concurrent ? { concurrency: { global: 2, perEngine: 1 } } : {}),
    ...(options.artifacts ? { artifacts } : {}),
    send: (_id, text) => { sent.push(text); return { receipt: sendReceipt }; },
    upload: async (name, bytes) => { files.push({ name, bytes }); return "file_fixture"; },
    sendFile: (_id, fileKey) => { postedFiles.push(fileKey); return { receipt: sendReceipt }; },
    readback: async () => returnedReceipt, report: () => {} });
  let service = mount();
  const finish = (index: number, text: string) => {
    const state = native.get(String(starts[index].id))!;
    state.status = { ...state.status, state: "finished", result: { status: "completed", text } };
  };
  t.after(() => { service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, get service() { return service; }, starts, steering, native, sent, answers, finish, files, postedFiles, artifacts, dir,
    revision(id: string) {
      return db.prepare("SELECT task_revision FROM lark_orchestration_tasks WHERE id=?").pluck().get(id) as number;
    },
    restart() { service.close(); service = mount(); },
    uncertainSend() { sendReceipt = undefined; }, readback() { returnedReceipt = "om_readback"; },
    deny() { allowed = false; }, loseStart() { loseStart = true; },
    loseSteer() { loseSteer = true; }, unsupportedSteer() { steeringState = "notAccepted"; },
    replaceHost() { generation = "replacement"; } };
}

const dispatch = { action: "dispatch", goal: "Research three approaches", worker: { engine: "codex" } };
const approved = async () => "approved" as const;
const tick = async (f: ReturnType<typeof fixture>, n = 1) => { for (let i = 0; i < n; i++) await f.service.tick(); };

test("worker-only ownership cannot outlive the source turn or a failed admission", async t => {
  const f = fixture(t);
  const handoff = { ...dispatch, delivery: "worker_only" };
  const request = { ...origin, turnId: "foreground" };
  await assert.rejects(f.service.command(origin, handoff, approved), /bound foreground turn/);
  let release!: (decision: "approved") => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.service.command(request, handoff, () => new Promise(resolve => { release = resolve; entered(); }));
  await waiting;
  assert.equal(f.service.ownsForegroundReply(1, "foreground"), false);
  release("approved");
  await pending;
  f.restart();
  assert.equal(f.service.ownsForegroundReply(1, "foreground"), true);
  assert.equal(f.service.ownsForegroundReply(1, "new-turn"), false);
  assert.equal(f.service.ownsForegroundReply(2, "foreground"), false);
  await f.service.command({ ...request, messageId: 2, turnId: "denied" }, handoff, async () => "rejected");
  assert.equal(f.service.ownsForegroundReply(2, "denied"), false);
});

test("operator task reads separate execution, review and verified delivery for the exact result", async t => {
  const f = fixture(t, { artifacts: true });
  f.db.exec(`CREATE TABLE lark_messages (id INTEGER PRIMARY KEY, chat_type TEXT, received_at TEXT);
    CREATE TABLE contacts (open_id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO lark_messages VALUES(1,'group','2026-01-01T00:00:00Z');
    INSERT INTO contacts VALUES('requester','Fixture Requester');`);
  const app = Fastify();
  t.after(() => app.close());
  const headers = { authorization: "Bearer test-runtime-token" };
  registerTaskOrchestrationReadRoutes(app, f.db, request => request.headers.authorization === headers.authorization);
  const base = "/v1/orchestration-tasks";
  assert.equal((await app.inject(base)).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}?messageId=0`, headers })).statusCode, 400);
  const issued = await f.service.command(origin, { ...dispatch, reviewer: { engine: "claude", criteria: "verify sources" } }, approved);
  const url = `${base}/${taskId(issued)}`;
  const read = async (path: string) => {
    const response = await app.inject({ url: path, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    return response.json();
  };
  assert.deepEqual((await read(`${base}?messageId=2`)).items, []);
  assert.deepEqual((await read(`${base}?messageId=1&status=queued`)).items[0], {
    id: taskId(issued), messageId: 1, status: "queued", chatType: "group", requestedAt: "2026-01-01T00:00:00Z",
    requesterName: "Fixture Requester", goal: dispatch.goal, worker: { engine: "codex" }
  });
  await tick(f);
  const resultId = String(f.starts[0].id);
  writeFileSync(path.join(f.artifacts.workerDirectory(resultId), "totals.csv"), "name,total\nA,2\n");
  f.finish(0, "Result: deliver\nResearch report\nArtifact: file totals.csv");
  await tick(f);
  const awaiting = await read(url);
  assert.equal(awaiting.execution.state, "completed");
  assert.equal(awaiting.review.pending, true);
  assert.equal(awaiting.review.decision, null);
  assert.deepEqual(awaiting.delivery, []);

  f.finish(1, "Verdict: pass\nSources verified.");
  await tick(f, 3);
  f.db.prepare("UPDATE lark_orchestration_outbox SET state='sending',receipt=NULL WHERE artifact_id=?").run(resultId);
  const verified = await read(url);
  assert.equal(verified.review.decision.verdict, "pass");
  assert.equal(verified.result.text, "Research report");
  assert.deepEqual(verified.delivery.map((row: { state: string; receipt: string | null }) => [row.state, row.receipt]),
    [["sending", null], ["sent", "om_delivery"]]);
  assert.equal(verified.result.artifacts[0].name, "totals.csv");
  const downloadUrl = `${url}/results/${resultId}/files/${verified.result.artifacts[0].id}`;
  const download = await app.inject({ url: downloadUrl, headers });
  assert.equal(download.headers["content-disposition"], 'attachment; filename="totals.csv"');
  assert.equal(download.body, "name,total\nA,2\n");
  assert.equal((await app.inject({ url: `${downloadUrl}9`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url, headers })).statusCode, 404);
  f.db.prepare("UPDATE lark_orchestration_tasks SET review_revision=review_revision+1,status='awaiting_review' WHERE id=?").run(taskId(issued));
  assert.equal((await read(url)).review.decision, null);
});
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
  await f.service.command({ ...origin, messageId: 2 }, { action: "follow_up", taskId: taskId(result), expectedRevision: f.revision(taskId(result)),
    text: "No need to continue", expandsScope: false },
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
  await f.service.command({ ...origin, messageId: 2 }, { action: "follow_up", taskId: taskId(result), expectedRevision: f.revision(taskId(result)),
    text: "Narrow the period", expandsScope: false }, approved);
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
    action: "follow_up", taskId: taskId(result), expectedRevision: f.revision(taskId(result)), text: "change scope", expandsScope: false
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
  const acceptance = { action: "accept", taskId: taskId(task), resultId, expectedRevision: f.revision(taskId(task)),
    verdict: "pass", reason: "Dates verified" };
  await assert.rejects(f.service.command({ ...origin, senderId: "other", messageId: 2 }, acceptance, approved), /not accessible/);
  const accepted = await f.service.command({ ...origin, messageId: 2 }, acceptance, async () => {
    assert.fail("acceptance is not a new execution authorization");
  });
  assert.equal((accepted as { status: string }).status, "approved");
  assert.equal(f.db.prepare("SELECT status FROM lark_orchestration_tasks").pluck().get(), "accepted");
});

test("stale approval cannot overwrite a newer input version, and exact replay returns the stored decision", async t => {
  const f = fixture(t);
  const id = taskId(await f.service.command({ ...origin, threadId: "original-thread" }, {
    ...dispatch, constraints: ["read only"], deliverables: ["report"], resources: ["fixture"]
  }, approved));
  const inThread = (messageId: number) => ({ ...origin, messageId, threadId: "original-thread" });
  const revision = f.revision(id);
  const change = { action: "follow_up", taskId: id, expectedRevision: revision, text: "Include one new source", expandsScope: true };
  let release!: (value: "approved") => void;
  const pending = f.service.command(inThread(2), change, intent => {
    assert.match(intent, /read only/);
    return new Promise(resolve => { release = resolve; });
  });
  const append = { ...change, expandsScope: false, text: "Clarify the original source" };
  const updated = await f.service.command(inThread(3), append, approved);
  release("approved");
  assert.equal((await pending as { status: string }).status, "failed");
  assert.deepEqual(await f.service.command(inThread(3), append, approved), updated);
  assert.equal(f.revision(id), revision + 1);
  assert.deepEqual(await f.service.command({ ...inThread(4), threadId: "other-thread" }, { action: "list" }, approved), []);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM lark_orchestration_contracts").pluck().get(), 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM lark_orchestration_jobs").pluck().get(), 2);
});

test("same frozen attachment is made available to the reviewer and delivered once", async t => {
  const f = fixture(t, { artifacts: true });
  await f.service.command(origin, { ...dispatch, reviewer: { engine: "claude", criteria: "Verify source rows" } }, approved);
  await tick(f);
  const original = path.join(f.artifacts.workerDirectory(String(f.starts[0].id)), "rows.csv");
  writeFileSync(original, "sku,gmv\n123,45\n");
  f.finish(0, "Result: deliver\nFixture rows\nArtifact: file rows.csv");
  await tick(f);
  writeFileSync(original, "sku,gmv\n123,99\n");
  const reviewFile = String(f.starts[1].text).match(/Frozen file: (\S+rows\.csv)/)?.[1];
  assert(reviewFile);
  assert.equal(readFileSync(reviewFile, "utf8"), "sku,gmv\n123,45\n");
  f.finish(1, "Verdict: pass\nExact rows verified");
  await tick(f, 4);
  assert.deepEqual(f.files.map(o => [o.name, o.bytes.toString()]), [["rows.csv", "sku,gmv\n123,45\n"]]);
  assert.deepEqual(f.postedFiles, ["file_fixture"]);
  assert.equal(f.sent.length, 1);
});

test("attachment uses a private job directory and refuses symlinks before review or upload", async t => {
  const f = fixture(t, { artifacts: true });
  await f.service.command(origin, dispatch, approved);
  await tick(f);
  const source = path.join(f.dir, "unrelated.txt");
  writeFileSync(source, "unrelated");
  symlinkSync(source, path.join(f.artifacts.workerDirectory(String(f.starts[0].id)), "report.txt"));
  f.finish(0, "Result: deliver\nArtifact: file report.txt");
  await tick(f, 3);
  assert.match(f.sent[0], /无法验证/);
  assert.deepEqual(f.files, []);
});

test("unclear reviewer is asked once in its original session, and authorized rework is explicit and one-shot", async t => {
  const f = fixture(t);
  const id = taskId(await f.service.command(origin, { ...dispatch, allowReworkOnce: true,
    reviewer: { engine: "claude", criteria: "Check dates" } }, approved));
  await tick(f);
  const resultId = String(f.starts[0].id);
  const worker = f.native.get(resultId)?.status.sessionId;
  f.finish(0, "Result: deliver\nInitial report");
  await tick(f);
  const review = f.native.get(String(f.starts[1].id))?.status.sessionId;
  f.finish(1, "I looked but have not given a verdict.");
  await tick(f);
  assert.equal(f.starts[2].sessionId, review);
  f.finish(2, "Verdict: changes requested\nDate window is wrong.");
  await tick(f, 3);
  assert.equal(f.starts.length, 3);
  const intent = { action: "rework", taskId: id, expectedRevision: f.revision(id), resultId, text: "Correct the date window" };
  const decision = await f.service.command({ ...origin, messageId: 2 }, intent, async () => { assert.fail("already authorized"); });
  assert.equal((decision as { status: string }).status, "approved");
  assert.deepEqual(await f.service.command({ ...origin, messageId: 2 }, intent, approved), decision);
  await tick(f);
  assert.equal(f.starts[3].sessionId, worker);
  assert.match(String(f.starts[3].text), /Date window is wrong/);
  const second = await f.service.command({ ...origin, messageId: 3 }, { ...intent, expectedRevision: f.revision(id) }, approved);
  assert.equal((second as { status: string }).status, "failed");
});

test("engine and global limits allow disjoint engines without concurrent runs for the same task", async t => {
  const f = fixture(t, { concurrent: true });
  await f.service.command(origin, dispatch, approved);
  await f.service.command({ ...origin, messageId: 2 }, dispatch, approved);
  await f.service.command({ ...origin, messageId: 3 }, { ...dispatch, worker: { engine: "dsh" } }, approved);
  await tick(f);
  assert.deepEqual(f.starts.map(row => row.engineId), ["codex", "dsh"]);
  f.finish(0, "Result: done\nFinished");
  await tick(f);
  assert.deepEqual(f.starts.map(row => row.engineId), ["codex", "dsh", "codex"]);
});

test("amending the review contract cannot apply a late verdict under the old criteria", async t => {
  const f = fixture(t);
  const task = taskId(await f.service.command(origin, { ...dispatch, reviewer: { engine: "claude", criteria: "Old criteria" } }, approved));
  await tick(f);
  f.finish(0, "Result: deliver\nCandidate");
  await tick(f);
  const revised = await f.service.command({ ...origin, messageId: 2 }, { action: "amend_review", taskId: task,
    expectedRevision: f.revision(task), reviewer: { engine: "agy", criteria: "New criteria" } }, intent => {
    assert.match(intent, /New criteria/); return approved();
  });
  assert.equal((revised as { contractRevision: number }).contractRevision, 2);
  f.finish(1, "Verdict: pass\nOnly old checks passed");
  await tick(f);
  assert.equal(f.starts[2].engineId, "agy");
  assert.equal(f.db.prepare("SELECT status FROM lark_orchestration_tasks").pluck().get(), "awaiting_review");
  f.finish(2, "Verdict: changes requested\nThe new check failed");
  await tick(f, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM lark_orchestration_reviews").pluck().get(), 2);
  assert.match(f.sent.join("\n"), /The new check failed/);
  assert.doesNotMatch(f.sent.join("\n"), /Only old checks passed/);
});

test("a worker's unmarked text is clarified before silently bypassing a requested review", async t => {
  const f = fixture(t);
  await f.service.command(origin, { ...dispatch, reviewer: { engine: "claude", criteria: "Check evidence" } }, approved);
  await tick(f);
  const worker = f.native.get(String(f.starts[0].id))?.status.sessionId;
  f.finish(0, "The completed report did not state whether to submit.");
  await tick(f);
  assert.equal(f.starts[1].engineId, "codex");
  assert.equal(f.starts[1].sessionId, worker);
  assert.equal(f.sent.length, 0);
  f.finish(1, "Result: deliver\nReport with evidence");
  await tick(f);
  assert.equal(f.starts[2].engineId, "claude");
});

test("upgrading the previous pilot preserves accepted task identity and never replays a legacy command", async t => {
  const f = fixture(t);
  const created = await f.service.command(origin, dispatch, approved);
  f.db.exec(`ALTER TABLE lark_orchestration_commands RENAME TO fixture_v13_command;
    CREATE TABLE lark_orchestration_commands(source_id INTEGER NOT NULL,task_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(source_id,task_id));
    INSERT INTO lark_orchestration_commands SELECT source_id,task_id,request_hash,status FROM fixture_v13_command;
    DROP TABLE fixture_v13_command;`);
  f.restart();
  const replay = await f.service.command(origin, dispatch, async () => { assert.fail("legacy command cannot be replayed"); });
  assert.equal(taskId(replay), taskId(created));
  await tick(f);
  assert.equal(f.starts.length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM lark_orchestration_contracts").pluck().get(), 1);
});
