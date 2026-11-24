import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import { configuredNativeAcpEngines, listenRetainedExecutionHost, retainedForegroundMcpBearer } from "@lark-agent/conversation-runtime";
import { createTaskCodexEngine, createTaskRestrictedCodexPool } from "./taskCodexEngine.js";

const socketPath = process.env.LARK_AGENT_ENGINE_HOST_SOCKET;
const workspace = process.env.LARK_AGENT_WORKSPACE_ROOT;
const token = process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
delete process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
if (!socketPath || !workspace || !token) throw new Error("Set the private engine socket, control token, and workspace");
const engines = configuredNativeAcpEngines(process.env, id => console.warn("Engine host launcher unavailable:", id));
const tasksEnabled = process.env.LARK_AGENT_TASK_ORCHESTRATION === "1";
const taskSocket = process.env.LARK_AGENT_TASK_CODEX_APP_SERVER_SOCKET;
const foregroundSocket = process.env.LARK_AGENT_CODEX_APP_SERVER_SOCKET;
const socketTarget = (socket: string) => {
  try { return realpathSync(socket); } catch { return resolve(socket); }
};
if (tasksEnabled && taskSocket && foregroundSocket && socketTarget(taskSocket) === socketTarget(foregroundSocket)) {
  throw new Error("Task Codex requires an App Server socket separate from foreground Codex");
}
const taskCodexEnvironment = () => {
  const env = { ...process.env };
  delete env.LARK_AGENT_RUNTIME_TOKEN;
  delete env.LARK_AGENT_MCP_TOKEN;
  delete env.LARK_AGENT_HOST_TOKEN;
  return env;
};
const codex = tasksEnabled ? new CodexAppServerClient(() => workspace, { socketPath: taskSocket, env: taskCodexEnvironment }) : undefined;
const restrictedCodex = tasksEnabled ? createTaskRestrictedCodexPool(taskCodexEnvironment) : undefined;
if (codex) engines.push(createTaskCodexEngine(codex,
  (process.env.LARK_AGENT_TASK_CODEX_MODELS ?? "").split(",").map(id => id.trim()).filter(Boolean), restrictedCodex));
if (!engines.length) throw new Error("No engine host launchers are configured");

let taskWorkspaces: unknown = [];
if (tasksEnabled) {
  try { taskWorkspaces = JSON.parse(process.env.LARK_AGENT_TASK_ALLOWED_WORKSPACES ?? "[]"); }
  catch { throw new Error("LARK_AGENT_TASK_ALLOWED_WORKSPACES must be a JSON array of absolute workspace paths"); }
}
if (!Array.isArray(taskWorkspaces) || taskWorkspaces.some(cwd => typeof cwd !== "string")) {
  throw new Error("LARK_AGENT_TASK_ALLOWED_WORKSPACES must be a JSON array of absolute workspace paths");
}
function foregroundRuntimeUrl(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password) return url.href;
  } catch { /* Report only the configuration requirement, not the supplied URL. */ }
  throw new Error("Retained foreground tools require a loopback runtime URL");
}

const runtimeUrl = tasksEnabled ? foregroundRuntimeUrl(process.env.LARK_AGENT_RUNTIME_URL) : undefined;
const foregroundMcpServer = runtimeUrl ? {
  name: "lark_tools", command: process.execPath,
  args: [fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fileURLToPath(new URL("../../../packages/mcp-stickers/src/agentTools.ts", import.meta.url))],
  env: [{ name: "LARK_AGENT_RUNTIME_URL", value: runtimeUrl },
    { name: "LARK_AGENT_MCP_TOKEN", value: retainedForegroundMcpBearer(token) }]
} : undefined;
const host = await listenRetainedExecutionHost({ socketPath, token, workspace, engines, taskWorkspaces,
  taskWorkspaceEngineIds: tasksEnabled ? engines.map(engine => engine.descriptor.id) : [], foregroundMcpServer });
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  void host.close().catch(() => { process.exitCode = 1; }).finally(() => { codex?.stop(); restrictedCodex?.close(); });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
