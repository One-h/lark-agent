import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./index.js";

test("capability registration and both invoke paths require a nonempty valid runtime token", async () => {
  for (const token of [undefined, "test-runtime-token"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-capability-security-"));
    const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: [], runtimeToken: token });
    try {
      const capability = { id: "host.demo", title: "Demo", description: "fixture", inputSchema: {}, risk: "read" };
      for (const url of ["/v1/capabilities/register", "/v1/capabilities/host.demo/invoke", "/v1/internal/capabilities/host.demo/execute"]) {
        for (const headers of [{}, { authorization: "Bearer wrong-token" }]) {
          const denied = await runtime.app.inject({ method: "POST", url, headers, payload: { capabilities: [capability], input: {}, context: {} } });
          assert.equal(denied.statusCode, 401);
        }
      }
      assert.equal(runtime.store.db.prepare("SELECT 1 FROM capabilities WHERE id='host.demo'").get(), undefined);
      if (token) {
        const headers = { authorization: `Bearer ${token}` };
        assert.equal((await runtime.app.inject({ method: "POST", url: "/v1/capabilities/register", headers, payload: { capabilities: [capability] } })).statusCode, 200);
        const reserved = { ...capability, id: "lark.message.send", risk: "read" };
        const invalid = await runtime.app.inject({ method: "POST", url: "/v1/capabilities/register", headers, payload: { capabilities: [{ ...capability, id: "host.not-inserted" }, reserved] } });
        assert.equal(invalid.statusCode, 400);
        assert.equal(runtime.store.db.prepare("SELECT 1 FROM capabilities WHERE id='host.not-inserted'").get(), undefined);
        assert.deepEqual(runtime.store.db.prepare("SELECT risk FROM capabilities WHERE id='lark.message.send'").get(), { risk: "external-write" });
      }
    } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
