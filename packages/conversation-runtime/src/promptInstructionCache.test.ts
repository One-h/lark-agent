import assert from "node:assert/strict";
import test from "node:test";
import { PromptInstructionCache } from "./promptInstructionCache.js";

test("stable instructions are reused only after native acceptance and never across threads", () => {
  const cache = new PromptInstructionCache();
  assert.equal(cache.prepare("a", "v1").included, true);
  const accepted = cache.prepare("a", "v1");
  assert.equal(accepted.included, true);
  cache.accept(accepted);
  assert.equal(cache.prepare("a", "v1").included, false);
  assert.equal(cache.prepare("b", "v1").included, true);
  assert.equal(cache.prepare("a", "v2").included, true);
  assert.equal(cache.prepare("a", "v2").included, true);
  cache.accept(cache.prepare("a", "v2"));
  assert.equal(cache.prepare("a", "v2").included, false);
  assert.equal(cache.prepare("a", "v2", true).included, true);
});

test("compaction, reset and bounded eviction cannot restore stale instruction marks", () => {
  const cache = new PromptInstructionCache(2);
  const beforeCompaction = cache.prepare("a", "v1");
  cache.invalidate("a");
  cache.accept(beforeCompaction);
  assert.equal(cache.prepare("a", "v1").included, true);
  cache.accept(cache.prepare("a", "v1"));
  const beforeReset = cache.prepare("a", "v2");
  cache.clear();
  cache.accept(beforeReset);
  assert.equal(cache.prepare("a", "v2").included, true);
  cache.accept(cache.prepare("a", "v2"));
  cache.prepare("b", "v1");
  cache.prepare("c", "v1");
  assert.equal(cache.prepare("a", "v2").included, true);
});
