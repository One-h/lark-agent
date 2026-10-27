import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";

function isTestProcess(): boolean {
  return process.env.LARK_AGENT_TEST_DATABASE === "1"
    || process.env.NODE_TEST_CONTEXT !== undefined
    || process.argv.some((argument) => /(?:^|[/\\])[^/\\]+\.test\.[cm]?[jt]s$/.test(argument));
}

export function assertLarkAgentTestDatabaseIsolation(file: string): void {
  if (!isTestProcess()) return;
  const resolved = path.resolve(file);
  const temporaryRoot = path.resolve(os.tmpdir());
  const parentName = path.basename(path.dirname(resolved));
  const isolated = process.env.LARK_AGENT_TEST_DATABASE === "1"
    && resolved.startsWith(`${temporaryRoot}${path.sep}`)
    && /^(?:lark|sticker)-/.test(parentName)
    && path.extname(resolved) === ".sqlite";
  if (!isolated) {
    throw new Error(`Refusing to open a non-isolated Lark Agent database from a test process: ${resolved}. Run tests through npm test.`);
  }
}

export type CapabilityApproval = {
  id: number;
  lark_message_id: number;
  turn_id: string | null;
  capability_id: string | null;
  operation: string;
  approver_id: string;
  status: string;
  expires_at: string;
  decided_at: string | null;
  card_message_id: string | null;
  created_at: string;
};

export class SqliteAgentStore {
  readonly db: Database.Database;

  constructor(file: string) {
    assertLarkAgentTestDatabaseIsolation(file);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void { this.db.close(); }

  setting(key: string, fallback: string): string {
    return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value ?? fallback;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, new Date().toISOString());
  }

  private tableExists(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateLegacyRuntime(): void {
    if (this.tableExists("messages") && this.tableExists("conversations")) {
      const hasOutbox = this.tableExists("outbox");
      this.db.exec(`
        INSERT OR IGNORE INTO lark_messages (
          id, event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
          reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
          mentioned, reply_trigger, reply_status, codex_status, codex_reply, codex_error,
          codex_session_id, codex_turn_id, raw_json, received_at, created_at
        )
        SELECT m.id, NULL, m.platform_message_id, c.chat_id, COALESCE(m.chat_type, 'p2p'), m.sender_id,
          json_extract(m.attachments_json, '$.messageType'), m.content,
          json_extract(m.reference_json, '$.messageId'), json_extract(m.reference_json, '$.messageType'),
          json_extract(m.reference_json, '$.content'), m.reference_json,
          CASE WHEN COALESCE(m.chat_type, 'p2p')='p2p' THEN 1 ELSE 0 END,
          CASE WHEN COALESCE(m.chat_type, 'p2p')='p2p' THEN 'p2p' ELSE 'none' END,
          ${hasOutbox ? "CASE WHEN EXISTS (SELECT 1 FROM outbox o WHERE o.message_id=m.id AND o.status='sent') THEN 'sent' ELSE 'skipped' END" : "'skipped'"},
          m.codex_status, m.codex_reply, m.codex_error, c.codex_thread_id, c.last_turn_id,
          json_object('sender_type', m.sender_type), m.inbound_at, m.inbound_at
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
      `);
    }

    if (this.tableExists("approval_requests")) {
      const columns = new Set((this.db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((column) => column.name));
      if (columns.has("lark_message_id")) {
        this.db.exec(`
          INSERT OR IGNORE INTO lark_capability_approvals (
            id, lark_message_id, turn_id, capability_id, operation, approver_id, status,
            expires_at, decided_at, card_message_id, created_at
          )
          SELECT id, lark_message_id, turn_id, capability_id, operation, approver_id, status,
            expires_at, decided_at, card_message_id, COALESCE(created_at, expires_at)
          FROM approval_requests
          WHERE lark_message_id IS NOT NULL
        `);
      }
    }

    for (const table of ["approval_requests", "outbox", "artifacts", "message_events", "messages", "conversations"]) {
      if (this.tableExists(table)) this.db.exec(`DROP TABLE ${table}`);
    }
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (open_id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', email TEXT, department TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_aliases (alias TEXT NOT NULL, open_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(alias, open_id));
      CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, tags TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, source_url TEXT, source_site TEXT, enabled INTEGER NOT NULL DEFAULT 1, local_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sticker_sends (id INTEGER PRIMARY KEY, sticker_id TEXT NOT NULL, lark_message_id INTEGER NOT NULL, chat_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, risk TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lark_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, message_id TEXT, chat_id TEXT, chat_type TEXT,
        sender_id TEXT, sender_type TEXT, recipient_id TEXT, direction TEXT NOT NULL DEFAULT 'inbound',
        message_type TEXT, content TEXT, message_at TEXT, outbound_source TEXT,
        reply_to_message_id TEXT, root_message_id TEXT, thread_id TEXT, reply_to_message_type TEXT,
        reply_to_content TEXT, reply_to_raw_json TEXT, mentioned INTEGER NOT NULL DEFAULT 0,
        reply_trigger TEXT NOT NULL DEFAULT 'none', reply_status TEXT NOT NULL DEFAULT 'skipped', reply_error TEXT,
        reply_delivery_key TEXT, reply_delivery_text TEXT, reply_delivery_attempts INTEGER NOT NULL DEFAULT 0,
        reply_next_attempt_at TEXT, reply_sent_at TEXT, codex_status TEXT NOT NULL DEFAULT 'skipped', codex_reply TEXT,
        codex_error TEXT, codex_session_id TEXT, codex_turn_id TEXT, codex_last_heartbeat_at TEXT,
        codex_runner_generation TEXT, codex_task_dir TEXT, codex_started_at TEXT, codex_finished_at TEXT,
        raw_json TEXT NOT NULL, received_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lark_messages_event_id ON lark_messages(event_id) WHERE event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_lark_messages_message_id ON lark_messages(message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS lark_codex_sessions (session_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, trust_scope TEXT NOT NULL, codex_session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lark_codex_archive_queue (thread_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, activity_version INTEGER NOT NULL, token TEXT NOT NULL, due_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_lark_codex_archive_queue_due ON lark_codex_archive_queue(due_at);
      CREATE TABLE IF NOT EXISTS lark_codex_session_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, chat_id TEXT NOT NULL, trust_scope TEXT NOT NULL, codex_session_id TEXT NOT NULL, reset_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_lark_codex_session_resets_chat ON lark_codex_session_resets(chat_id, id DESC);
      CREATE TABLE IF NOT EXISTS lark_group_context_cursors (chat_id TEXT NOT NULL, trust_scope TEXT NOT NULL, last_message_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, trust_scope));
      CREATE TABLE IF NOT EXISTS lark_execution_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, lark_message_id INTEGER NOT NULL, requester_id TEXT, approver_id TEXT NOT NULL, request_method TEXT NOT NULL, server_request_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, operation TEXT, cwd TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', approval_scope TEXT NOT NULL DEFAULT 'once', card_message_id TEXT, card_error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS lark_turn_auto_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL,
        turn_id TEXT NOT NULL, requester_id TEXT NOT NULL, approver_id TEXT NOT NULL,
        task_type TEXT, target TEXT, cwd TEXT, source TEXT NOT NULL,
        decision TEXT NOT NULL, reason TEXT NOT NULL, matched_approval_id INTEGER,
        model TEXT, usage_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        applied_at TEXT, UNIQUE(turn_id, requester_id, approver_id)
      );
      CREATE TABLE IF NOT EXISTS lark_capability_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, turn_id TEXT, capability_id TEXT, operation TEXT NOT NULL, approver_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, decided_at TEXT, card_message_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lark_capability_invocations (id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, turn_id TEXT NOT NULL, capability_id TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT, UNIQUE(turn_id, capability_id, input_hash));
      CREATE TABLE IF NOT EXISTS lark_execution_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, entries_json TEXT NOT NULL, card_message_id TEXT, delivery_status TEXT NOT NULL DEFAULT 'pending', delivery_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, delivery_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(lark_message_id, turn_id));
      CREATE TABLE IF NOT EXISTS lark_observed_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE(turn_id, item_id));
      CREATE TABLE IF NOT EXISTS lark_delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, lark_message_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_lark_capability_approvals_pending ON lark_capability_approvals(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_lark_delivery_outbox_pending ON lark_delivery_outbox(status, next_attempt_at);
    `);

    this.ensureColumn("stickers", "content_hash", "TEXT");
    this.ensureColumn("stickers", "usage_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("stickers", "deleted_at", "TEXT");
    this.ensureColumn("contacts", "user_id", "TEXT");
    this.ensureColumn("contacts", "enterprise_email", "TEXT");
    this.ensureColumn("contacts", "p2p_chat_id", "TEXT");
    this.ensureColumn("contacts", "is_activated", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("contacts", "is_cross_tenant", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("contacts", "has_chatted", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("contacts", "source", "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureColumn("contacts", "created_at", "TEXT");
    this.ensureColumn("contacts", "last_seen_at", "TEXT");
    this.ensureColumn("lark_messages", "direction", "TEXT NOT NULL DEFAULT 'inbound'");
    this.ensureColumn("lark_messages", "sender_type", "TEXT");
    this.ensureColumn("lark_messages", "recipient_id", "TEXT");
    this.ensureColumn("lark_messages", "message_at", "TEXT");
    this.ensureColumn("lark_messages", "outbound_source", "TEXT");
    this.ensureColumn("lark_messages", "root_message_id", "TEXT");
    this.ensureColumn("lark_messages", "thread_id", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_p2p_sender_time ON lark_messages(chat_type, sender_id, message_at DESC, id DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_p2p_recipient_time ON lark_messages(chat_type, recipient_id, message_at DESC, id DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_group_time ON lark_messages(chat_id, message_at DESC, id DESC) WHERE chat_type='group'");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_group_topic ON lark_messages(chat_id, root_message_id, thread_id, message_at DESC, id DESC) WHERE chat_type='group'");
    // Context queries also include historical rows without a populated chat_type.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_context_time ON lark_messages(chat_id, COALESCE(message_at, received_at, created_at) DESC, id DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_context_root ON lark_messages(chat_id, root_message_id, thread_id)");

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_contact_aliases_alias ON contact_aliases(alias)");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stickers_content_hash ON stickers(content_hash) WHERE content_hash IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sticker_sends_chat ON sticker_sends(chat_id, id DESC)");
    this.db.exec("CREATE VIEW IF NOT EXISTS lark_contacts AS SELECT open_id, user_id, name, aliases, COALESCE(enterprise_email, email) AS enterprise_email, department, p2p_chat_id, is_activated, is_cross_tenant, has_chatted, source, created_at, updated_at, last_seen_at FROM contacts");
    this.db.exec("CREATE VIEW IF NOT EXISTS lark_contact_aliases AS SELECT alias, open_id, created_at FROM contact_aliases");
    this.migrateLegacyRuntime();
    this.db.exec("UPDATE lark_messages SET direction='inbound' WHERE direction IS NULL OR direction=''");
    this.db.exec("UPDATE lark_messages SET sender_type=COALESCE(sender_type, CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.sender_type') END, 'user') WHERE direction='inbound'");
    this.db.exec("UPDATE lark_messages SET message_at=COALESCE(message_at, received_at, created_at)");
    if (this.setting("larkTopicFieldsBackfilledV1", "false") !== "true") {
      this.db.transaction(() => {
        this.db.exec("UPDATE lark_messages SET root_message_id=json_extract(raw_json, '$.root_id') WHERE root_message_id IS NULL AND json_valid(raw_json) AND json_type(raw_json, '$.root_id')='text'");
        this.db.exec("UPDATE lark_messages SET thread_id=json_extract(raw_json, '$.thread_id') WHERE thread_id IS NULL AND json_valid(raw_json) AND json_type(raw_json, '$.thread_id')='text'");
        this.setSetting("larkTopicFieldsBackfilledV1", "true");
      })();
    }
  }

  registerCapabilities(capabilities: Array<{ id: string; title: string; description: string; inputSchema: Record<string, unknown>; risk: string }>): void {
    const insert = this.db.prepare("INSERT INTO capabilities (id, title, description, input_schema, risk, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, input_schema=excluded.input_schema, risk=excluded.risk, updated_at=excluded.updated_at");
    const now = new Date().toISOString();
    this.db.transaction(() => capabilities.forEach((capability) => insert.run(capability.id, capability.title, capability.description, JSON.stringify(capability.inputSchema), capability.risk, now)))();
  }

  createApproval(input: { larkMessageId: number; turnId: string; capabilityId?: string | null; operation: string; approverId: string; expiresAt: string }): number {
    return Number(this.db.prepare("INSERT INTO lark_capability_approvals (lark_message_id, turn_id, capability_id, operation, approver_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.larkMessageId, input.turnId, input.capabilityId ?? null, input.operation, input.approverId, input.expiresAt, new Date().toISOString()).lastInsertRowid);
  }

  approval(id: number): CapabilityApproval | null {
    return this.db.prepare("SELECT * FROM lark_capability_approvals WHERE id=?").get(id) as CapabilityApproval | undefined ?? null;
  }

  expireApprovals(now = new Date().toISOString()): Array<{ id: number; lark_message_id: number; operation: string }> {
    const rows = this.db.prepare("SELECT id, lark_message_id, operation FROM lark_capability_approvals WHERE status='pending' AND expires_at <= ?").all(now) as Array<{ id: number; lark_message_id: number; operation: string }>;
    if (rows.length > 0) this.db.prepare("UPDATE lark_capability_approvals SET status='expired', decided_at=? WHERE status='pending' AND expires_at <= ?").run(now, now);
    return rows;
  }

  decideApproval(id: number, status: "approved" | "rejected"): boolean {
    return this.db.prepare("UPDATE lark_capability_approvals SET status=?, decided_at=? WHERE id=? AND status='pending'").run(status, new Date().toISOString(), id).changes > 0;
  }

  setApprovalCardMessage(id: number, messageId: string): void {
    this.db.prepare("UPDATE lark_capability_approvals SET card_message_id=? WHERE id=?").run(messageId, id);
  }
}
