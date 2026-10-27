import type Database from "better-sqlite3";

export type ApprovalTaskContext = Array<{ messageId: number; request: string; result: string }>;

export function loadApprovalTaskContext(database: Database.Database, messageId: number, senderId: string | null): ApprovalTaskContext {
  if (!senderId) return [];
  const current = database.prepare("SELECT chat_id,sender_id,codex_session_id,thread_id,received_at FROM lark_messages WHERE id=?")
    .get(messageId) as { chat_id: string; sender_id: string; codex_session_id: string | null; thread_id: string | null; received_at: string } | undefined;
  if (!current?.codex_session_id || current.sender_id !== senderId) return [];
  const time = Date.parse(current.received_at);
  if (!Number.isFinite(time)) return [];
  const rows = database.prepare(`SELECT id,content,codex_reply FROM lark_messages
    WHERE chat_id=? AND sender_id=? AND codex_session_id=? AND COALESCE(thread_id,'')=COALESCE(?,'')
      AND id<? AND received_at>=? AND received_at<=? AND direction='inbound' AND COALESCE(sender_type,'user')='user'
    ORDER BY id DESC LIMIT 6`).all(current.chat_id, senderId, current.codex_session_id, current.thread_id,
      messageId, new Date(time - 6 * 60 * 60 * 1000).toISOString(), current.received_at) as Array<{ id: number; content: string | null; codex_reply: string | null }>;
  let remaining = 2400;
  const selected: ApprovalTaskContext = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const request = (row.content ?? "").slice(0, Math.min(300, remaining));
    remaining -= request.length;
    const result = (row.codex_reply ?? "").slice(0, Math.min(100, remaining));
    remaining -= result.length;
    selected.unshift({ messageId: row.id, request, result });
  }
  return selected;
}

export function formatApprovalTaskContext(context: ApprovalTaskContext): string {
  return context.map(row => `[历史请求 L${row.messageId}] ${row.request}${row.result ? `；当时结果：${row.result}` : ""}`).join("\n");
}
