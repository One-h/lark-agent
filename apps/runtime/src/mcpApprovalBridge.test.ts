import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { McpApprovalBridge, mcpApprovalKey } from "./mcpApprovalBridge.js";

test("MCP handoff keeps input values and types in the approval key", () => {
  const key = (input: unknown) => mcpApprovalKey("fixture", "fixture_tool", input);
  assert.equal(key({ b: 2, a: 1 }), key({ a: 1, b: 2 }));
  assert.notEqual(key({ a: 1 }), key('{"a":1}'));
  assert.notEqual(key(null), key({}));
});

test("MCP handoff does not execute if its turn is aborted after approval", async () => {
  const bridge = new McpApprovalBridge();
  const request = new AbortController(), turn = new AbortController();
  let writes = 0;
  assert.equal(await bridge.prepare("fixture", request.signal, async (lifetime, before) => {
    const signal = AbortSignal.any([lifetime, turn.signal]);
    await before(signal);
    signal.throwIfAborted();
    return ++writes;
  }), true);
  assert.equal(writes, 0);
  turn.abort();
  await setImmediate();
  assert.equal(bridge.take("fixture", request.signal), undefined);
  assert.equal(writes, 0);
});
