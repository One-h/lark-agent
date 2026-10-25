#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [command = "serve", ...args] = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];

function parseToml(file: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (match) parsed[match[1]] = match[2].replace(/^"|"$/g, "").trim();
  }
  return parsed;
}

function applyConfig(file: string): void {
  const values = parseToml(file);
  const mapping: Record<string, string> = { mode: "LARK_AGENT_MODE", database: "LARK_AGENT_DATABASE", port: "PORT", workspace_root: "LARK_AGENT_WORKSPACE_ROOT", approver_id: "LARK_AGENT_APPROVER_ID", trusted_senders: "LARK_AGENT_TRUSTED_SENDERS", host_url: "LARK_AGENT_HOST_URL", host_token: "LARK_AGENT_HOST_TOKEN", runtime_token: "LARK_AGENT_RUNTIME_TOKEN", listen: "LARK_AGENT_LISTEN" };
  for (const [key, environment] of Object.entries(mapping)) if (values[key] !== undefined && process.env[environment] === undefined) process.env[environment] = values[key].replace(/^\[|\]$/g, "").replaceAll('"', "").replaceAll("'", "").replace(/\s+/g, "");
}

const configPath = value("--config");
const resolvedConfig = configPath ? path.resolve(configPath) : null;
if (resolvedConfig && !fs.existsSync(resolvedConfig)) throw new Error(`Config file not found: ${resolvedConfig}`);
if (resolvedConfig) applyConfig(resolvedConfig);

if (command === "doctor") {
  const commandAvailable = (name: string) => spawnSync("/bin/zsh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).status === 0;
  const database = process.env.LARK_AGENT_DATABASE ?? "./lark-agent.sqlite";
  const workspace = process.env.LARK_AGENT_WORKSPACE_ROOT ?? process.cwd();
  console.log(JSON.stringify({ config: resolvedConfig, node: process.versions.node, codex: commandAvailable("codex"), larkCli: commandAvailable("lark-cli"), workspace: { path: workspace, exists: fs.existsSync(workspace) }, database: path.resolve(database), mode: process.env.LARK_AGENT_MODE ?? "shadow" }, null, 2));
  process.exit(0);
}
if (command === "serve") {
  await import("../../runtime/src/index.ts");
} else {
  console.error("Usage: lark-agent serve --config ./lark-agent.toml | lark-agent doctor --config ./lark-agent.toml");
  process.exit(1);
}
