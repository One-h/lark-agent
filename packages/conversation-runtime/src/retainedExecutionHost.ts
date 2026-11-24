import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { ExecutionEngine } from "./executionEngines.js";
import { larkExecutionPolicy } from "./executionEngines.js";
import { retainedForegroundMcpPrompt } from "./retainedForegroundMcp.js";
import { RetainedExecutionTurns } from "./retainedExecutionTurns.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const generation = z.uuid();
const calls = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("status") }),
  z.strictObject({
    method: z.literal("start"), generation, id, engineId: id, text: z.string().min(1).max(24_000),
    sessionId: z.string().min(1).max(256).nullable(), model: z.string().min(1).max(256).nullable(),
    trusted: z.boolean(), deadline: z.iso.datetime().optional(), cwd: z.string().min(1).max(4096).optional(),
    lane: z.enum(["foreground", "task"]).optional(), taskId: z.uuid().optional(),
    resumeProof: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }),
  z.strictObject({ method: z.literal("attach"), generation, id, afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ method: z.literal("steer"), generation, id, inputId: id, text: z.string().min(1).max(24_000) }),
  z.strictObject({ method: z.literal("answerApproval"), generation, id, requestId: z.uuid(), allow: z.boolean() }),
  z.strictObject({ method: z.literal("acknowledge"), generation, id }),
  z.strictObject({ method: z.literal("cancel"), generation, id })
]);

const digest = (value: string) => createHash("sha256").update(value).digest();

function workspaceIdentity(cwd: string) {
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Invalid task workspace");
  const resolved = realpathSync(cwd);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error("Invalid task workspace");
  return { resolved, dev: stat.dev, ino: stat.ino };
}

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
  foregroundMcpServer?: NonNullable<Parameters<ExecutionEngine["open"]>[0]["mcpServers"]>[number];
  taskWorkspaces?: readonly string[];
  taskWorkspaceEngineIds?: readonly string[];
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
  const taskEngineIds = new Set(options.taskWorkspaceEngineIds);
  const fixedWorkspace = workspaceIdentity(options.workspace);
  const taskWorkspaces = new Map((options.taskWorkspaces ?? []).filter(cwd => cwd !== options.workspace)
    .map(cwd => [cwd, workspaceIdentity(cwd)]));
  const pinnedWorkspace = (cwd: string, expected?: ReturnType<typeof workspaceIdentity>) => {
    if (!expected) return;
    try {
      const current = workspaceIdentity(cwd);
      if (current.resolved === expected.resolved && current.dev === expected.dev && current.ino === expected.ino) return current.resolved;
    } catch { /* Directory is no longer available. */ }
  };
  const capabilities = (cwd: string | undefined, extra: boolean) => [...engines.values()]
    .filter(engine => !extra || taskEngineIds.has(engine.descriptor.id))
    .map(engine => ({ id: engine.descriptor.id, models: engine.descriptor.models,
      trusted: !!cwd && engine.supportsPolicy(larkExecutionPolicy(cwd, true)),
      restricted: !!cwd && engine.supportsPolicy(larkExecutionPolicy(cwd, false)) }));
  const nativeIdentities = new Map<string, { sessionId: string; turnId: string | null }>();
  type TaskScope = { taskId: string; engineId: string; trusted: boolean; model: string | null; workspace: ReturnType<typeof workspaceIdentity> };
  const taskScopes = new Map<string, TaskScope>();
  const proof = (scope: TaskScope, sessionId: string) => createHmac("sha256", options.token)
    .update(JSON.stringify(["lark-task-session-v1", scope.taskId, scope.engineId, scope.trusted, scope.model,
      scope.workspace.resolved, scope.workspace.dev, scope.workspace.ino, sessionId])).digest("hex");
  const foregroundTurns = new Set<string>();
  const supportsForegroundMcp = (engineId: string) => Boolean(options.foregroundMcpServer && engines.get(engineId)?.supportsLarkMcp);
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
      if (call.method === "status") {
        const fixedAvailable = pinnedWorkspace(options.workspace, fixedWorkspace);
        const fixed = capabilities(fixedAvailable && options.workspace, false);
        return send(200, { generation: hostGeneration, workspace: options.workspace,
          engines: fixed.map(engine => fixedAvailable && supportsForegroundMcp(engine.id) ? { ...engine, foregroundLarkTools: true } : engine),
          taskWorkspaces: [{ cwd: options.workspace, engines: fixed }, ...[...taskWorkspaces].flatMap(([cwd, identity]) => {
            const resolved = pinnedWorkspace(cwd, identity);
            return resolved ? [{ cwd, engines: capabilities(resolved, true) }] : [];
          })] });
      }
      if (call.generation !== hostGeneration) return send(409, { error: "execution host generation changed" });
      if (call.method === "attach") {
        const snapshot = turns.attach(call.id, call.afterSequence);
        const nativeIdentity = nativeIdentities.get(call.id);
        const foregroundLarkToolsActive = snapshot?.status.state === "active" && foregroundTurns.has(call.id);
        const taskScope = taskScopes.get(call.id);
        const sessionId = snapshot && "sessionId" in snapshot.status ? snapshot.status.sessionId : undefined;
        const sessionProof = taskScope && sessionId && proof(taskScope, sessionId);
        return send(200, snapshot && (nativeIdentity || foregroundLarkToolsActive || sessionProof)
          ? { ...snapshot, ...(nativeIdentity && { nativeIdentity }), ...(foregroundLarkToolsActive && { foregroundLarkToolsActive }),
            ...(sessionProof && { sessionProof }) }
          : snapshot);
      }
      if (call.method === "steer") return send(200, turns.steer(call.id, call.inputId, call.text));
      if (call.method === "answerApproval") return send(200, { accepted: turns.answerApproval(call.id, call.requestId, call.allow) });
      if (call.method === "acknowledge") {
        const acknowledged = await turns.acknowledge(call.id);
        if (acknowledged) foregroundTurns.delete(call.id);
        return send(200, { acknowledged });
      }
      if (call.method === "cancel") {
        foregroundTurns.delete(call.id);
        return send(200, { cancelled: turns.cancel(call.id) });
      }
      const engine = engines.get(call.engineId);
      const foreground = call.lane === "foreground";
      const task = call.lane === "task";
      if (task !== Boolean(call.taskId) || !task && call.resumeProof || task && !call.sessionId && call.resumeProof)
        return send(422, { error: "invalid task session scope" });
      const foregroundServer = foreground ? options.foregroundMcpServer : undefined;
      if (foreground && (call.cwd !== undefined || !foregroundServer || !supportsForegroundMcp(call.engineId))) {
        return send(422, { error: "foreground tools are unavailable for this execution request" });
      }
      const requestedWorkspace = call.cwd ?? options.workspace;
      const extra = requestedWorkspace !== options.workspace;
      const resolved = pinnedWorkspace(requestedWorkspace, extra ? taskWorkspaces.get(requestedWorkspace) : fixedWorkspace);
      const cwd = extra ? resolved : resolved && options.workspace;
      if (!cwd || extra && (!task || !taskEngineIds.has(call.engineId))) return send(422, { error: "task workspace is not allowed for this engine" });
      const taskScope: TaskScope | undefined = task && call.taskId ? { taskId: call.taskId, engineId: call.engineId,
        trusted: call.trusted, model: call.model, workspace: (extra ? taskWorkspaces.get(requestedWorkspace) : fixedWorkspace)! } : undefined;
      if (taskScope && call.sessionId && (!call.resumeProof
        || !timingSafeEqual(Buffer.from(call.resumeProof, "hex"), Buffer.from(proof(taskScope, call.sessionId), "hex"))))
        return send(422, { error: "cannot prove the original task session and workspace" });
      const policy = larkExecutionPolicy(cwd, call.trusted);
      if (!engine || !engine.supportsPolicy(policy) || call.model !== null && !engine.descriptor.models.includes(call.model)) {
        return send(422, { error: "engine cannot enforce requested execution policy" });
      }
      const duration = call.deadline ? Date.parse(call.deadline) - Date.now() : undefined;
      if (duration !== undefined && (duration <= 0 || duration > 600_000)) return send(422, { error: "invalid execution deadline" });
      const start = { model: call.model, sessionId: call.sessionId, policy,
        mcpServers: foregroundServer ? [foregroundServer] : task ? undefined : options.mcpServers,
        retainedDispatch: {
          key: `lark-task:${hostGeneration}/${call.id}`,
          recordNativeIdentity: (identity: { sessionId: string; turnId: string | null }) => nativeIdentities.set(call.id, identity)
        } };
      const text = foreground ? retainedForegroundMcpPrompt(call.text, options.token, hostGeneration, call.id, call.trusted) : call.text;
      turns.start(call.id, engine, start, text, duration);
      if (foreground) foregroundTurns.add(call.id);
      if (taskScope) taskScopes.set(call.id, taskScope);
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
      foregroundTurns.clear();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([closed, turns.stop()]);
    }
  };
}
