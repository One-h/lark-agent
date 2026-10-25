import { spawnSync } from "node:child_process";
import type { InboundMessage } from "@lark-agent/core";

let cachedBotOpenId: string | null = null;
let botOpenIdRetryAt = 0;

function currentBotOpenId(): string | null {
  if (cachedBotOpenId) return cachedBotOpenId;
  if (Date.now() < botOpenIdRetryAt) return null;
  const result = spawnSync("lark-cli", ["auth", "status", "--json", "--verify"], { encoding: "utf8" });
  try {
    const status = JSON.parse(result.stdout) as { identities?: { bot?: { openId?: unknown; open_id?: unknown } } };
    const openId = status.identities?.bot?.openId ?? status.identities?.bot?.open_id;
    if (typeof openId === "string" && openId) { cachedBotOpenId = openId; return openId; }
  } catch { /* Group messages fail closed until the bot identity is available. */ }
  botOpenIdRetryAt = Date.now() + 5_000;
  return null;
}

function mentionOpenId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = value as { id?: unknown; open_id?: unknown; openId?: unknown };
  const nested = source.id && typeof source.id === "object" ? source.id as Record<string, unknown> : source as Record<string, unknown>;
  for (const candidate of [nested.open_id, nested.openId, nested.user_id, nested.userId, source.open_id, source.openId]) if (typeof candidate === "string" && candidate) return candidate;
  return null;
}

export function parseLarkEvent(value: unknown, botOpenId = currentBotOpenId()): InboundMessage | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>;
  const event = outer.event && typeof outer.event === "object" ? outer.event as Record<string, unknown> : outer;
  const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : event;
  const sender = event.sender && typeof event.sender === "object" ? event.sender as Record<string, unknown> : event;
  const senderIdObject = sender.sender_id && typeof sender.sender_id === "object" ? sender.sender_id as Record<string, unknown> : sender;
  const id = typeof message.message_id === "string" ? message.message_id : typeof event.message_id === "string" ? event.message_id : typeof event.id === "string" ? event.id : null;
  const chatId = typeof message.chat_id === "string" ? message.chat_id : typeof event.chat_id === "string" ? event.chat_id : null;
  const chatType = message.chat_type === "p2p" || event.chat_type === "p2p" ? "p2p" : message.chat_type === "group" || event.chat_type === "group" ? "group" : null;
  if (!id || !chatId || !chatType) return null;
  const senderType = sender.sender_type === "bot" || event.sender_type === "bot" ? "bot" : sender.sender_type === "user" || event.sender_type === "user" ? "user" : "unknown";
  const rawContent = typeof message.content === "string" ? message.content : typeof event.content === "string" ? event.content : "";
  let content = rawContent;
  if (message.message_type === "text" || event.message_type === "text") {
    try { const parsed = JSON.parse(rawContent) as { text?: unknown }; if (typeof parsed.text === "string") content = parsed.text; } catch { /* Local injection may use plain text. */ }
  }
  const mentions = Array.isArray(message.mentions) ? message.mentions : Array.isArray(event.mentions) ? event.mentions : [];
  const created = typeof event.create_time === "string" ? Number(event.create_time) : NaN;
  const inboundAt = Number.isFinite(created) ? new Date(created > 10_000_000_000 ? created : created * 1000).toISOString() : new Date().toISOString();
  return { platformMessageId: id, chatId, chatType, senderId: typeof senderIdObject.open_id === "string" ? senderIdObject.open_id : typeof sender.sender_id === "string" ? sender.sender_id : typeof event.sender_id === "string" ? event.sender_id : null, senderType, content, mentioned: chatType === "p2p" || Boolean(botOpenId && mentions.some((mention) => mentionOpenId(mention) === botOpenId)), reference: event.replied_message ?? message.parent_id ?? null, attachments: { messageType: message.message_type ?? event.message_type ?? null, content: rawContent }, inboundAt };
}
