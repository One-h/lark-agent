import type Database from "better-sqlite3";
import { readNativeTurnState, type NativeTurnState } from "./nativeTurnState.js";

export const larkUncertainExecution = "运行时中断，系统将按引擎和操作凭证尝试恢复；不重跑未证实安全的操作。";
export const uncertainDelivery = "运行时中断，未能确认飞书投递结果；系统将核对已有回复，不重发未证实安全的投递。";
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

export function reconcileLarkCrash(database: Database.Database, at: string, retainHostTurns = false, retainNativeTurns = false): void {
  database.transaction(() => {
    // A stale card can never approve a request in a different runtime.
    database.prepare(`UPDATE lark_execution_approvals SET status='failed',card_error=?,decided_at=?
      WHERE status='pending'`).run(interruptedApproval, at);
    database.prepare(`UPDATE lark_capability_approvals SET status='failed',error=?,decided_at=?
      WHERE status='pending' AND NOT EXISTS (
        SELECT 1 FROM lark_retained_approval_links link WHERE link.approval_id=lark_capability_approvals.id
          AND link.turn_id=lark_capability_approvals.turn_id AND (
            (?=1 AND EXISTS(SELECT 1 FROM lark_retained_turns turn WHERE turn.turn_id=link.turn_id AND turn.finalized=0
              AND turn.message_id=lark_capability_approvals.lark_message_id))
            OR (?=1 AND EXISTS(SELECT 1 FROM lark_native_socket_turns turn WHERE turn.turn_id=link.turn_id
              AND turn.message_id=lark_capability_approvals.lark_message_id)))
      )`).run(interruptedApproval, at, Number(retainHostTurns), Number(retainNativeTurns));
    const inFlightCalls = database.prepare("SELECT DISTINCT lark_message_id FROM lark_capability_invocations WHERE status='running'")
      .pluck().all() as number[];
    for (const id of inFlightCalls) quarantineLarkExecution(database, id, at);
    database.prepare(`UPDATE lark_capability_invocations SET status='failed',error=?,finished_at=?
      WHERE status='running'`).run(larkUncertainExecution, at);

    const messages = database.prepare(`SELECT id,codex_dispatch_phase phase,codex_dispatch_context context,reply_trigger
      FROM lark_messages WHERE codex_status IN ('queued','running') AND (?=0 OR NOT EXISTS (
        SELECT 1 FROM lark_retained_turns turn WHERE turn.message_id=lark_messages.id AND turn.turn_id=lark_messages.codex_turn_id
        AND turn.finalized=0 AND lark_messages.codex_dispatch_phase='submitted'
      )) AND (?=0 OR NOT EXISTS (
        SELECT 1 FROM lark_native_socket_turns turn WHERE turn.message_id=lark_messages.id AND turn.turn_id=lark_messages.codex_turn_id
        AND turn.thread_id=lark_messages.codex_session_id AND lark_messages.codex_dispatch_phase='submitted'
      ))`).all(Number(retainHostTurns), Number(retainNativeTurns)) as Array<{ id: number; phase: string | null; context: string | null; reply_trigger: string }>;
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
type InterruptedTurn = { id: number; threadId: string; turnId: string };
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function readCompleteTurnItems(request: Request, row: Pick<InterruptedTurn, "threadId" | "turnId">): Promise<Record<string, unknown>[] | undefined> {
  const result = await request("thread/items/list", { threadId: row.threadId, turnId: row.turnId, sortDirection: "asc", limit: 50 }) as {
    data?: Array<{ turnId?: string; item?: Record<string, unknown> }>; nextCursor?: string | null
  } | null;
  if (result?.nextCursor !== null || !Array.isArray(result.data) || !result.data.length
    || result.data.some(entry => !entry || entry.turnId !== row.turnId || !entry.item || typeof entry.item.type !== "string")) return;
  return result.data.map(entry => entry.item!);
}

export async function reconcileInterruptedNativeTurns(database: Database.Database, request: Request,
  restore?: (row: InterruptedTurn, status: NativeTurnState["status"], items: Record<string, unknown>[]) => boolean): Promise<void> {
  if (probes.has(database)) return;
  probes.add(database);
  try {
    const rows = database.prepare(`SELECT id,codex_session_id threadId,codex_turn_id turnId FROM lark_messages
      WHERE codex_dispatch_phase='needs_review' AND codex_dispatch_context IS NOT NULL
        AND (codex_recovery_engine_status IS NULL OR codex_recovery_engine_status IN ('active','unknown'))
        AND codex_recovery_checks<6 AND (codex_recovery_checked_at IS NULL OR codex_recovery_checked_at<=?)
        AND codex_session_id IS NOT NULL AND codex_turn_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM lark_topic_engine_runs WHERE lark_message_id=lark_messages.id)
      ORDER BY id LIMIT 20`).all(new Date(Date.now()-20_000).toISOString()) as InterruptedTurn[];
    for (const row of rows) {
      let status: NativeTurnState["status"] = "unknown";
      let items: Record<string, unknown>[] | undefined;
      try {
        status = (await readNativeTurnState(request, row.threadId, row.turnId)).status;
        if (restore && ["completed", "failed", "interrupted"].includes(status)) items = await readCompleteTurnItems(request, row);
      } catch {}
      if (!database.open) return;
      database.transaction(() => {
        const updated = database.prepare(`UPDATE lark_messages SET codex_recovery_engine_status=?,
          codex_recovery_checks=codex_recovery_checks+1,codex_recovery_checked_at=?
        WHERE id=? AND codex_dispatch_phase='needs_review' AND codex_session_id=? AND codex_turn_id=?`)
          .run(status, new Date().toISOString(), row.id, row.threadId, row.turnId);
        if (!updated.changes) return;
        if (items && restore?.(row, status, items)) return;
        database.prepare("UPDATE lark_messages SET codex_error=? WHERE id=? AND codex_dispatch_phase='needs_review'").run(
          status === "active" ? "引擎证实原回合仍活动，但当前连接不能接管原回合与审批，未重启任务。" :
            items?.some(item => /(?:Execution|ToolCall|Change)/.test(String(item.type)))
              ? "系统查到原回合有命令或工具记录，但没有可验证的下游完成凭证，未重复执行原操作。"
              : !items ? "系统未取得可以绑定到原回合的完整引擎记录，未重复执行原操作。"
              : "系统已读到原回合记录，但不满足安全续交付或限次重试的条件，未重复执行原操作。", row.id);
      })();
    }
  } finally { probes.delete(database); }
}
