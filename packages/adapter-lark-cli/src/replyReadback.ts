import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { jsonFromCliOutput } from "./reply.js";

const exec = promisify(execFile);
export type LarkReplyReadbackInput = {
  chatId: string; threadId: string | null; replyTo: string; attemptedAt: string;
  msgType: string; content: unknown;
};
export type LarkReplyReadbackReceipt = { messageId: string; sentAt: string };

export function matchLarkReplyReceipt(input: LarkReplyReadbackInput, messages: unknown[],
  bot: { appId: string; openId: string }): LarkReplyReadbackReceipt | undefined {
  const started = Date.parse(input.attemptedAt);
  const matches = messages.flatMap(message => {
    const row = message as { message_id?: string; chat_id?: string; parent_id?: string; msg_type?: string; create_time?: string;
      sender?: { sender_type?: string; id_type?: string; id?: string }; body?: { content?: string }; deleted?: boolean; updated?: boolean } | null;
    const sender = row?.sender;
    const created = Number(row?.create_time);
    if (!row || row.chat_id !== input.chatId || row.parent_id !== input.replyTo || row.msg_type !== input.msgType
      || row.deleted !== false || row.updated === true || !/^om_[A-Za-z0-9]+$/.test(row.message_id ?? "")
      || sender?.sender_type !== "app" || !((sender.id_type === "app_id" && sender.id === bot.appId)
        || (sender.id_type === "open_id" && sender.id === bot.openId))
      || !Number.isFinite(started) || !Number.isFinite(created) || created < started || created > started+600_000
      || typeof row.body?.content !== "string") return [];
    try {
      return isDeepStrictEqual(JSON.parse(row.body.content), input.content)
        ? [{ messageId: row.message_id!, sentAt: new Date(created).toISOString() }] : [];
    } catch { return []; }
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readLarkReplyReceipt(input: LarkReplyReadbackInput, signal?: AbortSignal): Promise<LarkReplyReadbackReceipt | undefined> {
  const started = Date.parse(input.attemptedAt);
  if (!Number.isFinite(started) || started > Date.now() || !/^oc_[A-Za-z0-9]+$/.test(input.chatId)
    || !/^om_[A-Za-z0-9]+$/.test(input.replyTo) || input.threadId && !/^omt_[A-Za-z0-9]+$/.test(input.threadId)) return;
  const options = { signal, timeout: 6000, maxBuffer: 512 * 1024 };
  const auth = jsonFromCliOutput((await exec("lark-cli", ["auth","status","--json","--verify"], options)).stdout) as
    { verified?: boolean; appId?: string; identities?: { bot?: { openId?: string; verified?: boolean } } } | null;
  const bot = auth?.identities?.bot;
  if (auth?.verified !== true || bot?.verified !== true || !/^cli_[A-Za-z0-9]+$/.test(auth.appId ?? "")
    || !/^ou_[A-Za-z0-9]+$/.test(bot.openId ?? "")) return;
  // Raw GET preserves quoted parent and exact message body, unlike compact history.
  const messages: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const params = { container_id_type: input.threadId ? "thread" : "chat", container_id: input.threadId ?? input.chatId,
      start_time: String(Math.floor(started/1000)), end_time: String(Math.ceil(Math.min(Date.now(),started+600_000)/1000)),
      page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) };
    const result = jsonFromCliOutput((await exec("lark-cli",
      ["api","GET","/open-apis/im/v1/messages","--as","bot","--params",JSON.stringify(params)],options)).stdout) as
      { ok?: boolean; identity?: string; data?: { items?: unknown[]; has_more?: boolean; page_token?: string } } | null;
    if (result?.ok !== true || result.identity !== "bot" || !Array.isArray(result.data?.items)) return;
    messages.push(...result.data.items);
    if (result.data.has_more === false) return matchLarkReplyReceipt(input, messages, { appId: auth.appId!, openId: bot.openId! });
    if (result.data.has_more !== true || typeof result.data.page_token !== "string" || !result.data.page_token || result.data.page_token === pageToken) return;
    pageToken = result.data.page_token;
  }
}
