import { randomUUID } from "node:crypto";
import { appSettingValue, config, db, setAppSettingValue, type LarkMessageRow } from "./context.js";
import { larkBuiltinPluginEnabled } from "./builtinPlugins.js";

type TopicMessage = Partial<Pick<LarkMessageRow, "chat_id" | "chat_type" | "thread_id" | "sender_type" | "reply_trigger">>;
export type NativeTopicCommand = "join" | "leave";

export function topicNativeModeEnabled(): boolean {
  return larkBuiltinPluginEnabled(db, "native-topics") && appSettingValue("topicNativeModeEnabled") === "true";
}

export function resetTopicNativeEnrollmentEpoch(): string {
  const epoch = randomUUID();
  setAppSettingValue("topicNativeModeEpoch", epoch);
  return epoch;
}

function enrollmentKey(message: TopicMessage): string | null {
  if (!topicNativeModeEnabled() || config.groupPrivacyEnforced || message.chat_type !== "group"
    || !message.chat_id || !message.thread_id || message.sender_type !== "user" || message.reply_trigger === "owner_mention") return null;
  // Legacy mention-based enrollment is intentionally not carried forward.
  return `topicNativeExplicitEnrollment:${JSON.stringify([message.chat_id, message.thread_id])}`;
}

export function isNativeTopicConversation(message: TopicMessage): boolean {
  const key = enrollmentKey(message);
  if (!key) return false;
  const epoch = appSettingValue("topicNativeModeEpoch");
  return Boolean(epoch && appSettingValue(key) === epoch);
}

export function setNativeTopicEnrollment(message: TopicMessage, command: NativeTopicCommand): boolean {
  const key = enrollmentKey(message);
  if (!key) return false;
  setAppSettingValue(key, command === "join" ? appSettingValue("topicNativeModeEpoch") || resetTopicNativeEnrollmentEpoch() : "");
  return true;
}

export function parseNativeTopicCommand(content: unknown): NativeTopicCommand | null {
  if (typeof content !== "string") return null;
  const text = content.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "").replace(/@_user_\d+/g, "").trim();
  const command = /^\/topic\s+(join|leave)$/.exec(text)?.[1];
  return command === "join" || command === "leave" ? command : null;
}
