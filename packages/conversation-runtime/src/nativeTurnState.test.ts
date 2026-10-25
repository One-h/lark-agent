import assert from "node:assert/strict";
import test from "node:test";
import { readNativeTurnState } from "./nativeTurnState.js";
import { isLarkModelCapacityError } from "./capacityRecovery.js";

test("native startup state requires the exact turn and active runtime, not merely a responding server", async () => {
  for (const threadStatus of ["active", "idle", "notLoaded", "systemError", undefined]) {
    const calls: Array<{method: string; params: unknown}> = [];
    const result = await readNativeTurnState(async (method, params) => {
      calls.push({method, params});
      return method === "thread/read" ? {thread: {id: "thread", status: {type: threadStatus}}}
        : {data: [{id: "other-turn", status: "failed"}, {id: "target", status: "inProgress"}]};
    }, "thread", "target");
    assert.equal(result.status, threadStatus === "active" ? "active" : "unknown");
    assert.deepEqual(calls, [
      {method: "thread/read", params: {threadId: "thread"}},
      {method: "thread/turns/list", params: {threadId: "thread", limit: 10, sortDirection: "desc", itemsView: "summary"}}
    ]);
  }
});

test("native startup readback retains structured capacity errors for the existing recovery policy", async () => {
  for (const codexErrorInfo of ["serverOverloaded", {type: "serverOverloaded"}]) {
    const result = await readNativeTurnState(async method => method === "thread/read"
      ? {thread: {id: "thread", status: {type: "idle"}}}
      : {data: [{id: "target", status: "failed", error: {message: "opaque upstream failure", additionalDetails: "details", codexErrorInfo}}]}, "thread", "target");
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, {message: "opaque upstream failure", additionalDetails: "details", codexErrorInfo});
    assert.equal(isLarkModelCapacityError(result.error!), true);
  }
});

test("native startup state preserves confirmed terminal outcomes and final items", async () => {
  const item = {id: "reply", type: "agentMessage", phase: "final_answer", text: "done"};
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const result = await readNativeTurnState(async method => method === "thread/read"
      ? {thread: {id: "thread", status: {type: "idle"}}}
      : {data: [{id: "target", status, error: {message: "native failure"}, items: [null, item]}]}, "thread", "target");
    assert.equal(result.status, status);
    assert.equal(result.error?.message, "native failure");
    assert.deepEqual(result.items, [item]);
  }
});

test("missing, malformed, foreign and unknown native state cannot justify interrupting a turn", async () => {
  for (const page of [null, {}, {data: {}}, {data: []}, {data: [null]}, {data: [{id: "other", status: "completed"}]}, {data: [{id: "target", status: "new-status"}]}]) {
    const result = await readNativeTurnState(async method => method === "thread/read"
      ? {thread: {id: "thread", status: {type: "active"}}} : page, "thread", "target");
    assert.equal(result.status, "unknown");
  }
  for (const thread of [null, {}, {id: "other", status: {type: "active"}}]) {
    let count = 0;
    const result = await readNativeTurnState(async () => { count++; return {thread}; }, "thread", "target");
    assert.equal(result.status, "unknown");
    assert.equal(count, 1);
  }
});
