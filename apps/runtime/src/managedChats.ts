import type Database from "better-sqlite3";
import type { ManagedChatCreator } from "@lark-agent/adapter-lark-cli";
import {
  configuredLarkCodexModel, getConversationExecutionSettings, parsePersonaInput, resolveTopicExecutionEngine,
  saveConversationPersona, updateConversationExecutionSettings, validLarkCodexModel, validPersonaChatId,
  type PersonaInput
} from "@lark-agent/conversation-runtime";

const createId = "lark.chat.create";
const listId = "lark.chat.list_managed";
export const isManagedChatCapability = (id: string) => id === createId || id === listId;
const string = { type: "string" };
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
export const managedChatCapabilities = [{
  id: createId, title: "创建飞书群聊",
  description: "When the configured owner explicitly asks in a private Feishu chat, create a private group with that owner and this bot. Provide a fresh UUID requestId for each new group; reuse it if the result was uncertain. Persona and execution are optional; omit to use defaults.",
  risk: "external-write" as const,
  inputSchema: object({
    requestId: { ...string, format: "uuid" }, name: { ...string, minLength: 1, maxLength: 60 },
    persona: object({ mode: { ...string, enum: ["custom"] }, name: string, instructions: string }, ["mode", "name", "instructions"]),
    execution: object({ engineId: string, model: string }, ["engineId", "model"])
  }, ["requestId", "name"])
}, {
  id: listId, title: "查看已建飞书群聊",
  description: "List groups created through Forge or this tool, their Feishu open links, and the configured engine/model choices. Available only in the configured owner's Feishu private chat.",
  risk: "read" as const, inputSchema: object({})
}];

export class ManagedChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type Input = {
  requestId: string;
  name: string;
  persona?: PersonaInput;
  execution?: { engineId: string; model: string };
};
type Row = {
  request_id: string; request_json: string; chat_id: string | null;
  status: "creating" | "ready" | "attention"; created_at: string; error: string | null;
};

function fields(input: unknown, allowed: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    throw new Error("建群参数包含无效字段。");
  return input as Record<string, unknown>;
}

function parse(input: unknown): Input {
  const body = fields(input, ["requestId", "name", "persona", "execution"]);
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId))
    throw new Error("创建请求 ID 必须为 UUID。");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("群名需为 1–60 个字符，且不能包含控制字符。");
  const parsed: Input = { requestId: body.requestId.toLowerCase(), name };
  if ("persona" in body) {
    const persona = fields(body.persona, ["mode", "name", "instructions"]);
    if (persona.mode !== "custom") throw new Error("自定义人设必须使用 custom 模式。");
    parsed.persona = parsePersonaInput(persona);
  }
  if ("execution" in body) {
    const route = fields(body.execution, ["engineId", "model"]);
    if (typeof route.engineId !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(route.engineId)
      || typeof route.model !== "string" || !route.model.trim() || route.model.length > 120)
      throw new Error("无效的引擎或模型。");
    parsed.execution = { engineId: route.engineId, model: route.model.trim() };
  }
  return parsed;
}

function view(row: Row) {
  const { name, persona, execution } = JSON.parse(row.request_json) as Input;
  const chatId = row.chat_id && validPersonaChatId(row.chat_id) ? row.chat_id : null;
  return { requestId: row.request_id, name, chatId,
    openUrl: chatId ? `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}` : null,
    createdAt: row.created_at, status: row.status, error: row.error, persona: persona ?? null, execution: execution ?? null };
}

export function managedChats(db: Database.Database, options: {
  owner: () => string | undefined;
  create?: ManagedChatCreator;
  codexModels?: () => Promise<string[]>;
  reportError?: (phase: string) => void;
}) {
  const owner = () => {
    const id = options.owner();
    if (!id || !/^ou_[A-Za-z0-9]+$/.test(id)) throw new ManagedChatError(409, "LARK_MANAGED_CHAT_OWNER_UNSET", "请先配置飞书机器人所有者。");
    return id;
  };
  const read = (id: string, requestId: string) => db.prepare("SELECT * FROM lark_managed_chats WHERE creator_id=? AND request_id=?").get(id, requestId) as Row | undefined;
  const incomplete = (row: Row) => new ManagedChatError(409, "LARK_MANAGED_CHAT_UNCONFIRMED",
    row.error ?? "建群仍在处理，或上一次结果未确认。请刷新列表，不要重新发起建群。");
  let modelCache: { expires: number; models: Promise<string[]> } | undefined;

  return {
    async list(input: unknown = {}) {
      try { fields(input, []); } catch { throw new ManagedChatError(400, "LARK_MANAGED_CHAT_INVALID", "列表工具无需业务参数。"); }
      const id = owner();
      if (options.codexModels && (!modelCache || modelCache.expires <= Date.now())) {
        modelCache = { expires: Date.now() + 60_000, models: options.codexModels().catch(() => []) };
      }
      const codexModels = [...new Set([configuredLarkCodexModel(), ...await (modelCache?.models ?? [])])].filter(validLarkCodexModel);
      if (owner() !== id) throw new ManagedChatError(409, "LARK_MANAGED_CHAT_OWNER_CHANGED", "机器人所有者已变更，请刷新后再试。");
      const rows = db.prepare("SELECT * FROM lark_managed_chats WHERE creator_id=? ORDER BY created_at DESC, rowid DESC").all(id) as Row[];
      return { items: rows.map(view),
        engines: [{ id: "codex", label: "Codex", models: codexModels }, ...getConversationExecutionSettings("").engines] };
    },
    async create(input: unknown) {
      const id = owner();
      let parsed: Input;
      try { parsed = parse(input); } catch (error) {
        throw new ManagedChatError(400, "LARK_MANAGED_CHAT_INVALID", error instanceof Error ? error.message : "建群参数不正确。");
      }
      const json = JSON.stringify(parsed);
      const prior = read(id, parsed.requestId);
      if (prior) {
        if (prior.request_json !== json) throw new ManagedChatError(409, "LARK_MANAGED_CHAT_REQUEST_CONFLICT", "这个请求 ID 已用于其他建群参数。");
        if (prior.status === "ready") return { item: view(prior) };
        throw incomplete(prior);
      }
      if (!options.create) throw new ManagedChatError(503, "LARK_MANAGED_CHAT_INACTIVE", "飞书机器人当前未启用建群。");
      const route = parsed.execution;
      if (route && (route.engineId === "codex" ? !validLarkCodexModel(route.model) : !resolveTopicExecutionEngine(route)))
        throw new ManagedChatError(400, "LARK_MANAGED_CHAT_ENGINE_UNAVAILABLE", "该引擎或模型当前不可用。");
      db.prepare("INSERT INTO lark_managed_chats (creator_id, request_id, request_json, status, created_at) VALUES (?, ?, ?, 'creating', ?)")
        .run(id, parsed.requestId, json, new Date().toISOString());

      const attention = (message: string) => db.prepare(
        "UPDATE lark_managed_chats SET status='attention', error=? WHERE creator_id=? AND request_id=?"
      ).run(message, id, parsed.requestId);
      try {
        const result = await options.create({ ownerId: id, name: parsed.name, requestId: parsed.requestId });
        if (!validPersonaChatId(result.chatId)) throw new Error("No confirmed group ID");
        db.prepare("UPDATE lark_managed_chats SET chat_id=? WHERE creator_id=? AND request_id=?")
          .run(result.chatId, id, parsed.requestId);
        if (!result.ownerConfirmed) {
          attention("飞书已返回群聊，但未确认本人为群主。请在飞书核对。");
        } else {
          try {
            db.transaction(() => {
              if (parsed.persona) saveConversationPersona(result.chatId, parsed.persona);
              if (route && updateConversationExecutionSettings(result.chatId, route) !== "ok") throw new Error("Route not saved");
              db.prepare("UPDATE lark_managed_chats SET status='ready' WHERE creator_id=? AND request_id=?")
                .run(id, parsed.requestId);
            })();
          } catch {
            options.reportError?.("settings");
            attention("群聊已创建，但人设或模型未保存。请核对会话设置，不要重复建群。");
          }
        }
      } catch {
        options.reportError?.("create");
        attention("未能确认建群结果。为避免重复创建，未自动重试；请在飞书核对。");
      }
      const result = read(id, parsed.requestId)!;
      if (result.status !== "ready") throw incomplete(result);
      return { item: view(result) };
    }
  };
}
