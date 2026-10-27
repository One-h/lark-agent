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
