import { randomUUID } from "node:crypto";
import { appSettingValue, config, conversationCodexModelSettings, db, setAppSettingValue, setConversationCodexModel, type LarkMessageRow } from "./context.js";
import { ExecutionEngineRegistry, type ExecutionEngine, type ExecutionEngineRoute, type LarkExecutionPolicy } from "./executionEngines.js";

export type StoredTopicExecutionRoute = ExecutionEngineRoute & { bindingId: string; afterMessageId: number };
type StoredRoute = StoredTopicExecutionRoute;
export type ExternalExecutionRoute = StoredRoute & { conversation?: true };
let registry = new ExecutionEngineRegistry();

export function configureTopicExecutionEngines(engines: readonly ExecutionEngine[]): void {
  const next = new ExecutionEngineRegistry();
  for (const engine of engines) next.register(engine);
  registry = next;
}

const routeKey = (chatId: string, threadId: string) => `topicExecution:${JSON.stringify([chatId, threadId])}`;
const conversationRouteKey = (chatId: string) => `conversation.execution:${chatId}`;
export const topicEngineSessionKey = (route: ExternalExecutionRoute, policy: LarkExecutionPolicy, threadId: string | null) =>
  `topicExecutionSession:${JSON.stringify([route.bindingId, policy.trustScope, policy.cwd, ...(route.conversation ? [threadId] : [])])}`;

function readRoute(key: string): StoredRoute | null {
  const value = appSettingValue(key);
  if (!value) return null;
  const data = JSON.parse(value) as StoredRoute;
  if (typeof data?.engineId !== "string" || typeof data.bindingId !== "string" || !Number.isSafeInteger(data.afterMessageId)
    || (data.model !== null && typeof data.model !== "string")) throw new Error("Invalid stored execution route");
  return data;
}

export function topicExecutionRoute(chatId: string | null, threadId: string | null): StoredRoute | null {
  return chatId && threadId ? readRoute(routeKey(chatId, threadId)) : null;
}

function conversationExecutionRoute(chatId: string | null): StoredRoute | null {
  return chatId ? readRoute(conversationRouteKey(chatId)) : null;
}

const selection = (route: ExecutionEngineRoute | null) =>
  route ? { engineId: route.engineId, model: route.model } : null;
const available = (route: ExecutionEngineRoute) => route.engineId === "codex" || Boolean(registry.resolve(route));

export function getConversationExecutionSettings(chatId: string) {
  const external = selection(conversationExecutionRoute(chatId));
  const codexModel = conversationCodexModelSettings(chatId);
  const override = external ?? (codexModel.override ? { engineId: "codex", model: codexModel.override } : null);
  const effective = external ?? { engineId: "codex", model: codexModel.effectiveModel };
  return { override, effective, available: available(effective), engines: registry.list(), codexModel };
}

export function getTopicExecutionSettings(chatId: string, threadId: string) {
  const override = selection(topicExecutionRoute(chatId, threadId));
  const inherited = getConversationExecutionSettings(chatId).effective;
  const effective = override?.engineId === "codex"
    ? { engineId: "codex", model: conversationCodexModelSettings(chatId).effectiveModel }
    : override ?? inherited;
  return {
    override, effective, inherited,
    available: available(effective),
    engines: registry.list()
  };
}

function saveRoute(key: string, previous: StoredRoute | null, route: ExecutionEngineRoute | null, afterMessageId: number): void {
  const reuse = previous && previous.engineId === route?.engineId && (previous.model === null) === (route.model === null);
  setAppSettingValue(key, route ? JSON.stringify({
    ...route, bindingId: reuse ? previous.bindingId : randomUUID(), afterMessageId
  }) : "");
}

export function updateConversationExecutionSettings(chatId: string, route: ExecutionEngineRoute | null): "ok" | "busy" | "unavailable" | "missing" {
  const latest = db.prepare("SELECT MAX(id) AS id FROM lark_messages WHERE chat_id=? AND chat_type IN ('group','p2p') AND direction='inbound'")
    .get(chatId) as { id: number | null };
  if (latest.id === null) return "missing";
  const external = route?.engineId !== "codex" ? route : null;
  const previous = conversationExecutionRoute(chatId);
  if (external && !available(external)) return "unavailable";
  if (external && previous?.engineId === external.engineId && previous.model === external.model) return "ok";
  if ((previous || external) && db.prepare("SELECT 1 FROM lark_messages WHERE chat_id=? AND codex_status IN ('queued','running') LIMIT 1").get(chatId)) return "busy";
  db.transaction(() => {
    if (external) {
      // Each engine keeps its own native conversation when switching away and back.
      const bindingId = JSON.stringify(["conversation", chatId, external.engineId, external.model === null]);
      setAppSettingValue(conversationRouteKey(chatId), JSON.stringify({ ...external, bindingId, afterMessageId: latest.id }));
    } else {
      if (previous) setAppSettingValue(conversationRouteKey(chatId), "");
      setConversationCodexModel(chatId, route?.model ?? null);
    }
  })();
  return "ok";
}

export function updateTopicExecutionSettings(chatId: string, threadId: string, route: ExecutionEngineRoute | null): "ok" | "busy" | "unavailable" | "missing" {
  const latest = db.prepare("SELECT MAX(id) AS id FROM lark_messages WHERE chat_type='group' AND chat_id=? AND thread_id=? AND direction='inbound'")
    .get(chatId, threadId) as { id: number | null };
  if (!latest.id) return "missing";
  if (route && !available(route)) return "unavailable";
  const previous = topicExecutionRoute(chatId, threadId);
  if (previous?.engineId === route?.engineId && previous?.model === route?.model) return "ok";
  if (db.prepare("SELECT 1 FROM lark_messages WHERE chat_id=? AND thread_id=? AND codex_status IN ('queued','running') LIMIT 1").get(chatId, threadId)) return "busy";
  saveRoute(routeKey(chatId, threadId), previous, route, latest.id);
  return "ok";
}

export function hasExternalExecutionRoute(chatId: string | null, threadId: string | null): boolean {
  const topic = topicExecutionRoute(chatId, threadId);
  return Boolean(topic && topic.engineId !== "codex" || conversationExecutionRoute(chatId));
}

export function externalExecutionForMessage(message: LarkMessageRow): ExternalExecutionRoute | null {
  if (message.sender_type !== "user") return null;
  if (message.chat_type === "group") {
    if (config.groupPrivacyEnforced || !["mention", "topic"].includes(message.reply_trigger)) return null;
    const topic = topicExecutionRoute(message.chat_id, message.thread_id);
    if (topic) return topic.engineId === "codex" ? null : topic;
  } else if (message.chat_type !== "p2p" || message.reply_trigger !== "p2p") return null;
  const route = conversationExecutionRoute(message.chat_id);
  return route ? { ...route, conversation: true } : null;
}

export function resolveTopicExecutionEngine(route: ExecutionEngineRoute): ExecutionEngine | undefined { return registry.resolve(route); }
export function loadTopicExecutionSession(key: string): string | null {
  return appSettingValue(key) || null;
}
export function saveTopicExecutionSession(key: string, sessionId: string): void {
  setAppSettingValue(key, sessionId);
}
export function topicExecutionPreviouslyDispatched(id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lark_topic_engine_runs WHERE lark_message_id=?").get(id));
}
export function recordTopicExecution(messageId: number, route: ExecutionEngineRoute, sessionId?: string, turnId?: string): void {
  db.prepare(`INSERT INTO lark_topic_engine_runs(lark_message_id,engine_id,model,session_id,turn_id) VALUES (?,?,?,?,?)
    ON CONFLICT(lark_message_id) DO UPDATE SET session_id=excluded.session_id,turn_id=excluded.turn_id`).run(messageId, route.engineId, route.model, sessionId ?? null, turnId ?? null);
}
