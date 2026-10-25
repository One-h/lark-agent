import assert from "node:assert/strict";
import test from "node:test";
import { isLarkModelCapacityError, larkCapacityRetryDelayMs } from "./capacityRecovery.js";

test("capacity recovery distinguishes overload from quota, auth and tool failures", () => {
  assert.equal(isLarkModelCapacityError({ codexErrorInfo: "serverOverloaded", message: "busy" }), true);
  assert.equal(isLarkModelCapacityError({ codexErrorInfo: { type: "serverOverloaded" } }), true);
  assert.equal(isLarkModelCapacityError({ message: "Selected model is at capacity. Please try a different model." }), true);
  for (const error of [
    { codexErrorInfo: "UsageLimitExceeded", message: "Selected model is at capacity" },
    { codexErrorInfo: "Unauthorized", message: "401 token_revoked" },
    { message: "database capacity exceeded" },
    { message: "Codex app-server request timed out: turn/start" }
  ]) assert.equal(isLarkModelCapacityError(error), false);
});

test("capacity retry is bounded to three jittered waits", () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => larkCapacityRetryDelayMs(attempt, () => 0.5)), [30_000, 60_000, 120_000, null]);
  assert.equal(larkCapacityRetryDelayMs(1, () => 0), 24_000);
  assert.equal(larkCapacityRetryDelayMs(3, () => 1), 144_000);
  assert.equal(larkCapacityRetryDelayMs(0), null);
});
