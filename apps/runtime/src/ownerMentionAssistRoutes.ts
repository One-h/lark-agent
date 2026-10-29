import type { FastifyInstance, FastifyRequest } from "fastify";
import { listOwnerMentionAssists, publishApprovedOwnerAssistDraft, reviewOwnerMentionAssist } from "@lark-agent/conversation-runtime";

export function registerOwnerMentionAssistRoutes(app: FastifyInstance, authenticated: (request: FastifyRequest) => boolean) {
  app.get("/v1/owner-mention-assists", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    return { items: listOwnerMentionAssists() };
  });
  app.post("/v1/owner-mention-assists/:id/decision", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    const id = Number((request.params as { id: string }).id), body = request.body as Record<string, unknown> | null;
    if (!Number.isSafeInteger(id) || id <= 0 || !body || Array.isArray(body) || !Number.isSafeInteger(body.version)
      || !["send", "dismiss"].includes(String(body.action)) || Object.keys(body).some(key => !["action", "text", "version"].includes(key))) return reply.code(400).send({ error: "invalid owner assistance decision" });
    try {
      await reviewOwnerMentionAssist(id, body, publishApprovedOwnerAssistDraft);
      return { item: listOwnerMentionAssists().find(row => row.lark_message_id === id) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
