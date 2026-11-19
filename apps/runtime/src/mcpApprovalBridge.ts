import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
    : value;
}

export function mcpApprovalKey(contextToken: string, tool: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify([contextToken, tool, canonical(input)])).digest("hex");
}

type Approval = { state: "reviewing" | "ready" | "dispatched"; execution: Promise<unknown>; dispatch: () => void; cancel: () => void };
type Execute = (signal: AbortSignal, beforeExecution: (signal: AbortSignal) => Promise<void>) => Promise<unknown>;

/** A confirmation never executes an operation; only the matching tools/call releases it. */
export class McpApprovalBridge {
  private readonly pending = new Map<string, Approval>();

  async prepare(key: string, request: AbortSignal, execute: Execute): Promise<boolean> {
    if (request.aborted || this.pending.has(key)) return false;
    const controller = new AbortController();
    let decision!: (approved: boolean) => void;
    const ready = new Promise<boolean>(resolve => { decision = resolve; });
    let dispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const entry: Approval = { state: "reviewing", execution: Promise.resolve(), dispatch, cancel: () => controller.abort() };
    this.pending.set(key, entry);
    const abort = () => controller.abort();
    request.addEventListener("abort", abort, { once: true });
    entry.execution = Promise.resolve().then(() => execute(controller.signal, async signal => {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(new Error("MCP approval expired or was cancelled before execution"));
        signal.addEventListener("abort", cancelled, { once: true });
        void dispatched.then(() => { clearTimeout(timer); signal.removeEventListener("abort", cancelled); resolve(); });
        timer = setTimeout(abort, 60_000);
        timer.unref();
        entry.state = "ready";
        decision(true);
      });
    })).finally(() => {
      decision(false);
      clearTimeout(timer);
      if (this.pending.get(key) === entry) this.pending.delete(key);
    });
    // The MCP caller may never arrive (e.g. an interrupted turn).
    void entry.execution.catch(() => {});
    try { return await ready; }
    finally { request.removeEventListener("abort", abort); }
  }

  take(key: string, request: AbortSignal): Promise<unknown> | undefined {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (request.aborted) { entry.cancel(); throw new Error("MCP tool connection has ended"); }
    if (entry.state !== "ready") throw new Error("MCP tool approval is not available for dispatch");
    entry.state = "dispatched";
    request.addEventListener("abort", entry.cancel, { once: true });
    entry.dispatch();
    return entry.execution.finally(() => request.removeEventListener("abort", entry.cancel));
  }
}
