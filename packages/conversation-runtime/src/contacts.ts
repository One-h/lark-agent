import { spawnSync } from "node:child_process";
import { db, nowIso, type LarkContactRow } from "./context.js";

type LarkCliUser = {
  open_id?: unknown;
  user_id?: unknown;
  localized_name?: unknown;
  name?: unknown;
  enterprise_email?: unknown;
  department?: unknown;
  p2p_chat_id?: unknown;
  is_activated?: unknown;
  is_cross_tenant?: unknown;
  has_chatted?: unknown;
};

type LarkContactSearchResult = {
  users: LarkCliUser[];
  hasMore: boolean;
};

export type LarkContactInput = {
  openId: string;
  userId?: string | null;
  name: string;
  aliases?: string[];
  enterpriseEmail?: string | null;
  department?: string | null;
  p2pChatId?: string | null;
  isActivated?: boolean;
  isCrossTenant?: boolean;
  hasChatted?: boolean;
  source?: string;
};

export type LarkContactSyncResult = {
  scanned: number;
  upserted: number;
  hasMore: boolean;
};

type LarkMentionIdentity = {
  id?: unknown;
  open_id?: unknown;
  openId?: unknown;
  name?: unknown;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function larkContactAliases(name: string, extraAliases: string[] = []): string[] {
  const aliases = new Set<string>();
  const trimmed = name.trim();
  if (trimmed) {
    aliases.add(trimmed);
  }
  for (const part of trimmed.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const alias = part[1]?.trim();
    if (alias) {
      aliases.add(alias);
    }
  }
  const withoutParentheses = trimmed.replace(/[（(][^）)]+[）)]/g, "").trim();
  if (withoutParentheses) {
    aliases.add(withoutParentheses);
  }
  for (const alias of extraAliases) {
    const normalized = alias.trim();
    if (normalized) {
      aliases.add(normalized);
    }
  }
  return [...aliases];
}

export function upsertLarkContact(contact: LarkContactInput): void {
  const now = nowIso();
  const aliases = larkContactAliases(contact.name, contact.aliases ?? []);
  db.prepare(`
    INSERT INTO contacts (
      open_id, user_id, name, aliases, enterprise_email, department, p2p_chat_id,
      is_activated, is_cross_tenant, has_chatted, source, created_at, updated_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(open_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, contacts.user_id),
      name = excluded.name,
      aliases = excluded.aliases,
      enterprise_email = COALESCE(excluded.enterprise_email, contacts.enterprise_email),
      department = COALESCE(excluded.department, contacts.department),
      p2p_chat_id = COALESCE(excluded.p2p_chat_id, contacts.p2p_chat_id),
      is_activated = excluded.is_activated,
      is_cross_tenant = excluded.is_cross_tenant,
      has_chatted = excluded.has_chatted,
      source = excluded.source,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at
  `).run(
    contact.openId,
    contact.userId ?? contact.openId,
    contact.name,
    JSON.stringify(aliases),
    contact.enterpriseEmail ?? null,
    contact.department ?? null,
    contact.p2pChatId ?? null,
    contact.isActivated === false ? 0 : 1,
    contact.isCrossTenant ? 1 : 0,
    contact.hasChatted ? 1 : 0,
    contact.source ?? "manual",
    now,
    now,
    now
  );
  db.prepare("DELETE FROM contact_aliases WHERE open_id = ?").run(contact.openId);
  const insertAlias = db.prepare("INSERT OR IGNORE INTO contact_aliases (alias, open_id, created_at) VALUES (?, ?, ?)");
  for (const alias of aliases) {
    insertAlias.run(alias, contact.openId, now);
  }
}

function storedAliases(row: LarkContactRow | undefined): string[] {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.aliases) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function upsertMentionIdentity(openId: string, name: string): void {
  const existing = db.prepare("SELECT * FROM contacts WHERE open_id = ?").get(openId) as LarkContactRow | undefined;
  upsertLarkContact({
    openId,
    userId: existing?.user_id ?? openId,
    name,
    aliases: [...storedAliases(existing), ...(existing?.name ? [existing.name] : [])],
    enterpriseEmail: existing?.enterprise_email,
    department: existing?.department,
    p2pChatId: existing?.p2p_chat_id,
    isActivated: existing ? existing.is_activated === 1 : true,
    isCrossTenant: existing?.is_cross_tenant === 1,
    hasChatted: true,
    source: existing?.source === "lark-cli:has-chatted" ? existing.source : "lark-event:mention"
  });
}

export function upsertLarkContactsFromMentions(mentions: unknown[]): number {
  let upserted = 0;
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object") continue;
    const identity = mention as LarkMentionIdentity;
    const openId = stringValue(identity.id) ?? stringValue(identity.open_id) ?? stringValue(identity.openId);
    const name = stringValue(identity.name);
    if (!openId || !/^ou_[a-zA-Z0-9]+$/.test(openId) || !name) continue;
    upsertMentionIdentity(openId, name);
    upserted += 1;
  }
  return upserted;
}

export function backfillLarkContactsFromMessageMentions(): { scanned: number; upserted: number } {
  const rows = db.prepare("SELECT raw_json FROM lark_messages WHERE raw_json LIKE '%mentions%' ORDER BY id").all() as Array<{ raw_json: string }>;
  const identities = new Map<string, string>();
  for (const row of rows) {
    try {
      const event = JSON.parse(row.raw_json) as { mentions?: unknown };
      if (!Array.isArray(event.mentions)) continue;
      for (const mention of event.mentions) {
        if (!mention || typeof mention !== "object") continue;
        const identity = mention as LarkMentionIdentity;
        const openId = stringValue(identity.id) ?? stringValue(identity.open_id) ?? stringValue(identity.openId);
        const name = stringValue(identity.name);
        if (openId && /^ou_[a-zA-Z0-9]+$/.test(openId) && name) identities.set(openId, name);
      }
    } catch {
      // Ignore legacy rows with invalid raw JSON.
    }
  }
  for (const [openId, name] of identities) upsertMentionIdentity(openId, name);
  return { scanned: rows.length, upserted: identities.size };
}

function contactFromCliUser(user: LarkCliUser): LarkContactInput | null {
  const openId = stringValue(user.open_id);
  const name = stringValue(user.localized_name) ?? stringValue(user.name);
  if (!openId || !name) {
    return null;
  }
  return {
    openId,
    userId: stringValue(user.user_id) ?? openId,
    name,
    enterpriseEmail: stringValue(user.enterprise_email),
    department: stringValue(user.department),
    p2pChatId: stringValue(user.p2p_chat_id),
    isActivated: booleanValue(user.is_activated, true),
    isCrossTenant: booleanValue(user.is_cross_tenant),
    hasChatted: booleanValue(user.has_chatted),
    source: "lark-cli:has-chatted"
  };
}

function larkCliContactSearchError(output: string): Error | null {
  try {
    larkContactSearchFromCliOutput(output);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function fetchLarkContactSearch(): LarkContactSearchResult {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync(
      "lark-cli",
      [
        "contact",
        "+search-user",
        "--as",
        "user",
        "--has-chatted",
        "--exclude-external-users",
        "--page-size",
        "30",
        "--format",
        "json"
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!result.error && result.status === 0) {
      return larkContactSearchFromCliOutput(result.stdout);
    }
    const cliOutput = result.stdout.trim() || result.stderr.trim();
    const cliError = cliOutput ? larkCliContactSearchError(cliOutput) : null;
    lastError = result.error
      ? new Error(result.error.message || "lark-cli could not start the contact directory sync")
      : cliError && !/invalid JSON/.test(cliError.message)
        ? cliError
        : new Error(cliOutput || `lark-cli exited with code ${result.status}`);
    if (!/\bEOF\b/i.test(lastError.message)) break;
  }
  throw lastError ?? new Error("lark-cli could not read the chatted contacts");
}

export function larkContactSearchFromCliOutput(output: string): LarkContactSearchResult {
  let parsed: {
    ok?: unknown;
    error?: { message?: unknown };
    data?: { users?: unknown; has_more?: unknown };
  };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new Error("lark-cli returned invalid JSON while syncing chatted contacts");
  }
  if (parsed.ok === false) {
    throw new Error(stringValue(parsed.error?.message) ?? "lark-cli could not read chatted contacts");
  }
  const users = Array.isArray(parsed.data?.users) ? parsed.data.users as LarkCliUser[] : [];
  return {
    users,
    hasMore: booleanValue(parsed.data?.has_more)
  };
}

export function syncLarkContactsFromCli(): LarkContactSyncResult {
  backfillLarkContactsFromMessageMentions();
  let upserted = 0;
  const search = fetchLarkContactSearch();
  for (const user of search.users) {
    const contact = contactFromCliUser(user);
    if (!contact) continue;
    upsertLarkContact(contact);
    upserted += 1;
  }

  return {
    scanned: search.users.length,
    upserted,
    hasMore: search.hasMore
  };
}

export function listLarkContacts(): LarkContactRow[] {
  return db.prepare("SELECT * FROM contacts ORDER BY name ASC").all() as LarkContactRow[];
}

export function findLarkContactByAlias(alias: string): LarkContactRow | null {
  const normalized = alias.trim();
  if (!normalized) {
    return null;
  }
  const exact = db.prepare(`
    SELECT contacts.*
    FROM contacts
    JOIN contact_aliases ON contact_aliases.open_id = contacts.open_id
    WHERE contact_aliases.alias = ?
    ORDER BY contacts.has_chatted DESC, contacts.updated_at DESC
    LIMIT 1
  `).get(normalized) as LarkContactRow | undefined;
  if (exact) {
    return exact;
  }
  return db.prepare(`
    SELECT DISTINCT contacts.*
    FROM contacts
    LEFT JOIN contact_aliases ON contact_aliases.open_id = contacts.open_id
    WHERE contacts.name LIKE ? OR contact_aliases.alias LIKE ? OR contacts.enterprise_email LIKE ?
    ORDER BY contacts.has_chatted DESC, contacts.updated_at DESC
    LIMIT 1
  `).get(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`) as LarkContactRow | undefined ?? null;
}
