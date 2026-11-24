import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import { configuredNativeAcpEngines, listenRetainedExecutionHost } from "@lark-agent/conversation-runtime";
import { createTaskCodexEngine } from "./taskCodexEngine.js";

const socketPath = process.env.LARK_AGENT_ENGINE_HOST_SOCKET;
const workspace = process.env.LARK_AGENT_WORKSPACE_ROOT;
const token = process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
delete process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
if (!socketPath || !workspace || !token) throw new Error("Set the private engine socket, control token, and workspace");
const engines = configuredNativeAcpEngines(process.env, id => console.warn("Engine host launcher unavailable:", id));
const codex = process.env.LARK_AGENT_TASK_ORCHESTRATION === "1"
  ? new CodexAppServerClient(() => workspace, { socketPath: process.env.LARK_AGENT_TASK_CODEX_APP_SERVER_SOCKET })
  : undefined;
if (codex) engines.push(createTaskCodexEngine(codex, (process.env.LARK_AGENT_TASK_CODEX_MODELS ?? "").split(",").map(id => id.trim()).filter(Boolean)));
if (!engines.length) throw new Error("No engine host launchers are configured");
const host = await listenRetainedExecutionHost({ socketPath, token, workspace, engines });
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  void host.close().catch(() => { process.exitCode = 1; }).finally(() => codex?.stop());
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
