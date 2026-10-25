import fs from "node:fs";
import path from "node:path";
import { appSettingValue, config, setAppSettingValue } from "./context.js";

export const configurablePromptKeys = ["larkAssistant", "prReview", "issueTriage", "issueImplementation"] as const;
export type ConfigurablePromptKey = typeof configurablePromptKeys[number];

export type ConfigurablePrompt = {
  value: string;
  defaultValue: string;
  customized: boolean;
};

const settingKeys: Record<ConfigurablePromptKey, string> = {
  larkAssistant: "prompt.larkAssistant",
  prReview: "prompt.prReview",
  issueTriage: "prompt.issueTriage",
  issueImplementation: "prompt.issueImplementation"
};

const templatePaths: Record<Exclude<ConfigurablePromptKey, "larkAssistant">, string> = {
  prReview: path.join(config.repoRoot, "prompts", "pr-review-job.md"),
  issueTriage: path.join(config.repoRoot, "prompts", "issue-triage-job.md"),
  issueImplementation: path.join(config.repoRoot, "prompts", "issue-implementation-job.md")
};

const defaultLarkAssistantPrompt = `你是 Lark Agent 飞书机器人的快速问答助手。

请用中文尽快回答用户问题，表达简洁、直接。工作问答优先给出可执行的判断或下一步建议，闲聊则自然接话。长任务的中途进展保持简短，最终答复按问题组织，不使用固定模板词。`;

export function defaultConfigurablePrompt(key: ConfigurablePromptKey): string {
  if (key === "larkAssistant") {
    return defaultLarkAssistantPrompt;
  }
  return fs.readFileSync(templatePaths[key], "utf8");
}

export function configurablePrompt(key: ConfigurablePromptKey): string {
  const custom = appSettingValue(settingKeys[key]);
  return custom?.trim() || defaultConfigurablePrompt(key);
}

export function configurablePromptOverride(key: ConfigurablePromptKey): string | null {
  const custom = appSettingValue(settingKeys[key])?.trim() ?? "";
  return custom || null;
}

export function configurablePromptSettings(): Record<ConfigurablePromptKey, ConfigurablePrompt> {
  return Object.fromEntries(configurablePromptKeys.map((key) => {
    const defaultValue = defaultConfigurablePrompt(key);
    const custom = configurablePromptOverride(key);
    return [key, { value: custom ?? defaultValue, defaultValue, customized: Boolean(custom) }];
  })) as Record<ConfigurablePromptKey, ConfigurablePrompt>;
}

export function updateConfigurablePrompts(patch: Partial<Record<ConfigurablePromptKey, string | null>>): Record<ConfigurablePromptKey, ConfigurablePrompt> {
  for (const key of configurablePromptKeys) {
    if (!(key in patch)) {
      continue;
    }
    setAppSettingValue(settingKeys[key], patch[key]?.trim() ?? "");
  }
  return configurablePromptSettings();
}
