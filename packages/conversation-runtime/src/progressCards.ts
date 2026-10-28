import type Database from "better-sqlite3";
import { larkReplyIdempotencyKey, type LarkProgressContent, type LarkProgressEntry, type LarkProgressState } from "@lark-agent/adapter-lark-cli";
import { config, db, getAppSettings, larkProgressSender, larkProgressUpdater, nowIso, recordOutboundLarkMessage, type LarkMessageRow } from "./context.js";

type ProgressRow = { progress_id: string; native_turn_id: string; thread_id: string; lark_message_id: number; message_id: string;
  card_message_id: string | null; entries_json: string; state: LarkProgressState; version: number; delivered_version: number;
  pending: number; create_attempted: number; attempts: number; next_attempt_at: string };
const inFlight = new WeakMap<Database.Database, Map<string, Promise<void>>>();
const updateIntervalMs = 10_000;
const maxAttempts = 5;
function tasks(database = db) {
  let map = inFlight.get(database);
  if (!map) { map = new Map(); inFlight.set(database, map); }
  return map;
}
function row(database: Database.Database, id: string) { return database.prepare("SELECT * FROM lark_progress_cards WHERE progress_id=?").get(id) as ProgressRow | undefined; }
function textOf(entries: LarkProgressEntry[], state: LarkProgressState) { return `[任务进度 · ${state}]\n${entries.map(e => e.text).join("\n")}`; }

export function queueLarkProgressUpdate(input: { progressId: string; turnId: string; threadId: string; source: LarkMessageRow; eventId: string; text: string }): boolean {
  try {
  if (config.runtimeMode !== "active" || !getAppSettings().larkCodexInterimRepliesEnabled || input.source.sender_type === "bot"
    || config.groupPrivacyEnforced && input.source.chat_type !== "p2p" || !input.source.message_id) return false;
  const text = input.text.trim().replace(/\s+/g, " ").slice(0, 180);
  if (!text) return false;
  const previous = row(db, input.progressId);
  if (previous && previous.state !== "running") return false;
  const entries = previous ? JSON.parse(previous.entries_json) as LarkProgressEntry[] : [];
  if (entries.some(e => e.id === input.eventId || e.text === text)) return false;
  const now = nowIso();
  entries.push({ id: input.eventId, text, at: now });
  db.prepare(`INSERT INTO lark_progress_cards(progress_id,native_turn_id,thread_id,lark_message_id,message_id,entries_json,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(progress_id) DO UPDATE SET native_turn_id=excluded.native_turn_id,thread_id=excluded.thread_id,
    entries_json=excluded.entries_json,version=version+1,pending=1,updated_at=excluded.updated_at`).run(input.progressId, input.turnId, input.threadId,
    input.source.id, input.source.message_id, JSON.stringify(entries.slice(-5)), now, now, now);
  void retryPendingLarkProgressCards();
  return true;
  } catch { console.warn("lark_progress_store_failed"); return false; }
}

export function finishLarkProgressCard(progressId: string, state: Exclude<LarkProgressState, "running">): void {
  if (!db?.open) return;
  try {
  const now = nowIso();
  db.prepare("UPDATE lark_progress_cards SET state=?,version=version+1,pending=1,attempts=0,next_attempt_at=?,updated_at=? WHERE progress_id=? AND state='running'")
    .run(state, now, now, progressId);
  void retryPendingLarkProgressCards();
  } catch { console.warn("lark_progress_finish_failed"); }
}

export function rebindLarkProgressCard(progressId: string, turnId: string, threadId: string): void {
  db.prepare("UPDATE lark_progress_cards SET native_turn_id=?,thread_id=? WHERE progress_id=? AND state='running'").run(turnId, threadId, progressId);
}

async function deliver(database: Database.Database, id: string): Promise<void> {
  // One writer per card: a terminal update must follow, never race an older PATCH.
  for (let pass = 0; pass < 3 && database.open && database === db; pass++) {
    const current = row(database, id);
    if (!current?.pending || current.attempts >= maxAttempts || Date.parse(current.next_attempt_at) > Date.now()) return;
    const source = database.prepare("SELECT * FROM lark_messages WHERE id=?").get(current.lark_message_id) as LarkMessageRow | undefined;
    if (!source || source.message_id !== current.message_id) return;
    if (current.state === "running" && (source.codex_turn_id !== current.native_turn_id || !["queued", "running"].includes(source.codex_status))) {
      const state = source.codex_turn_id === current.native_turn_id && ["answered", "no_reply"].includes(source.codex_status) ? "completed" : "interrupted";
      database.prepare("UPDATE lark_progress_cards SET state=?,version=version+1,next_attempt_at=? WHERE progress_id=? AND state='running'").run(state, nowIso(), id);
      continue;
    }
    if (current.state === "running" && (config.groupPrivacyEnforced && source.chat_type !== "p2p" || !getAppSettings().larkCodexInterimRepliesEnabled)) return;
    if (!current.card_message_id && !current.create_attempted && current.state !== "running") {
      database.prepare("UPDATE lark_progress_cards SET pending=0,delivered_version=version WHERE progress_id=?").run(id);
      return;
    }
    try {
      const content: LarkProgressContent = { state: current.state, entries: JSON.parse(current.entries_json) };
      let cardId = current.card_message_id;
      if (!cardId) {
        database.prepare("UPDATE lark_progress_cards SET create_attempted=1 WHERE progress_id=?").run(id);
        const sent = await larkProgressSender(current.message_id, content, larkReplyIdempotencyKey("progress", id));
        if (!sent.ok || !sent.messageId) throw new Error("Progress card returned no message receipt");
        cardId = sent.messageId;
        if (!database.open || database !== db) return;
        database.prepare("UPDATE lark_progress_cards SET card_message_id=? WHERE progress_id=?").run(cardId, id);
        // Do not mark the original question replied: only the final text does that.
        recordOutboundLarkMessage({ messageId: cardId, chatId: source.chat_id, chatType: source.chat_type, recipientId: source.sender_id,
          content: textOf(content.entries, content.state), replyToMessageId: current.message_id, messageAt: sent.messageAt, messageType: "interactive", source: "reply" });
        // A UUID retry may return the receipt of an older accepted body.
        if (current.create_attempted) await larkProgressUpdater(cardId, content);
      } else await larkProgressUpdater(cardId, content);
      if (!database.open || database !== db) return;
      const latest = row(database, id)!;
      const now = nowIso();
      const next = latest.state === "running" ? new Date(Date.now() + updateIntervalMs).toISOString() : now;
      database.prepare("UPDATE lark_progress_cards SET delivered_version=?,pending=CASE WHEN version=? THEN 0 ELSE 1 END,attempts=0,last_error=NULL,next_attempt_at=? WHERE progress_id=?")
        .run(current.version, current.version, next, id);
      database.prepare("UPDATE lark_messages SET content=? WHERE message_id=? AND direction='outbound'").run(textOf(content.entries, content.state), cardId);
    } catch (error) {
      if (!database.open) return;
      const attempts = current.attempts + 1;
      database.prepare("UPDATE lark_progress_cards SET attempts=?,pending=?,next_attempt_at=?,last_error=? WHERE progress_id=?")
        .run(attempts, attempts >= maxAttempts ? 0 : 1, new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString(), error instanceof Error ? error.message.slice(0, 500) : "Progress delivery failed", id);
      return;
    }
  }
}

export async function retryPendingLarkProgressCards(): Promise<void> {
  try {
  const database = db;
  if (!database?.open || config.runtimeMode !== "active") return;
  const rows = database.prepare("SELECT progress_id FROM lark_progress_cards WHERE pending=1 AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at LIMIT 20")
    .all(nowIso(), maxAttempts) as Array<{ progress_id: string }>;
  const map = tasks(database);
  const pending: Promise<void>[] = [];
  for (const r of rows) {
    let task = map.get(r.progress_id);
    if (!task) {
      task = Promise.resolve().then(() => deliver(database, r.progress_id)).catch(error => { console.warn(`lark_progress_delivery_failed ${error instanceof Error ? error.name : "Error"}`); })
        .finally(() => { map.delete(r.progress_id); });
      map.set(r.progress_id, task);
    }
    pending.push(task);
  }
  await Promise.all(pending);
  } catch { console.warn("lark_progress_retry_failed"); }
}

export async function drainLarkProgressCards(): Promise<void> {
  await retryPendingLarkProgressCards();
  await Promise.all([...tasks().values()]);
}

export function reconcileLarkProgressCards(): void {
  const cards = db.prepare(`SELECT progress_id,CASE WHEN m.codex_turn_id=p.native_turn_id THEN m.codex_status ELSE NULL END AS codex_status FROM lark_progress_cards p LEFT JOIN lark_messages m ON m.id=p.lark_message_id
    WHERE p.state='running' AND (m.id IS NULL OR m.codex_turn_id IS NOT p.native_turn_id OR m.codex_status NOT IN ('queued','running'))`).all() as Array<{ progress_id: string; codex_status?: string }>;
  for (const card of cards) finishLarkProgressCard(card.progress_id, card.codex_status === "answered" || card.codex_status === "no_reply" ? "completed" : "interrupted");
}
