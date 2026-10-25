import { appSettingValue, groupSpontaneousChatIds, groupSpontaneousReplyCooldownMs, groupSpontaneousReplyRate, setAppSettingValue } from "./context.js";

export type ConversationSpontaneousMode = "global" | "on" | "off";
export type ConversationSpontaneousSettings = {
  mode: ConversationSpontaneousMode;
  replyRate: number;
  cooldownMs: number;
  effectiveEnabled: boolean;
  effectiveReplyRate: number;
  effectiveCooldownMs: number;
  globalEnabled: boolean;
  globallyAllowed: boolean;
  globalReplyRate: number;
  globalCooldownMs: number;
};

function storedSettings(chatId: string): { mode: ConversationSpontaneousMode; replyRate?: number; cooldownMs?: number } {
  try {
    const value = JSON.parse(appSettingValue(`conversation.spontaneousReply:${chatId}`) ?? "null") as Record<string, unknown> | null;
    if (!value || !["global", "on", "off"].includes(String(value.mode))) return { mode: "global" };
    const replyRate = typeof value.replyRate === "number" && Number.isFinite(value.replyRate) && value.replyRate >= 0 && value.replyRate <= 1 ? value.replyRate : undefined;
    const cooldownMs = typeof value.cooldownMs === "number" && Number.isInteger(value.cooldownMs) && value.cooldownMs >= 0 && value.cooldownMs <= 604_800_000 ? value.cooldownMs : undefined;
    return { mode: value.mode as ConversationSpontaneousMode, replyRate, cooldownMs };
  } catch { return { mode: "global" }; }
}

export function conversationSpontaneousSettings(chatId: string): ConversationSpontaneousSettings {
  const stored = storedSettings(chatId);
  const globalEnabled = appSettingValue("groupSpontaneousRepliesEnabled") === "true";
  const globallyAllowed = groupSpontaneousChatIds().includes(chatId);
  const globalReplyRate = groupSpontaneousReplyRate();
  const globalCooldownMs = groupSpontaneousReplyCooldownMs();
  const replyRate = stored.replyRate ?? globalReplyRate;
  const cooldownMs = stored.cooldownMs ?? globalCooldownMs;
  return {
    mode: stored.mode, replyRate, cooldownMs,
    effectiveEnabled: stored.mode === "on" || (stored.mode === "global" && globalEnabled && globallyAllowed),
    effectiveReplyRate: stored.mode === "on" ? replyRate : globalReplyRate,
    effectiveCooldownMs: stored.mode === "on" ? cooldownMs : globalCooldownMs,
    globalEnabled, globallyAllowed, globalReplyRate, globalCooldownMs
  };
}

export function setConversationSpontaneousSettings(chatId: string, patch: { mode?: ConversationSpontaneousMode; replyRate?: number; cooldownMs?: number }): void {
  if (patch.mode !== undefined && !["global", "on", "off"].includes(patch.mode)) throw new Error("无效的随机插话模式");
  if (patch.replyRate !== undefined && (!Number.isFinite(patch.replyRate) || patch.replyRate < 0 || patch.replyRate > 1)) throw new Error("随机插话概率必须在 0 到 1 之间");
  if (patch.cooldownMs !== undefined && (!Number.isInteger(patch.cooldownMs) || patch.cooldownMs < 0 || patch.cooldownMs > 604_800_000)) throw new Error("随机插话冷却必须在 0 到 7 天之间");
  const current = storedSettings(chatId);
  setAppSettingValue(`conversation.spontaneousReply:${chatId}`, JSON.stringify({
    mode: patch.mode ?? current.mode,
    replyRate: patch.replyRate ?? current.replyRate ?? groupSpontaneousReplyRate(),
    cooldownMs: patch.cooldownMs ?? current.cooldownMs ?? groupSpontaneousReplyCooldownMs()
  }));
}
