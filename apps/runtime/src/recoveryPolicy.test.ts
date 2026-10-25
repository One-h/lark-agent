import assert from "node:assert/strict";
import test from "node:test";
import { RecoveryPolicy } from "./recoveryPolicy.js";

test("recovery only restarts confirmed idle failures and is bounded to three starts per hour", () => {
  const guard = new RecoveryPolicy();
  for (let i = 0; i < 5; i++) assert.equal(guard.observe({ ok: false, activeTurns: 1 }, 100_000 + i), false);
  assert.equal(guard.observe(null, 110_000), false, "unknown active-turn state must not be killed");
  assert.equal(guard.observe({ ok: true, activeTurns: 0 }, 120_000), false);
  assert.equal(guard.observe({ ok: false, activeTurns: 0 }, 130_000), false);
  assert.equal(guard.observe({ ok: false, activeTurns: 0 }, 140_000), false);
  assert.equal(guard.observe({ ok: false, activeTurns: 0 }, 150_000), true);
  assert.equal(guard.reserveStart(160_000), false, "no rapid restart loop");
  assert.equal(guard.reserveStart(220_000), true);
  assert.equal(guard.reserveStart(290_000), true);
  assert.equal(guard.reserveStart(360_000), false, "restart budget must be exhausted");
  assert.equal(guard.reserveStart(4_000_000), true, "budget recovers after an hour");
});

test("restart budget survives a supervisor restart", () => {
  const guard = new RecoveryPolicy();
  assert.equal(guard.reserveStart(100_000), true);
  assert.equal(guard.reserveStart(200_000), true);
  assert.equal(guard.reserveStart(300_000), true);
  const resumed = new RecoveryPolicy(guard.snapshot());
  assert.equal(resumed.reserveStart(400_000), false);
  assert.equal(resumed.reserveStart(4_000_000), true);
});
