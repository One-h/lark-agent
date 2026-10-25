import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureLarkExecutionConfig, parseLarkExecutionConfigs, recordLarkExecutionConfig } from "./executionConfig.js";
import { composeConversationStyle } from "./persona.js";

test("accepted parameters are frozen without copying prompts, tools or credentials", () => {
  const style = composeConversationStyle({mode: "custom", name: "角色", instructions: "private persona instructions", version: 2, updatedAt: null}, "private global instructions");
  const parameters = {model: "model-a", effort: "high", approvalPolicy: "on-request", cwd: "/workspace/a", input: [{text: "private user input"}], token: "fixture-secret"};
  const snapshot = captureLarkExecutionConfig({threadId: "thread", turnId: "turn", parameters,
    threadParameters: {sandbox: "read-only"}, trustedSender: false, style});
  parameters.model = "model-b"; parameters.effort = "low"; style.persona.version = 99;
  assert.equal(snapshot.model, "model-a"); assert.equal(snapshot.reasoningEffort, "high");
  assert.equal(snapshot.workspaceRoot, "/workspace/a"); assert.equal(snapshot.sandbox, "read-only");
  assert.equal(snapshot.persona.version, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|fixture-secret|instructions|input/);
});

test("missing thread defaults remain unknown instead of being inferred from trust or current settings", () => {
  const snapshot = captureLarkExecutionConfig({threadId: "thread", turnId: "turn", parameters: {}, trustedSender: true,
    style: composeConversationStyle({mode: "default", name: "", instructions: "", version: 0, updatedAt: null}, "global")});
  for (const key of ["model", "reasoningEffort", "approvalPolicy", "sandbox", "workspaceRoot"] as const) assert.equal(snapshot[key], null);
  assert.equal(snapshot.trustScope, "trusted");
});

test("metadata appends every accepted turn and ignores malformed historical artifacts without defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-execution-snapshot-"));
  try {
    const snapshot = captureLarkExecutionConfig({threadId: "thread", turnId: "first", parameters: {model: "a"}, trustedSender: false,
      style: composeConversationStyle({mode: "default", name: "", instructions: "", version: 0, updatedAt: null}, "global")});
    recordLarkExecutionConfig(root, snapshot);
    recordLarkExecutionConfig(root, {...snapshot, turnId: "recovery", model: "b"});
    const text = fs.readFileSync(path.join(root, "execution-configs.jsonl"), "utf8");
    const result = parseLarkExecutionConfigs(text + "{broken\n" + JSON.stringify({configuredModel: "current", persona: {version: 3}}));
    assert.deepEqual(result.map(item => [item.turnId, item.model]), [["first", "a"], ["recovery", "b"]]);
    assert.deepEqual(parseLarkExecutionConfigs(null), []);
    const projected = parseLarkExecutionConfigs(JSON.stringify({...snapshot, apiKey: "fixture-secret", persona: {...snapshot.persona, instructions: "private"}}));
    assert.doesNotMatch(JSON.stringify(projected), /fixture-secret|private/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
