import assert from "node:assert/strict";
import test from "node:test";
import { onLarkTurnObservation, publishLarkTurnObservation, type LarkTurnObservation } from "./turnObservations.js";

const identity = { runId: "run", turnId: "turn", threadId: "thread", sourceMessageId: 1 };
const progress = { ...identity, kind: "turn.progress", progressKey: "step", summary: "Reading fixture" } as const;
const finished = { ...identity, kind: "turn.finished", outcome: "completed" } as const;

test("turn observers receive ordered immutable snapshots without waiting for each other", async () => {
  const scope = {};
  const received: LarkTurnObservation[] = [], failed: string[] = [];
  let timedOut: AbortSignal | undefined;
  const throwing = onLarkTurnObservation(scope, event => {
    failed.push(event.kind);
    throw new Error("fixture failure");
  });
  const slow = onLarkTurnObservation(scope, (_event, signal) => {
    timedOut = signal;
    return new Promise<void>(() => {});
  }, { timeoutMs: 25 });
  const independent = onLarkTurnObservation(scope, event => { received.push(event); });
  let otherCalls = 0;
  const otherScope = onLarkTurnObservation({}, () => { otherCalls++; });
  try {
    const mutable = { ...progress, summary: "original" };
    publishLarkTurnObservation(scope, mutable);
    mutable.summary = "changed";
    publishLarkTurnObservation(scope, finished);
    assert.deepEqual(received, [], "publication must not call inline");
    await independent.drain();
    assert.equal(timedOut?.aborted, false, "the independent observer cannot wait for the slow one");
    assert.deepEqual(received, [{ ...progress, summary: "original" }, finished]);
    assert(received.every(Object.isFrozen));
    await throwing.drain();
    assert.deepEqual(failed, ["turn.progress", "turn.finished"]);
    await slow.drain();
    assert.equal(timedOut?.aborted, true);
    const originalSignal = timedOut;
    publishLarkTurnObservation(scope, finished);
    await independent.drain();
    assert.equal(timedOut, originalSignal, "a timed-out observer must not accumulate new work");
    assert.equal(received.length, 3);
    assert.equal(otherCalls, 0);
  } finally {
    for (const subscription of [throwing, slow, independent, otherScope]) subscription.close();
  }
});

test("a burst of progress leaves room for the terminal event on the same queue", async () => {
  const scope = {};
  const observed: string[] = [];
  const subscription = onLarkTurnObservation(scope, event => { observed.push(event.kind); });
  try {
    for (let i = 0; i < 150; i++) publishLarkTurnObservation(scope, { ...progress, progressKey: String(i) });
    publishLarkTurnObservation(scope, finished);
    await subscription.drain();
    assert.equal(observed.at(-1), "turn.finished");
    assert.equal(observed.filter(kind => kind === "turn.finished").length, 1);
    assert(observed.length < 150);
  } finally { subscription.close(); }
});
