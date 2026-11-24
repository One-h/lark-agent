import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { managedChatCapabilities, managedChats, ManagedChatError } from "../managedChats.js";

export function mountManagedChatsPlugin({ app, store, options, authorized }: {
  app: FastifyInstance;
  store: SqliteAgentStore;
  options: Parameters<typeof managedChats>[1];
  authorized: (request: FastifyRequest) => boolean;
}): ReturnType<typeof managedChats> {
  store.registerCapabilities(managedChatCapabilities);
  const groupManagement = managedChats(store.db, options);
  app.route({
    method: ["GET", "POST"], url: "/v1/managed-chats",
    async handler(request, reply) {
      if (!authorized(request)) return reply.code(401).send({ error: "local runtime token required" });
      try {
        return request.method === "POST" ? await groupManagement.create(request.body) : await groupManagement.list();
      } catch (error) {
        if (!(error instanceof ManagedChatError)) throw error;
        return reply.code(error.status).send({ code: error.code, message: error.message, error: error.message });
      }
    }
  });
  return groupManagement;
}

export function disableManagedChatsPlugin(store: SqliteAgentStore): void {
  const ids = managedChatCapabilities.map(({ id }) => id);
  store.db.prepare(`DELETE FROM capabilities WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
}
