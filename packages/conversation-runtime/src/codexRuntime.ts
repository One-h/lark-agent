import { CodexAppServerClient, codexSocketMaxPayloadBytes } from "@lark-agent/adapter-codex-app-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./context.js";
import type { ExecutionEngineMcpServer } from "./executionEngines.js";

// All Lark conversations share one App Server and the user's default CODEX_HOME,
// so their threads stay visible in the desktop app.
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stickerMcpArgs = [path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(sourceRoot, "packages", "mcp-stickers", "src", "index.ts")];

export function larkStickerMcpCodexConfig(): string[] {
  return [
    `mcp_servers.lark_stickers.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.lark_stickers.args=${JSON.stringify(stickerMcpArgs)}`,
    'mcp_servers.lark_stickers.env_vars=["LARK_AGENT_RUNTIME_URL","LARK_AGENT_RUNTIME_TOKEN"]',
    "mcp_servers.lark_stickers.startup_timeout_sec=10",
    "mcp_servers.lark_stickers.tool_timeout_sec=45"
  ];
}

export function larkExternalStickerMcpServer(): ExecutionEngineMcpServer | undefined {
  if (!config.larkAgentRuntimeUrl || !config.larkAgentMcpToken) return;
  return {
    name: "lark_stickers", command: process.execPath, args: [...stickerMcpArgs, "--stickers-only"],
    env: [{ name: "LARK_AGENT_RUNTIME_URL", value: config.larkAgentRuntimeUrl },
      { name: "LARK_AGENT_MCP_TOKEN", value: config.larkAgentMcpToken }]
  };
}

export function larkAgentToolsMcpServer(): ExecutionEngineMcpServer | undefined {
  if (!config.larkAgentRuntimeUrl || !config.larkAgentMcpToken) return;
  return {
    name: "lark_tools", command: process.execPath,
    args: [path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(sourceRoot, "packages", "mcp-stickers", "src", "agentTools.ts")],
    env: [{ name: "LARK_AGENT_RUNTIME_URL", value: config.larkAgentRuntimeUrl },
      { name: "LARK_AGENT_MCP_TOKEN", value: config.larkAgentMcpToken }]
  };
}

export function larkMcpCodexConfig(): string[] {
  const tools = larkAgentToolsMcpServer();
  return [...larkStickerMcpCodexConfig(), ...(tools ? [
    `mcp_servers.lark_tools.command=${JSON.stringify(tools.command)}`,
    `mcp_servers.lark_tools.args=${JSON.stringify(tools.args)}`,
    'mcp_servers.lark_tools.env_vars=["LARK_AGENT_RUNTIME_URL","LARK_AGENT_MCP_TOKEN"]',
    "mcp_servers.lark_tools.startup_timeout_sec=10",
    "mcp_servers.lark_tools.tool_timeout_sec=1200"
  ] : [])];
}

export let larkCodexSocket: string | undefined;
let larkCodexSocketMaxPayloadMiB: number | undefined;
export function configureLarkCodexSocket(socketPath?: string, maxPayloadMiB?: number): void {
  codexSocketMaxPayloadBytes(maxPayloadMiB);
  stopLarkCodexSocketReadback();
  larkCodexSocket = socketPath;
  larkCodexSocketMaxPayloadMiB = maxPayloadMiB;
}

export const codexAppServer = new CodexAppServerClient(
  () => config.workspaceRoot || process.cwd(),
  {
    config: larkMcpCodexConfig,
    socketPath: () => larkCodexSocket,
    socketMaxPayloadMiB: () => larkCodexSocketMaxPayloadMiB,
    env: () => ({
      ...process.env,
      LARK_AGENT_RUNTIME_URL: config.larkAgentRuntimeUrl,
      LARK_AGENT_RUNTIME_TOKEN: config.larkAgentRuntimeToken,
      LARK_AGENT_MCP_TOKEN: config.larkAgentMcpToken
    })
  }
);

// History/readback can itself exceed the receive limit. Keep it off the
// connection that owns live notifications and approval responses.
const socketReadback = new CodexAppServerClient(() => config.workspaceRoot || process.cwd(), {
  socketPath: () => larkCodexSocket,
  socketMaxPayloadMiB: () => larkCodexSocketMaxPayloadMiB
});
socketReadback.onRequest(() => true);

export function requestLarkCodexSocketReadback(method: string, params: Record<string, unknown>, timeoutMs = 4_000): Promise<unknown> {
  if (!larkCodexSocket || !["thread/read", "thread/turns/list", "thread/items/list"].includes(method)) {
    throw new Error("Unsupported Codex socket readback request");
  }
  return socketReadback.request(method, params, timeoutMs);
}

export function stopLarkCodexSocketReadback(): void { socketReadback.stop(); }

const activeTurnIds = new Set<string>();

export function registerCodexAppServerTurn(turnId: string): void {
  activeTurnIds.add(turnId);
}

export function unregisterCodexAppServerTurn(turnId: string): void {
  activeTurnIds.delete(turnId);
}

export function codexAppServerActiveTurnCount(): number {
  return activeTurnIds.size;
}

export function isCodexAppServerTurnRegistered(turnId: string): boolean {
  return activeTurnIds.has(turnId);
}
