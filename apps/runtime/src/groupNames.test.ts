import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import { createGroupNameCache } from "./groupNames.js";

test("group names refresh asynchronously, persist and retain names on lookup failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lark-group-names-"));
  const store = new SqliteAgentStore(path.join(root, "test.sqlite"));
  let now = Date.now();
  let calls = 0;
  let fail = false;
  const lookup = async () => { calls++; if (fail) throw new Error("unavailable"); return "产品讨论群"; };
  const cache = createGroupNameCache(store, lookup, () => now);
  try {
    store.db.prepare("INSERT INTO lark_messages (chat_id,chat_type,raw_json,received_at,created_at) VALUES ('oc_group','group','{}',?,?)").run(new Date(now).toISOString(), new Date(now).toISOString());
    assert.equal(cache.refresh(), true);
    assert.equal(cache.refresh(), true);
    await cache.wait();
    assert.equal(calls, 1);
    assert.equal(store.setting("lark.chat.name:oc_group", ""), "产品讨论群");
    assert.equal(cache.refresh(), false);
    const restarted = createGroupNameCache(store, lookup, () => now);
    assert.equal(restarted.refresh(), false);
    restarted.stop();
    now += 3600001;
    fail = true;
    cache.refresh();
    await cache.wait();
    assert.equal(calls, 2);
    assert.equal(store.setting("lark.chat.name:oc_group", ""), "产品讨论群");
    assert.equal(cache.refresh(), false);
    now += 300001;
    fail = false;
    cache.refresh();
    await cache.wait();
    assert.equal(calls, 3);
  } finally { cache.stop(); await cache.wait(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
