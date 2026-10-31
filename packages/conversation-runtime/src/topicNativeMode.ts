import { randomUUID } from "node:crypto";
import { appSettingValue, config, setAppSettingValue, type LarkMessageRow } from "./context.js";

type TopicMessage = Partial<Pick<LarkMessageRow, "chat_id" | "chat_type" | "thread_id" | "root_message_id" | "message_id" | "sender_type" | "reply_trigger">>;

export function topicNativeModeEnabled(): boolean {
  return appSettingValue("topicNativeModeEnabled") === "true";
}

export function resetTopicNativeEnrollmentEpoch(): void {
  setAppSettingValue("topicNativeModeEpoch", randomUUID());
}

function enrollmentKeys(message: TopicMessage): string[] {
  if (!message.chat_id) return [];
  const keys = [message.thread_id && ["thread", message.thread_id],
    ["root", message.root_message_id || (!message.thread_id ? message.message_id : null)]];
  return keys.filter((key): key is string[] => Boolean(key && key[1]))
    .map(key => `topicNativeEnrollment:${JSON.stringify([message.chat_id, ...key])}`);
}

export function isNativeTopicConversation(message: TopicMessage): boolean {
  if (!topicNativeModeEnabled() || config.groupPrivacyEnforced || message.chat_type !== "group"
    || !message.thread_id || message.sender_type !== "user" || message.reply_trigger === "owner_mention") return false;
  const epoch = appSettingValue("topicNativeModeEpoch");
  const states = enrollmentKeys(message).flatMap(key => {
    try {
      const state = JSON.parse(appSettingValue(key) ?? "null");
      return state?.epoch === epoch && Number.isSafeInteger(state.revision) && typeof state.enabled === "boolean" ? [state as { revision: number; enabled: boolean }] : [];
    } catch { return []; }
  });
  // The latest explicit join/leave wins across a root anchor and its native ID.
  return Boolean(epoch && states.sort((a, b) => b.revision - a.revision)[0]?.enabled);
}

// Commit enrollment only for new locally handled events, never redeliveries.
export function enrollNativeTopic(message: TopicMessage, leave = false): void {
  if (!topicNativeModeEnabled() || config.groupPrivacyEnforced || message.chat_type !== "group" || message.sender_type !== "user") return;
  if (!appSettingValue("topicNativeModeEpoch")) resetTopicNativeEnrollmentEpoch();
  const previous = Number(appSettingValue("topicNativeEnrollmentRevision") ?? 0);
  const revision = Number.isSafeInteger(previous) && previous >= 0 && previous < Number.MAX_SAFE_INTEGER ? previous + 1 : 1;
  setAppSettingValue("topicNativeEnrollmentRevision", String(revision));
  const state = JSON.stringify({ epoch: appSettingValue("topicNativeModeEpoch"), enabled: !leave, revision });
  for (const key of enrollmentKeys(message)) setAppSettingValue(key, state);
}

export function isTopicLeaveCommand(content: unknown): boolean {
  return typeof content === "string" && content.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/@_user_\d+/g, "").trim() === "/topic leave";
}
