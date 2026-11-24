import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionNativeApproval, ExecutionTurnResult, ExecutionWorkStage } from "./executionEngines.js";
import { RetainedExecutionClient, RetainedHostError, type RetainedHostConfig, type RetainedTurnSnapshot } from "./retainedExecutionClient.js";

type Binding = { message_id: number; turn_id: string; generation: string; session_key: string;
  engine_id: string; trusted: number; deadline: string; finalized: number };
type Local = { controller: AbortController; requests: Set<string>; pending: Set<string>; sequence: number;
  stage?: ExecutionWorkStage; observed?: string };
type Source = { messageId: number; engineId: string; sessionKey: string; trusted: boolean };
type Operation = Parameters<ExecutionNativeApproval>[0];
type Hooks = {
  workspace(): string;
  admit(source: Source): boolean;
  current(binding: Binding): boolean;
  acceptSession(binding: Binding, sessionId: string): void;
  authorize(binding: Binding, requestId: string, operation: Operation, signal: AbortSignal, stillCurrent: () => boolean): Promise<boolean>;
  observe(binding: Binding, sessionId: string, stage?: ExecutionWorkStage): boolean;
  finish(binding: Binding, result: ExecutionTurnResult | null): (() => void) | undefined;
  ended(binding: Binding, result: ExecutionTurnResult | null): void;
};

export class RetainedLarkExecution {
  private readonly client: RetainedExecutionClient;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<string, Local>();
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly db: Database.Database, settings: RetainedHostConfig, private readonly hooks: Hooks) {
    this.client = new RetainedExecutionClient(settings);
  }

  supports(engineId: string) { return this.client.supports(engineId); }

  get(messageId: number): Binding | undefined {
    return this.db.prepare("SELECT * FROM lark_retained_turns WHERE message_id=? AND finalized=0").get(messageId) as Binding | undefined;
  }

  busySession(key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM lark_retained_turns WHERE session_key=? AND finalized=0").get(key));
  }

  bindings(): Binding[] {
    return this.db.prepare("SELECT * FROM lark_retained_turns WHERE finalized=0").all() as Binding[];
  }

  owns(messageId: number, turnId: string, requestId?: string): boolean {
    const binding = this.get(messageId);
    const local = this.active.get(turnId);
    return Boolean(binding?.turn_id === turnId && local && !local.controller.signal.aborted && this.hooks.current(binding)
      && Date.parse(binding.deadline) > Date.now() && (!requestId || local.pending.has(requestId)));
  }

  async confirm(messageId: number, turnId: string, requestId: string): Promise<boolean> {
    const binding = this.get(messageId);
    if (!binding || binding.turn_id !== turnId || !this.owns(messageId, turnId, requestId)) return false;
    try {
      const snapshot = await this.call<RetainedTurnSnapshot | null>(binding, { method: "attach", afterSequence: 0 });
      return snapshot?.engineId === binding.engine_id && snapshot.status.state === "active"
        && snapshot.approvals.some(request => request.id === requestId) && this.owns(messageId, turnId, requestId);
    } catch { return false; }
  }

  async start(input: Source & { prompt: string; model: string | null; sessionId: string | null }): Promise<void> {
    const host = await this.client.call<{generation: string; workspace: string}>({ method: "status" }, this.lifetime.signal);
    if (host.workspace !== this.hooks.workspace()) throw new Error("Retained engine workspace mismatch");
    this.lifetime.signal.throwIfAborted();
    const turnId = randomUUID();
    const deadline = new Date(Date.now() + (input.trusted ? 180_000 : 600_000)).toISOString();
    this.db.transaction(() => {
      if (!this.hooks.admit(input) || this.busySession(input.sessionKey)) throw new Error("Retained execution context is no longer current");
      if (!this.db.prepare(`UPDATE lark_messages SET codex_status='running',codex_turn_id=?,codex_session_id=NULL,
        codex_dispatch_phase='submitted',codex_started_at=?,codex_last_heartbeat_at=? WHERE id=?
        AND codex_status='queued' AND codex_dispatch_phase='preparing'`).run(turnId, new Date().toISOString(),
        new Date().toISOString(), input.messageId).changes) throw new Error("Execution admission is no longer current");
      this.db.prepare(`INSERT INTO lark_retained_turns(message_id,turn_id,generation,session_key,engine_id,trusted,deadline)
        VALUES(?,?,?,?,?,?,?)`).run(input.messageId, turnId, host.generation, input.sessionKey, input.engineId, Number(input.trusted), deadline);
    })();
    try {
      await this.client.call({ method: "start", generation: host.generation, id: turnId, engineId: input.engineId,
        text: input.prompt, sessionId: input.sessionId, model: input.model, trusted: input.trusted, deadline }, this.lifetime.signal);
    } catch {
      // Even a lost response can mean the engine accepted this exact request.
      // Only attach is allowed after the commit above; never resubmit.
    }
    void this.poll();
  }

  resume(): void {
    this.timer ??= setInterval(() => { void this.poll(); }, 400).unref();
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
    this.lifetime.abort();
    for (const local of this.active.values()) local.controller.abort();
    this.active.clear();
  }

  async cancel(binding: Binding): Promise<void> {
    this.active.get(binding.turn_id)?.controller.abort();
    await this.call(binding, { method: "cancel" }).catch(() => {});
  }

  private call<T>(binding: Binding, request: Record<string, unknown>): Promise<T> {
    return this.client.call<T>({ ...request, generation: binding.generation, id: binding.turn_id }, this.lifetime.signal);
  }

  private async poll(): Promise<void> {
    if (this.busy || this.lifetime.signal.aborted || !this.db.open) return;
    this.busy = true;
    try {
      const rows = this.db.prepare("SELECT * FROM lark_retained_turns ORDER BY finalized, message_id").all() as Binding[];
      await Promise.all(rows.map(async binding => { try { await this.refresh(binding); } catch { /* Retry reads, never start again. */ } }));
    } finally { this.busy = false; }
  }

  private async refresh(binding: Binding): Promise<void> {
    if (binding.finalized) {
      try { if (!(await this.call<{ acknowledged: boolean }>(binding, { method: "acknowledge" })).acknowledged) return; }
      catch (error) { if (!(error instanceof RetainedHostError) || error.status !== 409) return; }
      if (!this.lifetime.signal.aborted) this.db.prepare("DELETE FROM lark_retained_turns WHERE turn_id=? AND finalized=1").run(binding.turn_id);
      return;
    }
    if (!this.supports(binding.engine_id) || !this.hooks.current(binding)) {
      await this.cancel(binding);
      if (!this.lifetime.signal.aborted) this.finish(binding, null);
      return;
    }
    let local = this.active.get(binding.turn_id);
    let snapshot: RetainedTurnSnapshot | null;
    try { snapshot = await this.call(binding, { method: "attach", afterSequence: local?.sequence ?? 0 }); }
    catch (error) {
      if (!this.lifetime.signal.aborted && (error instanceof RetainedHostError && error.status === 409
        || Date.parse(binding.deadline) <= Date.now())) this.finish(binding, null);
      return;
    }
    if (this.lifetime.signal.aborted) return;
    if (!this.hooks.current(binding)) return;
    if (snapshot && snapshot.engineId !== binding.engine_id) { this.finish(binding, null); return; }
    if (snapshot?.status.state === "finished") {
      this.hooks.acceptSession(binding, snapshot.status.sessionId);
      this.finish(binding, snapshot.status.result);
      return;
    }
    if (Date.parse(binding.deadline) <= Date.now()) {
      await this.cancel(binding);
      if (!this.lifetime.signal.aborted) this.finish(binding, null);
      return;
    }
    if (!snapshot) return;
    if (snapshot.status.state === "failed" || snapshot.status.state === "acknowledged") { this.finish(binding, null); return; }
    if (snapshot.status.state !== "active") return;
    this.hooks.acceptSession(binding, snapshot.status.sessionId);
    if (!local) {
      local = { controller: new AbortController(), requests: new Set(), pending: new Set(), sequence: 0 };
      this.active.set(binding.turn_id, local);
    }
    const owned = local;
    if (owned.controller.signal.aborted) return;
    owned.sequence = snapshot.sequence;
    owned.pending = new Set(snapshot.approvals.map(request => request.id));
    for (const { event } of snapshot.events) if (event.type === "work") owned.stage = event.stage;
    const progressKey = owned.stage ?? "start";
    if (owned.observed !== progressKey && this.hooks.observe(binding, snapshot.status.sessionId, owned.stage)) {
      owned.observed = progressKey;
    }
    for (const request of snapshot.approvals) {
      if (owned.requests.has(request.id) || request.operation.engineId !== binding.engine_id) continue;
      owned.requests.add(request.id);
      const current = () => !this.lifetime.signal.aborted && this.owns(binding.message_id, binding.turn_id, request.id);
      void this.hooks.authorize(binding, request.id, request.operation, owned.controller.signal, current)
        .catch(() => false)
        .then(async allow => {
          if (current()) await this.call(binding, { method: "answerApproval", requestId: request.id, allow });
        })
        .catch(() => { owned.requests.delete(request.id); });
    }
  }

  private finish(binding: Binding, result: ExecutionTurnResult | null): void {
    this.active.get(binding.turn_id)?.controller.abort();
    this.active.delete(binding.turn_id);
    const commit = this.db.transaction(() => {
      if (!this.db.prepare(`UPDATE lark_retained_turns SET finalized=1 WHERE turn_id=? AND finalized=0`).run(binding.turn_id).changes) return;
      return { deliver: this.hooks.finish(binding, result) };
    })();
    if (!commit) return;
    this.hooks.ended(binding, result);
    commit.deliver?.();
  }
}
