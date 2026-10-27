import type Database from "better-sqlite3";

const listeners = new WeakMap<Database.Database, Set<(turnId: string) => void>>();

export function waitForTurnAuthorization<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Authorization wait was cancelled"));
    if (signal.aborted) { void result.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function onLarkTurnEnded(database: Database.Database, listener: (turnId: string) => void): () => void {
  let current = listeners.get(database);
  if (!current) { current = new Set(); listeners.set(database, current); }
  current.add(listener);
  return () => { current.delete(listener); };
}

export function notifyLarkTurnEnded(database: Database.Database, turnId: string): void {
  for (const listener of listeners.get(database) ?? []) {
    try { listener(turnId); } catch { console.warn("lark_turn_cleanup_failed"); }
  }
}

export function hasLarkManualTurnApproval(database: Database.Database, input: {
  turnId: string; senderId: string | null; approverId: string | null | undefined; threadId?: string | null;
}): boolean {
  if (!input.turnId || !input.senderId || !input.approverId) return false;
  const native = database.prepare(`SELECT 1 FROM lark_execution_approvals
    WHERE turn_id=? AND requester_id=? AND approver_id=? AND approval_scope='turn'
      AND thread_id IS ? AND status='approved' AND card_message_id IS NOT NULL LIMIT 1`)
    .get(input.turnId, input.senderId, input.approverId, input.threadId ?? null);
  if (native) return true;
  return Boolean(database.prepare(`SELECT 1 FROM lark_capability_approvals a JOIN lark_messages m ON m.id=a.lark_message_id
    WHERE a.turn_id=? AND a.requester_id=? AND m.sender_id=a.requester_id AND a.thread_id IS ? AND m.codex_session_id IS a.thread_id
      AND a.approver_id=? AND a.approval_scope='turn'
      AND a.status='approved' AND a.card_message_id IS NOT NULL LIMIT 1`)
    .get(input.turnId, input.senderId, input.threadId ?? null, input.approverId));
}
