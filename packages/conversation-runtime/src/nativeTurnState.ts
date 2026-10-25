type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

export type NativeTurnState = {
  status: "active" | "completed" | "failed" | "interrupted" | "unknown";
  threadStatus: string | null;
  error?: { message?: string; additionalDetails?: string; codexErrorInfo?: unknown };
  items?: RecordValue[];
};

export async function readNativeTurnState(
  request: (method: string, params: RecordValue) => Promise<unknown>, threadId: string, turnId: string
): Promise<NativeTurnState> {
  const response = object(await request("thread/read", { threadId }));
  const thread = object(response?.thread);
  const rawStatus = object(thread?.status)?.type;
  const threadStatus = typeof rawStatus === "string" ? rawStatus : null;
  const unknown: NativeTurnState = { status: "unknown", threadStatus };
  if (thread?.id !== threadId) return unknown;
  const page = object(await request("thread/turns/list", { threadId, limit: 10, sortDirection: "desc", itemsView: "summary" }));
  if (!Array.isArray(page?.data)) return unknown;
  const turn = page.data.map(object).find(value => value?.id === turnId);
  if (!turn) return unknown;
  if (turn.status === "inProgress") return threadStatus === "active" ? { status: "active", threadStatus } : unknown;
  if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") return unknown;
  const error = object(turn.error);
  return {
    status: turn.status, threadStatus,
    error: error ? {
      message: typeof error.message === "string" ? error.message : undefined,
      additionalDetails: typeof error.additionalDetails === "string" ? error.additionalDetails : undefined,
      codexErrorInfo: error.codexErrorInfo
    } : undefined,
    items: Array.isArray(turn.items) ? turn.items.map(object).filter((item): item is RecordValue => item !== null) : []
  };
}
