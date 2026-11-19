import type { FastifyInstance, FastifyRequest } from "fastify";
import { cancelExternalTopicTurns, getTopicExecutionSettings, updateTopicExecutionSettings, validLarkCodexModel, type ExecutionEngineRoute } from "@lark-agent/conversation-runtime";

export function registerTopicExecutionRoutes(app: FastifyInstance, authorized: (request: FastifyRequest) => boolean) {
  const base = "/v1/chats/:chatId/topics/:threadId/execution";
  const valid = ({ chatId, threadId }: Record<string, string>) =>
    /^oc_[a-z0-9_-]{1,196}$/i.test(chatId ?? "") && /^[a-z0-9_-]{1,200}$/i.test(threadId ?? "");
  app.route({
    method: ["GET", "PUT"],
    url: base,
    async handler(request, reply) {
      if (!authorized(request)) return reply.code(401).send({ error: "Runtime authorization required" });
      const target = request.params as { chatId: string; threadId: string };
      if (!valid(target)) return reply.code(400).send({ error: "Invalid chat or topic ID" });
      const { chatId, threadId } = target;
      if (request.method === "GET") return getTopicExecutionSettings(chatId, threadId);
      const body = request.body as { override?: unknown } | null;
      if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, "override")) return reply.code(400).send({ error: "Invalid topic execution settings" });
      const override = body.override as ExecutionEngineRoute | null;
      if (override !== null && (!override || typeof override !== "object"
        || Object.keys(override).length !== 2 || typeof override.engineId !== "string"
        || !/^[a-z][a-z0-9-]{0,39}$/.test(override.engineId)
        || (override.model !== null && (typeof override.model !== "string" || !validLarkCodexModel(override.model))))) {
        return reply.code(400).send({ error: "Invalid engine or model" });
      }
      const result = updateTopicExecutionSettings(chatId, threadId, override);
      if (result === "missing") return reply.code(404).send({ error: "Topic has no observed group messages" });
      if (result === "busy") return reply.code(409).send({ error: "Wait for the topic's queued or running work to finish" });
      if (result === "unavailable") return reply.code(409).send({ error: "The selected engine or model is unavailable" });
      return getTopicExecutionSettings(chatId, threadId);
    }
  });
  app.post(`${base}/cancel`, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "Runtime authorization required" });
    const target = request.params as { chatId: string; threadId: string };
    if (!valid(target)) return reply.code(400).send({ error: "Invalid chat or topic ID" });
    const requested = cancelExternalTopicTurns(target.chatId, target.threadId);
    return reply.code(202).send({ requested });
  });
}
