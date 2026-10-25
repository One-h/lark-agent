import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";

const execute = promisify(execFile);
const nameTtlMs = 60 * 60 * 1000;
const failureTtlMs = 5 * 60 * 1000;

export async function fetchGroupName(chatId: string): Promise<string> {
  const { stdout } = await execute("lark-cli", ["im", "chats", "get", "--as", "bot", "--chat-id", chatId, "--format", "json"], { timeout: 8000, maxBuffer: 256 * 1024 });
  const response = JSON.parse(stdout) as { ok?: boolean; data?: { name?: unknown } };
  if (response.ok === false || typeof response.data?.name !== "string" || !response.data.name.trim()) throw new Error("Group name unavailable");
  return response.data.name.trim().slice(0, 500);
}

export function createGroupNameCache(store: SqliteAgentStore, lookup = fetchGroupName, now = Date.now) {
  let pending: Promise<void> | null = null;
  let closed = false;
  return {
    refresh(): boolean {
      if (closed) return false;
      if (pending) return true;
      const groups = (store.db.prepare("SELECT DISTINCT chat_id FROM lark_messages WHERE chat_type='group' AND chat_id IS NOT NULL").all() as Array<{ chat_id: string }>)
        .filter(({ chat_id }) => /^oc_[A-Za-z0-9]+$/.test(chat_id) && !(Number(store.setting(`lark.chat.nextLookup:${chat_id}`, "0")) > now()))
        .slice(0, 100);
      if (!groups.length) return false;
      let next = 0;
      const worker = async () => {
        while (!closed && next < groups.length) {
          const { chat_id: chatId } = groups[next++];
          let ttl = failureTtlMs;
          try {
            const name = await lookup(chatId);
            if (closed) return;
            if (!name.trim()) throw new Error("Group name unavailable");
            store.setSetting(`lark.chat.name:${chatId}`, name);
            ttl = nameTtlMs;
          } catch {
            // Keep the last known name when the platform cannot be reached.
          }
          if (!closed) store.setSetting(`lark.chat.nextLookup:${chatId}`, String(now() + ttl));
        }
      };
      pending = Promise.all([worker(), worker()]).then(() => undefined).catch((error) => {
        console.warn(`Group name refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { pending = null; });
      return true;
    },
    async wait(): Promise<void> { await pending; },
    stop(): void { closed = true; }
  };
}
