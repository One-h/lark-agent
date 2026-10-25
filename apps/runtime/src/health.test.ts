import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./index.js";

test("health is unavailable when the CLI cannot start even though the server is alive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-health-"));
  const previousPath = process.env.PATH;
  fs.writeFileSync(path.join(root, "lark-cli"), "#!/bin/sh\necho 'dyld: Library not loaded: libsimdjson.33.dylib' >&2\nexit 134\n", { mode: 0o755 });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  try {
    const response = await runtime.app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().ok, false);
    assert.equal(response.json().dependencies.larkCli.ok, false);
    assert.match(response.json().dependencies.larkCli.error, /simdjson/);
  } finally {
    await runtime.app.close(); runtime.stop();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readiness rejects an unverified bot even when CLI execution succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-readiness-"));
  const previousPath = process.env.PATH;
  fs.writeFileSync(path.join(root, "lark-cli"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "lark-cli version test"; else echo \'{"verified":false,"identities":{"bot":{"openId":"ou_test"}}}\'; fi\n', { mode: 0o755 });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  const runtime = createRuntime({ databasePath: path.join(root, "runtime.sqlite"), mode: "shadow", trustedSenderIds: [] });
  try {
    const response = await runtime.app.inject({ method: "GET", url: "/v1/readiness" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().ok, false);
    assert.equal(response.json().dependencies.larkAuth.ok, false);
    assert.doesNotMatch(response.body, /access_token|refresh_token|client_secret/);
  } finally {
    await runtime.app.close(); runtime.stop();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
