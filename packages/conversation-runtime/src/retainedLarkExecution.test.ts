import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { RetainedLarkExecution } from "./retainedLarkExecution.js";
import { retainedForegroundMcpContextToken } from "./retainedForegroundMcp.js";

test("retained foreground MCP requires the original live host and native session, even before the first poll", async () => {
  const root = mkdtempSync("/tmp/lark-fg-probe-");
  const socketPath = path.join(root, "e.sock");
  const token = randomBytes(32).toString("base64url");
  const turnId = randomUUID(), generation = randomUUID();
  let nativeSession = "original-native-session", probes = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.headers.authorization !== `Bearer ${token}` || call.method !== "attach" || call.id !== turnId || call.generation !== generation) {
      response.writeHead(409).end();
      return;
    }
    probes++;
    response.end(JSON.stringify({ foregroundLarkToolsActive: true, engineId: "dsh",
      status: { state: "active", sessionId: nativeSession }, sequence: 0, events: [], approvals: [], inputs: [] }));
  });
  server.listen(socketPath);
  await once(server, "listening");
  const db = new Database(path.join(root, "fixture.sqlite"));
  db.exec(`CREATE TABLE lark_retained_turns(message_id INTEGER, turn_id TEXT, generation TEXT, session_key TEXT,
    engine_id TEXT, trusted INTEGER, deadline TEXT, finalized INTEGER)`);
  db.prepare("INSERT INTO lark_retained_turns VALUES(1,?,?,'scope','dsh',1,?,0)")
    .run(turnId, generation, new Date(Date.now() + 60_000).toISOString());
  const setup = () => new RetainedLarkExecution(db, { socketPath, token, engineIds: ["dsh"] }, {
    workspace: () => root, admit: () => false, current: () => true,
    acceptSession: (_, session) => assert.equal(session, "original-native-session"),
    acceptInput: () => {}, authorize: async () => false, observe: () => false, finish: () => undefined, ended: () => {}
  });
  let retained = setup();
  try {
    const contextToken = retainedForegroundMcpContextToken(token, generation, turnId);
    assert.equal(await retained.resolveForegroundMcpBinding("Q".repeat(32)), undefined);
    assert.equal(await retained.confirmForegroundMcp(2, turnId, contextToken), false);
    assert.equal(probes, 0);
    assert.equal((await retained.resolveForegroundMcpBinding(contextToken))?.turn_id, turnId);
    retained.stop();
    retained = setup();
    assert.equal(retained.getForegroundMcpBinding(contextToken), undefined);
    assert.equal((await retained.resolveForegroundMcpBinding(contextToken))?.turn_id, turnId);
    nativeSession = "different-native-session";
    assert.equal(await retained.confirmForegroundMcp(1, turnId, contextToken), false);
    assert.equal(retained.getForegroundMcpBinding(contextToken), undefined);
    assert.equal(probes, 3);
  } finally {
    retained.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
