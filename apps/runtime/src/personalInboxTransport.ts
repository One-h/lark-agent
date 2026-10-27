import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type PersonalMessage = {
  messageId: string; chatId: string; chatType: "p2p" | "group"; chatName: string;
  senderId: string; senderName: string; content: string; sourceTime: string; messageType: string; replyTo?: string; rootId?: string;
};
export class LarkInboxError extends Error {
  constructor(message: string, readonly subtype = "unknown") { super(message); }
}
export interface PersonalInboxTransport {
  identity(): Promise<{ ownerId: string; botId: string; canSend: boolean }>;
  collect(start: string, end: string, ownerId: string): Promise<PersonalMessage[]>;
  ownerReplied(message: PersonalMessage, ownerId: string): Promise<boolean>;
  send(message: PersonalMessage, text: string, key: string): Promise<string>;
  notify(ownerId: string, text: string, key: string): Promise<void>;
}

export async function inboxCli(args: string[]): Promise<any> {
  try {
    const { stdout } = await execute("lark-cli", args, {
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" }
    });
    const result = JSON.parse(stdout);
    if (result.ok === false) throw new LarkInboxError(result.error?.message ?? "Lark request failed", result.error?.subtype);
    return result;
  } catch (error) {
    if (error instanceof LarkInboxError) throw error;
    const detail = error as { stderr?: string };
    try {
      const result = JSON.parse(detail.stderr ?? "");
      if (result.error) throw new LarkInboxError(result.error.message ?? "Lark request failed", result.error.subtype);
    } catch (parsed) { if (parsed instanceof LarkInboxError) throw parsed; }
    // Do not surface stdout, command arguments or private message bodies in errors.
    throw new LarkInboxError("飞书请求失败或超时，请检查授权和网络。");
  }
}

export function normalizePersonalMessage(row: any, chatType: "p2p" | "group", ownerId: string): PersonalMessage | null {
  const sender = row.sender;
  if (row.deleted || sender?.sender_type !== "user" || sender.id === ownerId
    || !/^om_[A-Za-z0-9]+$/.test(row.message_id ?? "") || !/^oc_[A-Za-z0-9]+$/.test(row.chat_id ?? "")
    || !/^ou_[A-Za-z0-9]+$/.test(sender.id ?? "")) return null;
  // --is-at-me also matches @all. Only a direct mention of this account belongs here.
  if (chatType === "group" && !row.mentions?.some((item: any) => item.id === ownerId)) return null;
  return {
    messageId: row.message_id, chatId: row.chat_id, chatType,
    chatName: String(row.chat_name ?? row.chat_partner?.name ?? ""),
    senderId: sender.id, senderName: String(sender.name ?? sender.id),
    content: String(row.content ?? "").slice(0, 20_000), sourceTime: String(row.create_time ?? ""),
    replyTo: row.reply_to ?? row.parent_id, rootId: row.root_id,
    messageType: String(row.msg_type ?? "unknown")
  };
}

export function createPersonalInboxTransport(): PersonalInboxTransport {
  return {
    async identity() {
      const result = await inboxCli(["auth", "status", "--json", "--verify"]);
      const user = result.identities?.user;
      if (!user?.verified || !/^ou_[A-Za-z0-9]+$/.test(user.openId ?? "")) throw new LarkInboxError("个人账号未登录或验证失败。", "missing_token");
      const scopes = new Set(String(user.scope ?? "").split(/\s+/));
      const required = ["im:message.p2p_msg:get_as_user", "im:message.group_msg:get_as_user", "search:message"];
      if (required.some(scope => !scopes.has(scope))) throw new LarkInboxError("个人消息读取或搜索权限不完整。", "missing_scope");
      return { ownerId: user.openId, botId: String(result.identities?.bot?.openId ?? ""),
        canSend: scopes.has("im:message.send_as_user") && scopes.has("im:message") };
    },
    async collect(start, end, ownerId) {
      const messages: PersonalMessage[] = [];
      for (const chatType of ["p2p", "group"] as const) {
        let token = "";
        for (let page = 0; ; page++) {
          if (page >= 100) throw new LarkInboxError("本轮消息过多，尚未完整采集；游标保留，等待处理。");
          const args = ["im", "+messages-search", "--as", "user", "--chat-type", chatType,
            "--sender-type", "user", "--start", start.replace(/\.\d{3}Z$/, "Z"), "--end", end.replace(/\.\d{3}Z$/, "Z"), "--page-size", "50", "--no-reactions"];
          if (chatType === "group") args.push("--is-at-me");
          if (token) args.push("--page-token", token);
          const { data } = await inboxCli(args);
          if (!Array.isArray(data?.messages)) throw new LarkInboxError("飞书消息搜索返回了无法识别的结果。");
          for (const row of data.messages) {
            const message = normalizePersonalMessage(row, chatType, ownerId);
            if (message) messages.push(message);
          }
          if (!data.has_more) break;
          if (!data.page_token || data.page_token === token) throw new LarkInboxError("消息分页未完成，游标未推进。");
          token = data.page_token;
        }
      }
      // Search results may omit reply_to. Fetch explicit references before routing.
      for (let offset = 0; offset < messages.length; offset += 50) {
        const batch = messages.slice(offset, offset + 50);
        const { data } = await inboxCli(["im", "+messages-mget", "--as", "user", "--message-ids", batch.map(row => row.messageId).join(","), "--no-reactions"]);
        if (!Array.isArray(data?.messages)) throw new LarkInboxError("无法读取消息引用关系，游标未推进。");
        const references = new Map<string, any>(data.messages.map((row: any) => [row.message_id, row]));
        for (const message of batch) {
          const row = references.get(message.messageId);
          if (!row) throw new LarkInboxError("部分消息引用未完整读取，游标未推进。");
          message.replyTo = row.reply_to ?? row.parent_id;
          message.rootId = row.root_id;
        }
      }
      return messages;
    },
    async ownerReplied(message, ownerId) {
      const { data } = await inboxCli(["im", "+chat-messages-list", "--as", "user", "--chat-id", message.chatId,
        "--order", "desc", "--page-size", "50", "--no-reactions"]);
      const rows = data?.messages;
      if (!Array.isArray(rows)) throw new LarkInboxError("无法确认你是否已经回复，暂不发送。");
      const source = rows.findIndex((row: any) => row.message_id === message.messageId);
      if (source < 0) throw new LarkInboxError("原消息不在最近记录中，请人工确认是否仍需回复。");
      return rows.slice(0, source).some((row: any) => row.sender?.id === ownerId);
    },
    async send(message, text, key) {
      const { data } = await inboxCli(["im", "+messages-reply", "--as", "user", "--message-id", message.messageId,
        "--text", text, "--idempotency-key", key]);
      if (!data?.message_id) throw new LarkInboxError("未取得发送回执，请人工核对，避免重复发送。");
      return data.message_id;
    },
    async notify(ownerId, text, key) {
      await inboxCli(["im", "+messages-send", "--as", "bot", "--user-id", ownerId, "--text", text, "--idempotency-key", key]);
    }
  };
}
