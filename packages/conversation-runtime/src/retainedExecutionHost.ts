import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { ExecutionEngine } from "./executionEngines.js";
import { larkExecutionPolicy } from "./executionEngines.js";
import { RetainedExecutionTurns } from "./retainedExecutionTurns.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const generation = z.uuid();
const calls = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("status") }),
  z.strictObject({
    method: z.literal("start"), generation, id, engineId: id, text: z.string().min(1).max(24_000),
    sessionId: z.string().min(1).max(256).nullable(), model: z.string().min(1).max(256).nullable(),
    trusted: z.boolean(), deadline: z.iso.datetime().optional()
  }),
  z.strictObject({ method: z.literal("attach"), generation, id, afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ method: z.literal("answerApproval"), generation, id, requestId: z.uuid(), allow: z.boolean() }),
  z.strictObject({ method: z.literal("acknowledge"), generation, id }),
  z.strictObject({ method: z.literal("cancel"), generation, id })
]);

const digest = (value: string) => createHash("sha256").update(value).digest();

async function parseRequest(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 192_000) return null;
    chunks.push(bytes);
  }
  try { return calls.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return null; }
}

// This control channel is for the Lark runtime, never an agent tool. Engine
// executables, workspace and MCP configuration are owned by the host operator.
export async function listenRetainedExecutionHost(options: {
  socketPath: string; token: string; workspace: string; engines: readonly ExecutionEngine[];
  mcpServers?: Parameters<ExecutionEngine["open"]>[0]["mcpServers"];
}) {
  const { socketPath } = options;
  if (!path.isAbsolute(socketPath) || options.token.length < 32 || !path.isAbsolute(options.workspace)) {
    throw new Error("Execution host requires an absolute socket and workspace and a private control token");
  }
  const directory = lstatSync(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error("Execution host socket requires a private user-owned directory");
  }
  const hostGeneration = randomUUID();
  const tokenHash = digest(`Bearer ${options.token}`);
  const engines = new Map(options.engines.map(engine => [engine.descriptor.id, engine]));
  const turns = new RetainedExecutionTurns();
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
    const send = (status: number, result: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(result));
    };
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), tokenHash)) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/turns") {
      send(404, { error: "not found" });
      return;
    }
    try {
      const call = await parseRequest(req);
      if (!call) return send(400, { error: "invalid request" });
      if (call.method === "status") return send(200, { generation: hostGeneration, workspace: options.workspace });
      if (call.generation !== hostGeneration) return send(409, { error: "execution host generation changed" });
      if (call.method === "attach") return send(200, turns.attach(call.id, call.afterSequence));
      if (call.method === "answerApproval") return send(200, { accepted: turns.answerApproval(call.id, call.requestId, call.allow) });
      if (call.method === "acknowledge") return send(200, { acknowledged: await turns.acknowledge(call.id) });
      if (call.method === "cancel") return send(200, { cancelled: turns.cancel(call.id) });
      const engine = engines.get(call.engineId);
      const policy = larkExecutionPolicy(options.workspace, call.trusted);
      if (!engine || !engine.supportsPolicy(policy) || call.model !== null && !engine.descriptor.models.includes(call.model)) {
        return send(422, { error: "engine cannot enforce requested execution policy" });
      }
      const duration = call.deadline ? Date.parse(call.deadline) - Date.now() : undefined;
      if (duration !== undefined && (duration <= 0 || duration > 600_000)) return send(422, { error: "invalid execution deadline" });
      turns.start(call.id, engine, { model: call.model, sessionId: call.sessionId, policy, mcpServers: options.mcpServers }, call.text, duration);
      send(202, { started: true });
    } catch {
      if (!res.headersSent) send(409, { error: "execution host cannot apply request" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([closed, turns.stop()]);
    }
  };
}
