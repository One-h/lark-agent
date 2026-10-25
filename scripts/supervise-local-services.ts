import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { RecoveryPolicy, type RecoverySample } from "../apps/runtime/src/recoveryPolicy.js";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmux = process.env.TMUX_EXECUTABLE || "tmux";
const forgeRoot = process.env.LARK_AGENT_FORGE_ROOT
  ? path.resolve(process.env.LARK_AGENT_FORGE_ROOT)
  : ["agent-forge", "autofix-console"].map(name => path.resolve(root, "..", name)).find(directory => existsSync(path.join(directory, "package.json")));
async function checkoutSession(directory: string | undefined, fallback: string): Promise<string> {
  if (!directory) return fallback;
  try {
    const { stdout } = await execute(tmux, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"], { timeout: 3000 });
    return stdout.split("\n").map(line => line.split("\t")).find(([, cwd]) => cwd === directory)?.[0] || fallback;
  } catch { return fallback; }
}
const runtimeSession = process.env.LARK_AGENT_TMUX_SESSION || await checkoutSession(root, "lark-agent-runtime");
const forgeSession = process.env.AGENT_FORGE_TMUX_SESSION || await checkoutSession(forgeRoot, "agent-forge-dev");
const budgetPath = path.join(root, "data/local/recovery-budget.json");
function loadBudget(): number[] {
  try {
    const value: unknown = JSON.parse(readFileSync(budgetPath, "utf8"));
    if (!Array.isArray(value) || !value.every(start => typeof start === "number" && Number.isFinite(start) && start >= 0)) throw new Error("Invalid recovery budget; manual inspection required");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
const policy = new RecoveryPolicy(loadBudget());
function saveBudget(): void {
  writeFileSync(`${budgetPath}.tmp`, JSON.stringify(policy.snapshot()), { mode: 0o600 });
  renameSync(`${budgetPath}.tmp`, budgetPath);
}
let reservedRestart = false;
let lastState = "";
type Health = RecoverySample & { pid: number; dependencies?: { larkCli?: { ok: boolean }; larkAuth?: { ok: boolean } } };

const log = (state: string, detail: string) => {
  if (state === lastState) return;
  lastState = state;
  console.log(`${new Date().toISOString()} ${state}: ${detail}`);
};
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function hasSession(session: string): Promise<boolean> {
  try { await execute(tmux, ["has-session", "-t", `=${session}`], { timeout: 3000 }); return true; }
  catch { return false; }
}
async function portPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execute("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeout: 3000 });
    const pid = Number(stdout.trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}
async function startSession(session: string, directory: string, script: string): Promise<void> {
  await execute(tmux, ["new-session", "-d", "-s", session, "-c", directory, `/bin/zsh ${shellQuote(script)}`], { timeout: 5000 });
}
async function getHealth(route: string, timeout: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:4780${route}`, { signal: AbortSignal.timeout(timeout) });
    const value = await response.json() as Partial<Health>;
    if (typeof value.ok !== "boolean" || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.activeTurns) || Number(value.activeTurns) < 0) return null;
    return value as Health;
  } catch { return null; }
}
async function belongsToRuntimeSession(pid: number): Promise<boolean> {
  if (await portPid(4780) !== pid) return false;
  const { stdout } = await execute(tmux, ["display-message", "-p", "-t", `=${runtimeSession}`, "#{pane_pid}"], { timeout: 3000 });
  const panePid = Number(stdout.trim());
  for (let hop = 0; hop < 8 && pid > 1; hop++) {
    if (pid === panePid) return true;
    const parent = await execute("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: 2000 });
    pid = Number(parent.stdout.trim());
  }
  return false;
}

async function tick(): Promise<void> {
  if (!await hasSession(runtimeSession)) {
    if (await portPid(4780)) { log("port-conflict", "Refusing a duplicate runtime on occupied port 4780"); return; }
    if (!reservedRestart && !policy.reserveStart(Date.now())) { log("restart-budget", "Automatic starts are limited to three per hour, at least one minute apart"); return; }
    saveBudget();
    reservedRestart = false;
    await startSession(runtimeSession, root, path.join(root, "data/local/run-runtime.sh"));
    log("starting", "Starting the pinned runtime");
    return;
  }
  const health = await getHealth("/v1/health", 4000);
  if (policy.observe(health, Date.now()) && health && await belongsToRuntimeSession(health.pid)) {
    saveBudget();
    // The process must both report no active turn and belong to our managed pane.
    process.kill(health.pid, "SIGTERM");
    reservedRestart = true;
    log("recovering", "Three failed local probes; gracefully restarting confirmed idle runtime");
    return;
  }
  if (!health) { log("unknown-health", "Runtime health unavailable; no automatic kill while task state is unknown"); return; }
  const readiness = health.ok ? await getHealth("/v1/readiness", 12_000) : null;
  log(readiness?.ok ? "ready" : "degraded", readiness?.ok ? "CLI, bot authorization and listeners verified" : "Runtime is not ready; inspect /v1/health and /v1/readiness (active tasks are protected)");
  // Keep the diagnostic UI available even when a transport dependency is degraded.
  if (forgeRoot && existsSync(path.join(root, "data/local/run-forge.sh")) && !await hasSession(forgeSession) && !await portPid(4731)) {
    await startSession(forgeSession, forgeRoot, path.join(root, "data/local/run-forge.sh"));
  }
}

for (;;) {
  try { await tick(); }
  catch (error) { log("supervisor-error", error instanceof Error ? error.message : "Unknown supervisor failure"); }
  await delay(15_000);
}
