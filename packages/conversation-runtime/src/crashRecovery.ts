import type Database from "better-sqlite3";
import { readNativeTurnState } from "./nativeTurnState.js";

export const larkUncertainExecution = "运行时中断，无法确认本轮操作结果；请先核对实际结果，不会自动重跑。";
const uncertainDelivery = "运行时中断，未能确认飞书投递结果；请核对原会话，不会自动重发。";
const interruptedApproval = "运行时已重启，原审批请求已失效；不代表人工拒绝。";

export function quarantineLarkExecution(database: Database.Database, id: number, at: string): number {
  return database.prepare(`UPDATE lark_messages SET codex_status='failed',codex_dispatch_phase='needs_review',
    codex_error=?,codex_finished_at=?,codex_last_heartbeat_at=NULL,
    codex_reply=CASE WHEN reply_delivery_key IS NULL THEN NULL ELSE codex_reply END,
    reply_status=CASE WHEN reply_status='pending' AND reply_delivery_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM lark_delivery_outbox WHERE lark_message_id=lark_messages.id AND kind IN ('media','image-post')
        AND status IN ('pending','sending','sent')) THEN 'failed' ELSE reply_status END,
    reply_error=CASE WHEN reply_status='pending' AND reply_delivery_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM lark_delivery_outbox WHERE lark_message_id=lark_messages.id AND kind IN ('media','image-post')
        AND status IN ('pending','sending','sent')) THEN ? ELSE reply_error END
    WHERE id=? AND codex_status IN ('queued','running')`).run(larkUncertainExecution, at, larkUncertainExecution, id).changes;
}

export function reconcileLarkCrash(database: Database.Database, at: string): void {
  database.transaction(() => {
    // A stale card can never approve a request in a different runtime.
    database.prepare(`UPDATE lark_execution_approvals SET status='failed',card_error=?,decided_at=?
      WHERE status='pending'`).run(interruptedApproval, at);
    database.prepare(`UPDATE lark_capability_approvals SET status='failed',error=?,decided_at=?
      WHERE status='pending'`).run(interruptedApproval, at);
    const inFlightCalls = database.prepare("SELECT DISTINCT lark_message_id FROM lark_capability_invocations WHERE status='running'")
      .pluck().all() as number[];
    for (const id of inFlightCalls) quarantineLarkExecution(database, id, at);
    database.prepare(`UPDATE lark_capability_invocations SET status='failed',error=?,finished_at=?
      WHERE status='running'`).run(larkUncertainExecution, at);

    const messages = database.prepare(`SELECT id,codex_dispatch_phase phase,codex_dispatch_context context,reply_trigger
      FROM lark_messages WHERE codex_status IN ('queued','running')`).all() as Array<{ id: number; phase: string | null; context: string | null; reply_trigger: string }>;
    const requeue = database.prepare(`UPDATE lark_messages SET codex_status='queued',codex_dispatch_phase='queued',
      codex_reply=NULL,codex_error=NULL,codex_started_at=NULL,codex_finished_at=NULL,
      codex_last_heartbeat_at=NULL,codex_runner_generation=NULL,codex_turn_id=NULL,codex_session_id=NULL
      WHERE id=?`);
    for (const { id, phase, context, reply_trigger } of messages) {
      // Owner assistance has a separate restart policy that invalidates its draft/consent context.
      if (reply_trigger !== "owner_mention" && context && (phase === "queued" || phase === "preparing")) requeue.run(id);
      else quarantineLarkExecution(database, id, at);
    }

    // A committed outbound receipt wins. Without one, suppress replay after an
    // attempted delivery rather than assuming the provider's dedupe still applies.
    database.prepare(`UPDATE lark_messages SET reply_status='sent',reply_error=NULL,reply_next_attempt_at=NULL
      WHERE reply_status='pending' AND reply_delivery_key IS NOT NULL AND reply_sent_at IS NOT NULL`).run();
    database.prepare(`UPDATE lark_messages SET reply_status='failed',reply_error=?,reply_next_attempt_at=NULL
      WHERE reply_status='pending' AND reply_delivery_key IS NOT NULL
        AND reply_send_stage IS NOT 'queued'`).run(uncertainDelivery);
    const media = database.prepare(`SELECT DISTINCT lark_message_id FROM lark_delivery_outbox
      WHERE kind IN ('media','image-post') AND status='pending' AND send_stage IS NOT 'queued'`).pluck().all() as number[];
    database.prepare(`UPDATE lark_delivery_outbox SET status='failed',last_error=?
      WHERE kind IN ('media','image-post','media-notice') AND status='pending' AND send_stage IS NOT 'queued'`).run(uncertainDelivery);
    database.prepare(`UPDATE lark_execution_receipts SET delivery_status='failed',delivery_error=?,updated_at=?
      WHERE delivery_status='pending' AND send_stage IS NOT 'queued'`).run(uncertainDelivery, at);
    for (const id of media) database.prepare(`UPDATE lark_messages SET reply_error=?,
      reply_status=CASE WHEN reply_delivery_key IS NULL AND reply_status='pending' THEN 'failed' ELSE reply_status END WHERE id=?`).run(uncertainDelivery, id);
  })();
}

const probes = new WeakSet<Database.Database>();

export async function reconcileInterruptedNativeTurns(database: Database.Database,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  if (probes.has(database)) return;
  probes.add(database);
  try {
    const rows = database.prepare(`SELECT id,codex_session_id threadId,codex_turn_id turnId FROM lark_messages
      WHERE codex_dispatch_phase='needs_review' AND codex_dispatch_context IS NOT NULL
        AND codex_recovery_engine_status IS NULL AND codex_session_id IS NOT NULL AND codex_turn_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM lark_topic_engine_runs WHERE lark_message_id=lark_messages.id)
      ORDER BY id LIMIT 20`).all() as Array<{ id: number; threadId: string; turnId: string }>;
    for (const row of rows) {
      // A fresh App Server can read the old turn, but does not own its live callbacks.
      // Readback cannot certify business effects or reconstruct our delivery plan.
      let status = "unknown";
      try { status = (await readNativeTurnState(request, row.threadId, row.turnId)).status; } catch {}
      if (!database.open) return;
      database.prepare(`UPDATE lark_messages SET codex_recovery_engine_status=?
        WHERE id=? AND codex_dispatch_phase='needs_review' AND codex_session_id=? AND codex_turn_id=?`)
        .run(status, row.id, row.threadId, row.turnId);
    }
  } finally { probes.delete(database); }
}
