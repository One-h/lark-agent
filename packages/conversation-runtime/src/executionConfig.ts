import fs from "node:fs";
import path from "node:path";
import type { ConversationStyle } from "./persona.js";

export type LarkExecutionConfig = {
  schemaVersion: 1;
  recordedAt: string;
  threadId: string;
  turnId: string;
  action: "turn/start" | "turn/steer";
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string | null;
  sandbox: string | null;
  workspaceRoot: string | null;
  trustScope: "trusted" | "untrusted";
  persona: { mode: "default" | "custom"; name: string; version: number; updatedAt: string | null };
  globalPromptHash: string;
  source: "accepted-request";
};

const stringOrNull = (value: unknown): string | null => typeof value === "string" && value ? value : null;

export function captureLarkExecutionConfig(input: {
  threadId: string; turnId: string; parameters: Record<string, unknown>;
  threadParameters?: Record<string, unknown>; trustedSender: boolean; style: ConversationStyle;
}): LarkExecutionConfig {
  const params = input.parameters;
  const defaults = input.threadParameters ?? {};
  return {
    schemaVersion: 1, recordedAt: new Date().toISOString(), threadId: input.threadId, turnId: input.turnId,
    action: "turn/start", model: stringOrNull(params.model ?? defaults.model),
    reasoningEffort: stringOrNull(params.effort ?? (defaults.config as Record<string, unknown> | undefined)?.model_reasoning_effort),
    approvalPolicy: stringOrNull(params.approvalPolicy ?? defaults.approvalPolicy),
    sandbox: stringOrNull(defaults.sandbox), workspaceRoot: stringOrNull(params.cwd ?? defaults.cwd),
    trustScope: input.trustedSender ? "trusted" : "untrusted",
    persona: { mode: input.style.persona.mode, name: input.style.persona.name, version: input.style.persona.version, updatedAt: input.style.persona.updatedAt },
    globalPromptHash: input.style.globalPromptHash, source: "accepted-request"
  };
}

export function recordLarkExecutionConfig(taskDir: string, snapshot: LarkExecutionConfig): void {
  fs.appendFileSync(path.join(taskDir, "execution-configs.jsonl"), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

export function parseLarkExecutionConfigs(text: string | null | undefined): LarkExecutionConfig[] {
  if (!text) return [];
  return text.split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line);
      if (!row || row.schemaVersion !== 1 || row.source !== "accepted-request"
        || !["turn/start", "turn/steer"].includes(row.action)
        || typeof row.threadId !== "string" || typeof row.turnId !== "string" || typeof row.recordedAt !== "string"
        || !["trusted", "untrusted"].includes(row.trustScope)
        || !row.persona || !["default", "custom"].includes(row.persona.mode)
        || typeof row.persona.name !== "string" || !Number.isSafeInteger(row.persona.version) || row.persona.version < 0
        || typeof row.globalPromptHash !== "string") return [];
      // Project known metadata only; raw inputs, instructions and secrets are never returned.
      return [{
        schemaVersion: 1, source: "accepted-request", recordedAt: row.recordedAt,
        threadId: row.threadId, turnId: row.turnId, action: row.action,
        model: stringOrNull(row.model), reasoningEffort: stringOrNull(row.reasoningEffort),
        approvalPolicy: stringOrNull(row.approvalPolicy), sandbox: stringOrNull(row.sandbox),
        workspaceRoot: stringOrNull(row.workspaceRoot), trustScope: row.trustScope,
        persona: { mode: row.persona.mode, name: row.persona.name, version: row.persona.version, updatedAt: stringOrNull(row.persona.updatedAt) },
        globalPromptHash: row.globalPromptHash
      } as LarkExecutionConfig];
    } catch { return []; }
  });
}
