import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wholeTurnScope } from "./wholeTurnScope.js";
import type { TurnApprovalInput } from "./turnAutoApproval.js";

test("managed observability reuse keeps exact source, service, namespace and safe query controls", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lark-observe-scope-"));
  const relative = ".agents/skills/grafana-observability/scripts/grafana_observe.py";
  fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relative), "");
  try {
    const shell = (text: string) => `/bin/zsh -lc ${JSON.stringify(text)}`;
    const base: TurnApprovalInput = { messageId: 1, turnId: "fixture-turn", senderId: "ou_sender", originalMessage: "检查示例服务的生产日志",
      operationKind: "command", cwd, operation: "" };
    const logs = (service: string, filter: string, source = "fixture", ns = "prod", limit = 30) =>
      `python3 ${relative} --insecure logs --uid ${source} --query '{namespace="${ns}",app="${service}"} ${filter}' --since 8m --limit ${limit}`;
    const filters = ["|= \"error\"", "|~ \"500|timeout\""];
    const allows = wholeTurnScope({ ...base, operation: shell(logs("demo-api", filters[0])) }, undefined, true);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[1], "fixture", "prod", 90) }), true);
    assert.equal(allows({ ...base, operation: logs("demo-worker", filters[1]) }), false);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[1], "other-source") }), false);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[1], "fixture", "staging") }), false);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[1], "fixture", "prod", 200) }), false);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[0] + ' or {app="another"}') }), false);
    assert.equal(allows({ ...base, operation: logs("demo-api", filters[0]) + " && echo out-of-scope" }), false);
    const prom = (name: string, range: string) => `python3 ${relative} prom --query 'increase(req{app="${name}"}[${range}])'`;
    const metrics = wholeTurnScope({ ...base, operation: prom("demo[10m]", "2m") }, undefined, true);
    assert.equal(metrics({ ...base, operation: prom("demo[10m]", "3m") }), true);
    assert.equal(metrics({ ...base, operation: prom("demo[11m]", "3m") }), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
