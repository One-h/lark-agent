import { isLarkReactionEmojiType } from "@lark-agent/adapter-lark-cli";
import { larkCodexReasoningEfforts, larkStickerUsageModes, validLarkCodexModel } from "@lark-agent/conversation-runtime";
import { validateWorkspaceRoot } from "./workspaceConfig.js";

export function strictSettingsObject(value: unknown, fields: readonly string[], label = "settings"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !fields.includes(key));
  if (unknown.length) throw new Error(`Unknown ${label} field: ${unknown.join(", ")}`);
  return body;
}

function booleanValue(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function numberValue(value: unknown, key: string, minimum: number, maximum: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || integer && !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, key: string, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${key} must be one of ${choices.join(", ")}`);
  return value;
}

function modelValue(value: unknown, key: string): string {
  if (typeof value !== "string" || !validLarkCodexModel(value.trim())) throw new Error(`${key} must be a valid model id up to 120 characters`);
  return value.trim();
}

function emojiValue(value: unknown, key: string): string {
  if (typeof value !== "string" || !isLarkReactionEmojiType(value)) throw new Error(`${key} must be a supported Lark emoji type`);
  return value;
}

function idSet(value: unknown, key: string, maximum: number, valid: (id: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every(id => typeof id === "string" && valid(id.trim()))) {
    throw new Error(`${key} must contain valid IDs (maximum ${maximum})`);
  }
  return [...new Set(value.map((id: string) => id.trim()))];
}

const groupIds = (value: unknown, key: string) => idSet(value, key, 200, id => /^oc_[A-Za-z0-9]+$/.test(id));
const validators = {
  workspaceRoot: (value: unknown): string => {
    try { return validateWorkspaceRoot(value); }
    catch { throw new Error("workspaceRoot must be an existing readable absolute directory"); }
  },
  trustedExecutionEnabled: (value: unknown) => booleanValue(value, "trustedExecutionEnabled"),
  trustedSenderIds: (value: unknown) => idSet(value, "trustedSenderIds", 201, id => id.startsWith("ou_") && id.length <= 200),
  approverId: (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length > 200) throw new Error("approverId must be a string up to 200 characters");
    return value.trim();
  },
  listenerEnabled: (value: unknown) => booleanValue(value, "listenerEnabled"),
  repliesEnabled: (value: unknown) => booleanValue(value, "repliesEnabled"),
  interimRepliesEnabled: (value: unknown) => booleanValue(value, "interimRepliesEnabled"),
  executionReceiptsEnabled: (value: unknown) => booleanValue(value, "executionReceiptsEnabled"),
  groupMessageReactionEnabled: (value: unknown) => booleanValue(value, "groupMessageReactionEnabled"),
  groupMessageReactionEmoji: (value: unknown) => emojiValue(value, "groupMessageReactionEmoji"),
  groupMessageReactionChatIds: (value: unknown) => groupIds(value, "groupMessageReactionChatIds"),
  acknowledgeReactionEmoji: (value: unknown) => emojiValue(value, "acknowledgeReactionEmoji"),
  groupSpontaneousRepliesEnabled: (value: unknown) => booleanValue(value, "groupSpontaneousRepliesEnabled"),
  ownerMentionAssistEnabled: (value: unknown) => booleanValue(value, "ownerMentionAssistEnabled"),
  ownerMentionAssistOwnerId: (value: unknown): string => {
    if (typeof value !== "string" || value.length > 200 || value.trim() !== "" && !/^ou_[A-Za-z0-9]+$/.test(value.trim())) throw new Error("ownerMentionAssistOwnerId must be an open_id or empty");
    return value.trim();
  },
  groupSpontaneousChatIds: (value: unknown) => groupIds(value, "groupSpontaneousChatIds"),
  groupSpontaneousReplyRate: (value: unknown) => numberValue(value, "groupSpontaneousReplyRate", 0, 1, false),
  groupSpontaneousReplyCooldownMs: (value: unknown) => numberValue(value, "groupSpontaneousReplyCooldownMs", 0, 604_800_000),
  groupContextMessageLimit: (value: unknown) => numberValue(value, "groupContextMessageLimit", 1, 200),
  groupContextMaxChars: (value: unknown) => numberValue(value, "groupContextMaxChars", 500, 30_000),
  codexModel: (value: unknown) => modelValue(value, "codexModel"),
  reasoningEffort: (value: unknown) => enumValue(value, "reasoningEffort", larkCodexReasoningEfforts),
  stickerUsageMode: (value: unknown) => enumValue(value, "stickerUsageMode", larkStickerUsageModes),
  turnAutoApprovalEnabled: (value: unknown) => booleanValue(value, "turnAutoApprovalEnabled"),
  turnAutoApprovalModel: (value: unknown) => modelValue(value, "turnAutoApprovalModel"),
  turnAutoApprovalDataSources: (value: unknown) => idSet(value, "turnAutoApprovalDataSources", 100, id => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id)).map(id => id.toLowerCase()).filter((id, index, ids) => ids.indexOf(id) === index),
  ownerMessageFastPathEnabled: (value: unknown) => booleanValue(value, "ownerMessageFastPathEnabled")
};

export type RuntimeSettingsPatch = Partial<{ [K in keyof typeof validators]: ReturnType<typeof validators[K]> }>;

export function parseRuntimeSettingsPatch(value: unknown): RuntimeSettingsPatch {
  const body = strictSettingsObject(value, Object.keys(validators));
  return Object.fromEntries(Object.entries(body).map(([key, entry]) => [key, validators[key as keyof typeof validators](entry)]));
}

export function runtimeSettingEntries(patch: RuntimeSettingsPatch): Array<[string, string]> {
  return Object.entries(patch).map(([key, value]) => [key === "reasoningEffort" ? "codexReasoningEffort" : key, Array.isArray(value) ? JSON.stringify(value) : String(value)]);
}
