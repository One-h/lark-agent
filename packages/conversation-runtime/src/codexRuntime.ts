import { CodexAppServerClient } from "@lark-agent/adapter-codex-app-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./context.js";

// All Lark conversations share one App Server and the user's default CODEX_HOME,
// so their threads stay visible in the desktop app.
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function larkStickerMcpCodexConfig(): string[] {
  const tsx = path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const server = path.join(sourceRoot, "packages", "mcp-stickers", "src", "index.ts");
  return [
    `mcp_servers.lark_stickers.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.lark_stickers.args=${JSON.stringify([tsx, server])}`,
    'mcp_servers.lark_stickers.env_vars=["LARK_AGENT_RUNTIME_URL","LARK_AGENT_RUNTIME_TOKEN"]',
    "mcp_servers.lark_stickers.startup_timeout_sec=10",
    "mcp_servers.lark_stickers.tool_timeout_sec=30"
  ];
}

export const codexAppServer = new CodexAppServerClient(
  () => config.workspaceRoot || process.cwd(),
  {
    config: larkStickerMcpCodexConfig,
    env: () => ({
      ...process.env,
      LARK_AGENT_RUNTIME_URL: config.larkAgentRuntimeUrl,
      LARK_AGENT_RUNTIME_TOKEN: config.larkAgentRuntimeToken
    })
  }
);

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
