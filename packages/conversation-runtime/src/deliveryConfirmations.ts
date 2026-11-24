import type Database from "better-sqlite3";
import { publishLarkTurnObservation, type LarkTurnObservation } from "./turnObservations.js";

type Confirmation = Extract<LarkTurnObservation, { kind: "delivery.confirmed" }>;
type Store = Database.Database;
const select = `SELECT id AS eventId,delivery_kind AS deliveryKind,source_message_id AS sourceMessageId,
  turn_id AS runId,turn_id AS turnId,thread_id AS threadId,confirmation,confirmed_at AS confirmedAt
  FROM lark_delivery_confirmations`;
const event = (row: Omit<Confirmation, "kind">) => Object.freeze({ kind: "delivery.confirmed" as const, ...row });

// Within the owning delivery transaction. Publication is left to the caller
// after commit. An observer record failure cannot cause an external retry.
export function recordLarkDeliveryConfirmation(database: Store, input: {
  messageId: number; receipt: string | null | undefined; deliveryKind: Confirmation["deliveryKind"];
  confirmation: Confirmation["confirmation"]; confirmedAt: string; expectedTurnId?: string
}): Confirmation | undefined {
  if (!input.receipt) return;
  try {
    const binding = database.prepare(`SELECT COALESCE(e.turn_id,m.codex_turn_id) AS turnId,
      COALESCE(e.session_id,m.codex_session_id) AS threadId FROM lark_messages m
      LEFT JOIN lark_topic_engine_runs e ON e.lark_message_id=m.id WHERE m.id=? AND m.direction='inbound'`)
      .get(input.messageId) as { turnId: string | null; threadId: string | null } | undefined;
    if (!binding?.turnId || !binding.threadId || input.expectedTurnId && binding.turnId !== input.expectedTurnId) return;
    const added = database.prepare(`INSERT OR IGNORE INTO lark_delivery_confirmations
      (delivery_kind,platform_receipt,source_message_id,turn_id,thread_id,confirmation,confirmed_at) VALUES(?,?,?,?,?,?,?)`)
      .run(input.deliveryKind,input.receipt,input.messageId,binding.turnId,binding.threadId,input.confirmation,input.confirmedAt);
    if (added.changes) return event({ eventId: Number(added.lastInsertRowid), deliveryKind: input.deliveryKind,
      sourceMessageId: input.messageId, runId: binding.turnId, turnId: binding.turnId, threadId: binding.threadId,
      confirmation: input.confirmation, confirmedAt: input.confirmedAt });
  } catch { console.warn("lark_delivery_confirmation_record_failed"); }
}

export function publishLarkDeliveryConfirmation(database: Store, confirmed?: Confirmation): void {
  if (confirmed) publishLarkTurnObservation(database, confirmed);
}

// Trusted durable consumers own their checkpoint and deduplicate eventId.
export function readLarkDeliveryConfirmations(database: Store, after: number, limit = 100): readonly Confirmation[] {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Invalid Lark delivery confirmation cursor");
  }
  const rows = database.prepare(select + " WHERE id>? ORDER BY id LIMIT ?").all(after, limit) as Omit<Confirmation, "kind">[];
  return rows.map(event);
}
