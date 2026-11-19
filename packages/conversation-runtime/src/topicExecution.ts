import { randomUUID } from "node:crypto";
import { appSettingValue, config, conversationCodexModelSettings, db, setAppSettingValue, type LarkMessageRow } from "./context.js";
import { ExecutionEngineRegistry, type ExecutionEngine, type ExecutionEngineRoute } from "./executionEngines.js";

export type StoredTopicExecutionRoute = ExecutionEngineRoute & { bindingId: string; afterMessageId: number };
type StoredRoute = StoredTopicExecutionRoute;
let registry = new ExecutionEngineRegistry();

export function configureTopicExecutionEngines(engines: readonly ExecutionEngine[]): void {
  const next = new ExecutionEngineRegistry();
  for (const engine of engines) next.register(engine);
  registry = next;
}

const routeKey = (chatId: string, threadId: string) => `topicExecution:${JSON.stringify([chatId, threadId])}`;
const sessionKey = (route: StoredRoute, trusted: boolean) => `topicExecutionSession:${JSON.stringify([route.bindingId, trusted])}`;

export function topicExecutionRoute(chatId: string | null, threadId: string | null): StoredRoute | null {
  if (!chatId || !threadId) return null;
  const value = appSettingValue(routeKey(chatId, threadId));
  if (!value) return null;
  const data = JSON.parse(value) as StoredRoute;
  if (typeof data?.engineId !== "string" || typeof data.bindingId !== "string" || !Number.isSafeInteger(data.afterMessageId)
    || (data.model !== null && typeof data.model !== "string")) throw new Error("Invalid stored topic execution route");
  return data;
}

export function getTopicExecutionSettings(chatId: string, threadId: string) {
  const route = topicExecutionRoute(chatId, threadId);
  const override = route ? { engineId: route.engineId, model: route.model } : null;
  return {
    override,
    effective: override ?? { engineId: "codex", model: conversationCodexModelSettings(chatId).effectiveModel },
    available: route ? Boolean(registry.resolve(route)) : true,
    engines: registry.list()
  };
}

export function updateTopicExecutionSettings(chatId: string, threadId: string, route: ExecutionEngineRoute | null): "ok" | "busy" | "unavailable" | "missing" {
  const latest = db.prepare("SELECT MAX(id) AS id FROM lark_messages WHERE chat_type='group' AND chat_id=? AND thread_id=? AND direction='inbound'")
    .get(chatId, threadId) as { id: number | null };
  if (!latest.id) return "missing";
  if (route && !registry.resolve(route)) return "unavailable";
  const previous = topicExecutionRoute(chatId, threadId);
  if (previous?.engineId === route?.engineId && previous?.model === route?.model) return "ok";
  if (db.prepare("SELECT 1 FROM lark_messages WHERE chat_id=? AND thread_id=? AND codex_status IN ('queued','running') LIMIT 1").get(chatId, threadId)) return "busy";
  const reuse = previous && previous.engineId === route?.engineId && (previous.model === null) === (route.model === null);
  setAppSettingValue(routeKey(chatId, threadId), route ? JSON.stringify({
    ...route, bindingId: reuse ? previous.bindingId : randomUUID(), afterMessageId: latest.id
  }) : "");
  return "ok";
}

export function topicExecutionForMessage(message: LarkMessageRow): StoredRoute | null {
  if (config.groupPrivacyEnforced || message.chat_type !== "group" || message.sender_type !== "user"
    || !["mention", "topic"].includes(message.reply_trigger)) return null;
  return topicExecutionRoute(message.chat_id, message.thread_id);
}

export function resolveTopicExecutionEngine(route: ExecutionEngineRoute): ExecutionEngine | undefined { return registry.resolve(route); }
export function loadTopicExecutionSession(route: StoredRoute, trusted: boolean): string | null {
  return appSettingValue(sessionKey(route, trusted)) || null;
}
export function saveTopicExecutionSession(route: StoredRoute, trusted: boolean, sessionId: string): void {
  setAppSettingValue(sessionKey(route, trusted), sessionId);
}
export function topicExecutionPreviouslyDispatched(id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lark_topic_engine_runs WHERE lark_message_id=?").get(id));
}
export function recordTopicExecution(messageId: number, route: ExecutionEngineRoute, sessionId?: string, turnId?: string): void {
  db.prepare(`INSERT INTO lark_topic_engine_runs(lark_message_id,engine_id,model,session_id,turn_id) VALUES (?,?,?,?,?)
    ON CONFLICT(lark_message_id) DO UPDATE SET session_id=excluded.session_id,turn_id=excluded.turn_id`).run(messageId, route.engineId, route.model, sessionId ?? null, turnId ?? null);
}
