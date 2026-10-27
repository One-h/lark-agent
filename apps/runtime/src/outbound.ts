import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import {
  larkAtTag,
  larkReplyIdempotencyKey,
  sendLarkTextMessage,
  sendLarkTextReply
} from "@lark-agent/adapter-lark-cli";
import { config as conversationConfig, recordOutboundLarkMessage } from "@lark-agent/conversation-runtime";

type OutboundInput = {
  text?: unknown;
  recipient?: unknown;
  replyToLarkMessageId?: unknown;
  idempotencyKey?: unknown;
};

export type OutboundSenders = {
  sendDirect: typeof sendLarkTextMessage;
  sendReply: typeof sendLarkTextReply;
  record: typeof recordOutboundLarkMessage;
};

const defaultSenders: OutboundSenders = {
  sendDirect: sendLarkTextMessage,
  sendReply: sendLarkTextReply,
  record: recordOutboundLarkMessage
};

function normalizedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizedIdempotencyKey(value: unknown, seed: string): string {
  const supplied = normalizedText(value, 50);
  if (supplied && /^[a-zA-Z0-9._:-]+$/.test(supplied)) return supplied;
  return larkReplyIdempotencyKey("host", seed);
}

function recordOutbound(senders: OutboundSenders, input: Parameters<typeof recordOutboundLarkMessage>[0]): void {
  try {
    senders.record(input);
  } catch (error) {
    console.error(`lark_outbound_record_failed source=${input.source} platformMessageId=${input.messageId} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveContact(store: SqliteAgentStore, recipient: string): { open_id: string; name: string; p2p_chat_id: string | null } | null {
  if (recipient.startsWith("ou_")) {
    const known = store.db.prepare("SELECT open_id, name, p2p_chat_id FROM contacts WHERE open_id=?").get(recipient) as { open_id: string; name: string; p2p_chat_id: string | null } | undefined;
    return known ?? { open_id: recipient, name: recipient, p2p_chat_id: null };
  }
  const row = store.db.prepare(`
    SELECT contacts.open_id, contacts.name, contacts.p2p_chat_id
    FROM contacts
    LEFT JOIN contact_aliases ON contact_aliases.open_id=contacts.open_id
    WHERE contacts.name=? OR contact_aliases.alias=?
    ORDER BY contacts.has_chatted DESC, contacts.updated_at DESC
    LIMIT 1
  `).get(recipient, recipient);
  return row ? row as { open_id: string; name: string; p2p_chat_id: string | null } : null;
}

export function sendHostOutboundMessage(
  store: SqliteAgentStore,
  input: OutboundInput,
  senders: OutboundSenders = defaultSenders
): { sent: true; recipient: string; messageId: string | null } {
  const text = normalizedText(input.text, 20_000);
  if (!text) throw new Error("text is required");

  const larkMessageId = Number(input.replyToLarkMessageId);
  if (Number.isSafeInteger(larkMessageId) && larkMessageId > 0) {
    const source = store.db.prepare(`
      SELECT lark_messages.message_id, lark_messages.chat_type, lark_messages.sender_id,
             lark_messages.chat_id, lark_contacts.name AS sender_name
      FROM lark_messages
      LEFT JOIN lark_contacts ON lark_contacts.open_id=lark_messages.sender_id
      WHERE lark_messages.id=?
    `).get(larkMessageId) as {
      message_id: string | null;
      chat_type: string | null;
      sender_id: string | null;
      chat_id: string | null;
      sender_name: string | null;
    } | undefined;
    if (!source?.message_id) throw new Error("source Lark message was not found");
    if (source.chat_type !== "p2p" && conversationConfig.groupPrivacyEnforced) throw new Error("Group replies require the privacy owner review queue");
    const mention = source.chat_type === "group" && /^ou_[a-zA-Z0-9]+$/.test(source.sender_id ?? "")
      ? `${larkAtTag(source.sender_id!, source.sender_name ?? "")} `
      : "";
    const key = normalizedIdempotencyKey(input.idempotencyKey, `reply:${larkMessageId}:${text}`);
    const sent = senders.sendReply(source.message_id, `${mention}${text}`, key);
    if (!sent.ok) throw new Error(sent.error);
    if (sent.messageId) {
      recordOutbound(senders, {
        messageId: sent.messageId,
        chatId: sent.chatId ?? source.chat_id,
        chatType: source.chat_type,
        recipientId: source.sender_id,
        content: `${mention}${text}`,
        replyToMessageId: source.message_id,
        messageAt: sent.messageAt,
        messageType: sent.messageType,
        source: "reply"
      });
    }
    return { sent: true, recipient: source.sender_name ?? source.sender_id ?? source.message_id, messageId: sent.messageId };
  }

  const recipient = normalizedText(input.recipient, 200);
  if (!recipient) throw new Error("recipient or replyToLarkMessageId is required");
  const contact = resolveContact(store, recipient);
  if (!contact) throw new Error(`Lark contact not found: ${recipient}`);
  const key = normalizedIdempotencyKey(input.idempotencyKey, `direct:${contact.open_id}:${text}`);
  const sent = senders.sendDirect(contact.open_id, text, key);
  if (!sent.ok) throw new Error(sent.error);
  if (sent.messageId) {
    recordOutbound(senders, {
      messageId: sent.messageId,
      chatId: sent.chatId ?? contact.p2p_chat_id,
      chatType: "p2p",
      recipientId: contact.open_id,
      content: text,
      replyToMessageId: null,
      messageAt: sent.messageAt,
      messageType: sent.messageType,
      source: "proactive"
    });
  }
  return { sent: true, recipient: contact.name, messageId: sent.messageId };
}

export function registerHostOutboundRoutes(
  app: FastifyInstance,
  store: SqliteAgentStore,
  authenticated: (request: FastifyRequest) => boolean,
  senders: OutboundSenders = defaultSenders
): void {
  app.post("/v1/internal/outbound", async (request, reply) => {
    if (!authenticated(request)) return reply.code(401).send({ error: "unauthorized" });
    try {
      return sendHostOutboundMessage(store, (request.body ?? {}) as OutboundInput, senders);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
