import { larkReplyIdempotencyKey } from "@lark-agent/adapter-lark-cli";
import { config, db, larkReactionSender, nowIso } from "./context.js";

type CompletionPayload = {
  messageId: string;
  turnId: string;
  targetId: number;
  afterTextKey?: string;
  mediaDeliveryIds: number[];
};
type CompletionRow = { id: number; lark_message_id: number; payload: string; attempts: number };

function deliverCompletion(row: CompletionRow): void {
  const stop = (reason: string) => db.prepare("UPDATE lark_delivery_outbox SET status='failed',last_error=? WHERE id=?").run(reason, row.id);
  const wait = () => db.prepare("UPDATE lark_delivery_outbox SET next_attempt_at=? WHERE id=?").run(new Date(Date.now() + 2_000).toISOString(), row.id);
  let payload: CompletionPayload;
  try { payload = JSON.parse(row.payload) as CompletionPayload; }
  catch { stop("Invalid completion reaction payload"); return; }
  if (!payload?.messageId || !payload.turnId || !Array.isArray(payload.mediaDeliveryIds)) { stop("Invalid completion reaction payload"); return; }
  const message = db.prepare("SELECT codex_status,codex_turn_id FROM lark_messages WHERE id=?").get(row.lark_message_id) as { codex_status: string; codex_turn_id: string } | undefined;
  if (!message || message.codex_turn_id !== payload.turnId || !["answered", "no_reply"].includes(message.codex_status)) {
    stop("Completion was superseded or task did not complete successfully");
    return;
  }
  const target = db.prepare("SELECT codex_turn_id,reply_delivery_key,reply_status FROM lark_messages WHERE id=?").get(payload.targetId) as { codex_turn_id: string; reply_delivery_key: string | null; reply_status: string } | undefined;
  if (!target || target.codex_turn_id !== payload.turnId) { stop("Response target was superseded"); return; }
  if (payload.afterTextKey) {
    if (target.reply_delivery_key !== payload.afterTextKey || target.reply_status === "failed") {
      stop("Final reply failed or was superseded");
      return;
    }
    if (target.reply_status !== "sent") { wait(); return; }
  }
  for (const id of payload.mediaDeliveryIds) {
    const media = db.prepare("SELECT status FROM lark_delivery_outbox WHERE id=? AND lark_message_id=? AND kind IN ('media','image-post')").get(id, payload.targetId) as { status: string } | undefined;
    if (!media || media.status === "failed") {
      stop("Final attachment delivery failed");
      return;
    }
    if (media.status !== "sent") { wait(); return; }
  }
  let sent;
  try { sent = larkReactionSender(payload.messageId, "DONE"); }
  catch (error) { sent = { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  if (sent.ok) {
    db.prepare("UPDATE lark_delivery_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?").run(nowIso(), row.id);
  } else {
    const attempts = row.attempts + 1;
    const delay = Math.min(300_000, 1_000 * 2 ** (attempts - 1));
    db.prepare("UPDATE lark_delivery_outbox SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?")
      .run(attempts >= 8 ? "failed" : "pending", attempts, new Date(Date.now() + delay).toISOString(), sent.error, row.id);
    console.warn(`lark_completion_reaction_failed messageId=${row.lark_message_id} attempt=${attempts}`);
  }
}

export function queueLarkCompletionReactions(
  messages: Array<{ id: number; messageId: string }>,
  turnId: string,
  targetId: number,
  afterTextKey: string | undefined,
  mediaDeliveryIds: number[]
): void {
  if (config.runtimeMode !== "active") return;
  const createdAt = nowIso();
  const insert = db.prepare("INSERT OR IGNORE INTO lark_delivery_outbox (lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at) VALUES (?,'completion-reaction',?,?,?,?)");
  db.transaction(() => {
    for (const { id, messageId } of messages) {
      const payload: CompletionPayload = { messageId, turnId, targetId, afterTextKey, mediaDeliveryIds };
      insert.run(id, JSON.stringify(payload), larkReplyIdempotencyKey("codexdone", `${turnId}:${messageId}`), createdAt, createdAt);
    }
  })();
  retryPendingLarkCompletionReactions();
}

export function retryPendingLarkCompletionReactions(limit = 10): number {
  if (config.runtimeMode !== "active") return 0;
  const rows = db.prepare("SELECT id,lark_message_id,payload,attempts FROM lark_delivery_outbox WHERE kind='completion-reaction' AND status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?").all(nowIso(), limit) as CompletionRow[];
  for (const row of rows) deliverCompletion(row);
  return rows.length;
}
