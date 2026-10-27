import assert from "node:assert/strict";
import test from "node:test";
import { isNativeThreadLoaded, isNativeThreadMissingError } from "./nativeThreadState.js";

test("loaded-thread checks follow native pages and do not retain presence between calls", async () => {
  const calls: unknown[] = [];
  let loaded = true;
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return params.cursor ? { data: loaded ? ["wanted"] : [], nextCursor: null } : { data: ["other"], nextCursor: "page-2" };
  };
  assert.equal(await isNativeThreadLoaded(request, "wanted"), true);
  loaded = false;
  assert.equal(await isNativeThreadLoaded(request, "wanted"), false);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1], { method: "thread/loaded/list", params: { limit: 100, cursor: "page-2" } });
});

test("unknown native state never masquerades as an unloaded thread", async () => {
  await assert.rejects(isNativeThreadLoaded(async () => { throw new Error("RPC timed out"); }, "wanted"), /RPC timed out/);
  for (const response of [null, {}, { data: [1] }, { data: [], nextCursor: 1 }, { data: [], nextCursor: "" }]) {
    await assert.rejects(isNativeThreadLoaded(async () => response, "wanted"), /Invalid Codex loaded-thread list/);
  }
  await assert.rejects(isNativeThreadLoaded(async () => ({ data: [], nextCursor: "loop" }), "wanted"), /cursor/);
});

test("only an explicit missing-thread rejection for the requested thread allows a retry", () => {
  assert.equal(isNativeThreadMissingError(new Error("thread not found: wanted"), "wanted"), true);
  for (const error of [new Error("thread not found: other"), new Error("thread not found: WANTED"), new Error("request timed out: turn/start"), new Error("Connection reset by peer"), new Error("thread wanted already has an active writer"), "thread not found: wanted"]) {
    assert.equal(isNativeThreadMissingError(error, "wanted"), false);
  }
});
