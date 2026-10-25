import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createRuntime } from "./index.js";

test("event consumers inherit the exact pinned CLI used for outbound sends", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-listener-env-"));
  const previousPath = process.env.PATH;
  const probes: Array<Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>> = [];
  fs.writeFileSync(path.join(root, "lark-cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const originalSpawn = childProcess.spawn;
  const spawnWithOptions = originalSpawn as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  // Preserve the real shell/environment, but only resolve its executable.
  // The test must never subscribe to real Feishu events or load real auth.
  childProcess.spawn = ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    if (command === "sh" && Array.isArray(args) && String(args[1]).includes("lark-cli event consume")) {
      const startedAt = performance.now();
      const child = spawnWithOptions(command, [String(args[0]), "command -v lark-cli"], options);
      assert(child.stdout, "listener probe must expose stdout");
      probes.push(new Promise((resolve, reject) => {
        let stdout = ""; let stderr = ""; let stdoutEnded = false; let closed = false;
        let code: number | null = null; let signal: NodeJS.Signals | null = null;
        const timer = setTimeout(() => reject(new Error(`Listener probe timed out after 5000ms (closed=${closed}, stdoutEnded=${stdoutEnded}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`)), 5_000);
        const complete = () => {
          if (!closed || !stdoutEnded) return;
          clearTimeout(timer);
          resolve({ stdout, stderr, code, signal, elapsedMs: performance.now() - startedAt });
        };
        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.stdout!.once("end", () => { stdoutEnded = true; complete(); });
        child.once("close", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; closed = true; complete(); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
      }));
      return child;
    }
    return spawnWithOptions(command, args, options);
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  try {
    runtime.startListener();
    assert.equal(probes.length, 2, "message and approval consumers must both be intercepted");
    const completed = await Promise.all(probes);
    for (const [index, result] of completed.entries()) {
      t.diagnostic(`listener probe ${index + 1}: close=${result.code}, stdout complete after ${Math.round(result.elapsedMs)}ms`);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
    }
    assert.deepEqual(completed.map(result => result.stdout.trim()), [path.join(root, "lark-cli"), path.join(root, "lark-cli")]);
  } finally {
    runtime.stop(); await runtime.app.close();
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
