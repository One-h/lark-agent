import { configuredNativeAcpEngines, listenRetainedExecutionHost } from "@lark-agent/conversation-runtime";

const socketPath = process.env.LARK_AGENT_ENGINE_HOST_SOCKET;
const workspace = process.env.LARK_AGENT_WORKSPACE_ROOT;
const token = process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
delete process.env.LARK_AGENT_ENGINE_HOST_TOKEN;
if (!socketPath || !workspace || !token) throw new Error("Set the private engine socket, control token, and workspace");
const engines = configuredNativeAcpEngines(process.env, id => console.warn("Engine host launcher unavailable:", id));
if (!engines.length) throw new Error("No engine host launchers are configured");
const host = await listenRetainedExecutionHost({ socketPath, token, workspace, engines });
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  void host.close().catch(() => { process.exitCode = 1; });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
