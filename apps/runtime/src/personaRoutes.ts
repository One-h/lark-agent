import type { FastifyInstance, FastifyRequest } from "fastify";
import { captureConversationStyle, composeConversationStyle, conversationStickerUsageSettings, larkStickerUsageModes, parsePersonaInput, saveConversationPersona, setConversationStickerUsageMode, validPersonaChatId } from "@lark-agent/conversation-runtime";
import { conversationSpontaneousSettings, setConversationSpontaneousSettings, type ConversationSpontaneousMode } from "@lark-agent/conversation-runtime";
import { strictSettingsObject } from "./settingsSchema.js";

export function registerPersonaRoutes(app: FastifyInstance, authenticated: (request: FastifyRequest) => boolean) {
  for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["POST", "/preview"]] as const) {
    app.route({
      method,
      url: `/v1/chats/:chatId/persona${suffix}`,
      handler: async (request, reply) => {
        if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
        const { chatId } = request.params as { chatId: string };
        if (!validPersonaChatId(chatId)) return reply.code(400).send({ code: "INVALID_CHAT_ID", message: "无效的飞书会话 ID", traceId: request.id });
        try {
          if (method === "GET") return captureConversationStyle(chatId);
          strictSettingsObject(request.body, ["mode", "name", "instructions"], "persona");
          if (method === "PUT") {
            saveConversationPersona(chatId, request.body);
            return captureConversationStyle(chatId);
          }
          const current = captureConversationStyle(chatId);
          return composeConversationStyle({ ...current.persona, ...parsePersonaInput(request.body) }, current.globalPrompt);
        } catch (error) {
          return reply.code(400).send({ code: "INVALID_PERSONA", message: error instanceof Error ? error.message : String(error), traceId: request.id });
        }
      }
    });
  }
  app.route({
    method: ["GET", "PATCH"],
    url: "/v1/chats/:chatId/settings",
    handler: async (request, reply) => {
      if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
      const { chatId } = request.params as { chatId: string };
      if (!validPersonaChatId(chatId)) return reply.code(400).send({ code: "INVALID_CHAT_ID", message: "无效的飞书会话 ID", traceId: request.id });
      if (request.method === "PATCH") {
        try { strictSettingsObject(request.body, ["stickerUsageMode", "spontaneousMode", "spontaneousReplyRate", "spontaneousReplyCooldownMs"], "conversation settings"); }
        catch (error) { return reply.code(400).send({ code: "INVALID_CONVERSATION_SETTINGS", message: error instanceof Error ? error.message : String(error), traceId: request.id }); }
        const body = request.body as { stickerUsageMode?: unknown; spontaneousMode?: unknown; spontaneousReplyRate?: unknown; spontaneousReplyCooldownMs?: unknown } | null;
        const mode = body?.stickerUsageMode;
        if (mode === undefined && body?.spontaneousMode === undefined && body?.spontaneousReplyRate === undefined && body?.spontaneousReplyCooldownMs === undefined) {
          return reply.code(400).send({ code: "INVALID_CONVERSATION_SETTINGS", message: "没有可更新的会话设置", traceId: request.id });
        }
        if (mode !== undefined && mode !== "global" && !larkStickerUsageModes.includes(mode as typeof larkStickerUsageModes[number])) {
          return reply.code(400).send({ code: "INVALID_STICKER_USAGE_MODE", message: "无效的表情包使用策略", traceId: request.id });
        }
        const spontaneousMode = body?.spontaneousMode;
        const replyRate = body?.spontaneousReplyRate;
        const cooldownMs = body?.spontaneousReplyCooldownMs;
        if (spontaneousMode !== undefined && !["global", "on", "off"].includes(String(spontaneousMode))
          || replyRate !== undefined && (typeof replyRate !== "number" || !Number.isFinite(replyRate) || replyRate < 0 || replyRate > 1)
          || cooldownMs !== undefined && (typeof cooldownMs !== "number" || !Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 604_800_000)) {
          return reply.code(400).send({ code: "INVALID_SPONTANEOUS_SETTINGS", message: "无效的群聊随机插话设置", traceId: request.id });
        }
        if (mode !== undefined) setConversationStickerUsageMode(chatId, mode as "global" | typeof larkStickerUsageModes[number]);
        if (spontaneousMode !== undefined || replyRate !== undefined || cooldownMs !== undefined) {
          setConversationSpontaneousSettings(chatId, { mode: spontaneousMode as ConversationSpontaneousMode | undefined, replyRate: replyRate as number | undefined, cooldownMs: cooldownMs as number | undefined });
        }
      }
      return { stickerUsage: conversationStickerUsageSettings(chatId), spontaneousReply: conversationSpontaneousSettings(chatId) };
    }
  });
}
