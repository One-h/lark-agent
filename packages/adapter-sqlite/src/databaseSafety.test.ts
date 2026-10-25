import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertLarkAgentTestDatabaseIsolation, SqliteAgentStore } from "./index.js";

test("SQLite test stores are isolated from persistent runtime data", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lark-agent-database-safety-"));
  const file = path.join(root, "test.sqlite");
  try {
    assert.doesNotThrow(() => assertLarkAgentTestDatabaseIsolation(file));
    const store = new SqliteAgentStore(file);
    store.close();
    assert.throws(
      () => assertLarkAgentTestDatabaseIsolation(path.resolve("data", "lark-agent.sqlite")),
      /Refusing to open a non-isolated Lark Agent database/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
