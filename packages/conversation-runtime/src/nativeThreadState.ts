type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function isNativeThreadLoaded(request: Request, threadId: string): Promise<boolean> {
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const value = await request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    const page = value as { data?: unknown; nextCursor?: unknown } | null;
    if (!Array.isArray(page?.data) || page.data.some(id => typeof id !== "string")
      || (page.nextCursor != null && typeof page.nextCursor !== "string")) {
      throw new Error("Invalid Codex loaded-thread list response");
    }
    if (page.data.includes(threadId)) return true;
    cursor = page.nextCursor as string | null | undefined ?? null;
    if (cursor !== null) {
      if (!cursor || visited.has(cursor)) throw new Error("Invalid Codex loaded-thread list cursor");
      visited.add(cursor);
    }
  } while (cursor !== null);
  return false;
}

export function isNativeThreadMissingError(error: unknown, threadId: string): boolean {
  return error instanceof Error && error.message.trim() === `thread not found: ${threadId}`;
}

export async function nativeThreadArchiveSafety(request: Request, threadId: string): Promise<"idle" | "active" | "unknown"> {
  const response = await request("thread/read", { threadId }) as {
    thread?: { id?: unknown; status?: { type?: unknown } }
  } | null;
  const thread = response?.thread;
  if (thread?.id !== threadId) return "unknown";
  if (thread.status?.type === "active") return "active";
  if (thread.status?.type !== "idle" && thread.status?.type !== "notLoaded") return "unknown";
  const page = await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" }) as {
    data?: Array<{ id?: unknown; status?: unknown }>
  } | null;
  if (!Array.isArray(page?.data) || page.data.length !== 1 || typeof page.data[0]?.id !== "string") return "unknown";
  const status = page.data[0].status;
  if (status === "inProgress") return "active";
  return status === "completed" || status === "failed" || status === "interrupted" ? "idle" : "unknown";
}

async function nativeThreadListed(request: Request, threadId: string, archived: boolean): Promise<boolean> {
  let cursor: string | null = null;
  const visited = new Set<string>();
  // A bounded metadata-only read can confirm success, but an incomplete search cannot justify cleanup.
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await request("thread/list", {
      archived, sourceKinds: ["appServer"], useStateDbOnly: true, sortKey: "updated_at", limit: 100,
      ...(cursor ? { cursor } : {})
    }) as { data?: Array<{ id?: unknown }>; nextCursor?: unknown } | null;
    if (!Array.isArray(page?.data) || page.data.some(row => typeof row?.id !== "string")
      || (page.nextCursor != null && typeof page.nextCursor !== "string")) throw new Error("Invalid Codex archived-thread list response");
    if (page.data.some(row => row.id === threadId)) return true;
    if (page.nextCursor == null) return false;
    if (!page.nextCursor || visited.has(page.nextCursor as string)) throw new Error("Invalid Codex archived-thread list cursor");
    cursor = page.nextCursor as string;
    visited.add(cursor);
  }
  throw new Error("Codex archived-thread lookup exceeded the bounded page limit");
}

export function isNativeThreadArchived(request: Request, threadId: string): Promise<boolean> {
  return nativeThreadListed(request, threadId, true);
}

export async function nativeThreadNeedsUnarchive(request: Request, threadId: string): Promise<boolean> {
  // Look in the active list first so normal reuse does not enumerate years of archives.
  if (await nativeThreadListed(request, threadId, false)) return false;
  if (await isNativeThreadArchived(request, threadId)) return true;
  throw new Error("Loaded Codex thread is missing from native thread metadata");
}
