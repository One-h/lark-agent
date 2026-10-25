import type Database from "better-sqlite3";
import { sendLarkAutoApprovalCard, larkReplyIdempotencyKey, type LarkAutoApprovalCardInput } from "@lark-agent/adapter-lark-cli";
import { config, db, nowIso } from "./context.js";

export type AutoApprovalNotificationSender = typeof sendLarkAutoApprovalCard;
let sender: AutoApprovalNotificationSender = sendLarkAutoApprovalCard;
let injectedSender = false;
const inFlight = new WeakMap<Database.Database, Set<number>>();
export function configureAutoApprovalNotificationSender(value?: AutoApprovalNotificationSender) {
  sender = value ?? sendLarkAutoApprovalCard;
  injectedSender = Boolean(value);
}

type NotificationPayload = { recipientId: string; card: LarkAutoApprovalCardInput };
export function queueTurnAutoApprovalNotification(reviewId: number): void {
  if (config.runtimeMode !== "active" && !injectedSender) return;
  const row = db.prepare(`SELECT r.*,m.content AS request,c.name AS requester
    FROM lark_turn_auto_reviews r LEFT JOIN lark_messages m ON m.id=r.lark_message_id
    LEFT JOIN lark_contacts c ON c.open_id=r.requester_id WHERE r.id=? AND r.decision='approved'
    AND r.applied_at IS NOT NULL AND r.source IN ('history','model')`).get(reviewId) as {
      id:number;lark_message_id:number;requester_id:string;approver_id:string;source:"history"|"model";
      request:string|null;requester:string|null;reason:string;model:string|null;matched_approval_id:number|null;applied_at:string;
    } | undefined;
  if (!row || !row.approver_id) return;
  const payload: NotificationPayload = { recipientId:row.approver_id,card: { reviewId:row.id,messageId:row.lark_message_id,
    requester:row.requester || row.requester_id,request:row.request ?? "",source:row.source,reason:row.reason,
    model:row.model,matchedApprovalId:row.matched_approval_id,appliedAt:row.applied_at } };
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO lark_delivery_outbox (lark_message_id,kind,payload,idempotency_key,next_attempt_at,created_at) VALUES (?,'auto-approval',?,?,?,?)")
    .run(row.lark_message_id,JSON.stringify(payload),larkReplyIdempotencyKey("autoapproval",`${row.id}:${row.approver_id}`),now,now);
}

export async function retryPendingAutoApprovalNotifications(limit = 10): Promise<number> {
  const database = db;
  if (!database?.open || (config.runtimeMode !== "active" && !injectedSender)) return 0;
  let active = inFlight.get(database);
  if (!active) { active=new Set(); inFlight.set(database,active); }
  const rows = database.prepare("SELECT id,payload,idempotency_key,attempts FROM lark_delivery_outbox WHERE kind='auto-approval' AND status='pending' AND next_attempt_at<=? ORDER BY id LIMIT ?")
    .all(nowIso(),limit) as Array<{id:number;payload:string;idempotency_key:string;attempts:number}>;
  let attempted = 0;
  const currentSender = sender;
  for (const row of rows) {
    if (active.has(row.id)) continue;
    const current=database.prepare("SELECT status,attempts,next_attempt_at FROM lark_delivery_outbox WHERE id=?").get(row.id) as {status:string;attempts:number;next_attempt_at:string}|undefined;
    if (!current || current.status!=="pending" || current.next_attempt_at>nowIso()) continue;
    active.add(row.id); attempted++;
    try {
      const payload = JSON.parse(row.payload) as NotificationPayload;
      if (!payload.recipientId || !payload.card?.reviewId) throw new Error("Invalid auto-approval notification payload");
      const sent = await currentSender(payload.recipientId,payload.card,row.idempotency_key);
      if (!database.open) continue;
      if (!sent.ok) throw new Error(sent.error);
      if (!sent.messageId) throw new Error("Auto-approval notification returned no message ID");
      database.prepare("UPDATE lark_delivery_outbox SET status='sent',sent_at=?,last_error=NULL,attempts=attempts+1 WHERE id=?")
        .run(nowIso(),row.id);
    } catch (error) {
      if (!database.open) continue;
      const attempts=current.attempts+1;
      database.prepare("UPDATE lark_delivery_outbox SET status=?,attempts=?,last_error=?,next_attempt_at=? WHERE id=?")
        .run(attempts>=8?"failed":"pending",attempts,(error instanceof Error?error.message:String(error)).slice(0,1000),
          new Date(Date.now()+Math.min(300_000,1000*2**(attempts-1))).toISOString(),row.id);
    } finally { active.delete(row.id); }
  }
  return attempted;
}
