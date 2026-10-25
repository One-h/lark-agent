import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type DependencyHealth = { ok: boolean; checkedAt: string; version?: string; error?: string };

// Run the same executable and inherited environment used by real outbound sends.
// A living parent process is not proof that a fresh child can load its libraries.
export function createLarkCliProbe(ttlMs = 10_000) {
  let cached: DependencyHealth | undefined;
  let pending: Promise<DependencyHealth> | undefined;
  return async (): Promise<DependencyHealth> => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < ttlMs) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const { stdout } = await execute("lark-cli", ["--version"], { timeout: 2000, maxBuffer: 8192, env: process.env });
        return { ok: true, checkedAt: new Date().toISOString(), version: stdout.trim().slice(0, 160) };
      } catch (error) {
        const failure = error as Error & { stderr?: string };
        return { ok: false, checkedAt: new Date().toISOString(), error: (failure.stderr || failure.message).trim().slice(0, 1200) };
      }
    })();
    try { cached = await pending; return cached; }
    finally { pending = undefined; }
  };
}

export function createLarkAuthProbe(ttlMs = 60_000) {
  let cached: DependencyHealth | undefined;
  let pending: Promise<DependencyHealth> | undefined;
  return async (): Promise<DependencyHealth> => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < ttlMs) return cached;
    if (pending) return pending;
    pending = (async () => {
      const checkedAt = new Date().toISOString();
      try {
        const { stdout } = await execute("lark-cli", ["auth", "status", "--json", "--verify"], {
          timeout: 8000, maxBuffer: 128 * 1024,
          env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" }
        });
        const result = JSON.parse(stdout) as { verified?: boolean; identities?: { bot?: { openId?: string; verified?: boolean; available?: boolean } } };
        const bot = result.identities?.bot;
        if (result.verified !== true || bot?.verified !== true || bot.available !== true || !/^ou_[A-Za-z0-9]+$/.test(bot.openId ?? "")) {
          throw new Error("Bot authorization is not verified");
        }
        return { ok: true, checkedAt };
      } catch {
        // Never expose raw auth output, tokens, or credentials through health routes.
        return { ok: false, checkedAt, error: "Bot authorization could not be verified (missing login, network failure, or timeout)" };
      }
    })();
    try { cached = await pending; return cached; }
    finally { pending = undefined; }
  };
}
