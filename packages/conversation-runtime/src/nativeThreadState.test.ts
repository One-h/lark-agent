import assert from "node:assert/strict";
import test from "node:test";
import { isNativeThreadArchived, isNativeThreadLoaded, isNativeThreadMissingError, nativeThreadArchiveSafety, nativeThreadNeedsUnarchive } from "./nativeThreadState.js";

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

test("archive safety requires an idle native thread and a confirmed latest terminal turn", async () => {
  for (const threadStatus of ["idle", "notLoaded", "active", "systemError", undefined]) {
    for (const status of ["completed", "failed", "interrupted", "inProgress", "unknown"]) {
      const result = await nativeThreadArchiveSafety(async (method, params) => {
        if (method === "thread/read") return { thread: { id: "wanted", status: { type: threadStatus } } };
        assert.deepEqual(params, { threadId: "wanted", limit: 1, sortDirection: "desc", itemsView: "summary" });
        return { data: [{ id: "newest", status }] };
      }, "wanted");
      assert.equal(result, threadStatus === "active" ? "active"
        : threadStatus !== "idle" && threadStatus !== "notLoaded" ? "unknown"
        : status === "inProgress" ? "active" : status === "unknown" ? "unknown" : "idle");
    }
  }
  for (const page of [null, {}, { data: [] }, { data: [null] }, { data: [{ status: "completed" }] }]) {
    assert.equal(await nativeThreadArchiveSafety(async method => method === "thread/read"
      ? { thread: { id: "wanted", status: { type: "idle" } } } : page, "wanted"), "unknown");
  }
  assert.equal(await nativeThreadArchiveSafety(async () => ({ thread: { id: "foreign", status: { type: "idle" } } }), "wanted"), "unknown");
  await assert.rejects(nativeThreadArchiveSafety(async () => { throw new Error("offline"); }, "wanted"), /offline/);
});

test("native archive reconciliation matches exact IDs across bounded metadata-only pages", async () => {
  const calls: Record<string, unknown>[] = [];
  assert.equal(await isNativeThreadArchived(async (method, params) => {
    assert.equal(method, "thread/list"); calls.push(params);
    return params.cursor ? { data: [{ id: "wanted" }], nextCursor: null } : { data: [{ id: "other" }], nextCursor: "page-2" };
  }, "wanted"), true);
  assert.deepEqual(calls[0], { archived: true, useStateDbOnly: true, sortKey: "updated_at", limit: 100 });
  let count = 0;
  await assert.rejects(isNativeThreadArchived(async () => ({ data: [], nextCursor: `page-${++count}` }), "wanted"), /bounded page limit/);
  assert.equal(count, 10);
  for (const page of [null, {}, { data: [null] }, { data: [{ id: "foreign" }], nextCursor: 1 }, { data: [], nextCursor: "loop" }]) {
    await assert.rejects(isNativeThreadArchived(async () => page, "wanted"), /Invalid Codex archived-thread list/);
  }
  assert.equal(await isNativeThreadArchived(async () => ({ data: [{ id: "foreign" }], nextCursor: null }), "wanted"), false);
});

test("loaded active reuse never scans the archive list, while restore requires exact archived membership", async () => {
  assert.equal(await nativeThreadNeedsUnarchive(async (_method, params) => {
    assert.equal(params.archived, false);
    assert.equal("sourceKinds" in params, false);
    return { data: [{ id: "wanted", source: "vscode" }], nextCursor: null };
  }, "wanted"), false);
  assert.equal(await nativeThreadNeedsUnarchive(async (_method, params) => ({ data: params.archived ? [{ id: "wanted" }] : [], nextCursor: null }), "wanted"), true);
  await assert.rejects(nativeThreadNeedsUnarchive(async () => ({ data: [], nextCursor: null }), "wanted"), /missing from native thread metadata/);
});
