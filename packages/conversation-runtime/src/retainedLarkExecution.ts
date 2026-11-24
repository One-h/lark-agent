import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionNativeApproval, ExecutionTurnResult, ExecutionWorkStage } from "./executionEngines.js";
import { RetainedExecutionClient, RetainedHostError, type RetainedHostConfig, type RetainedHostStatus, type RetainedTurnSnapshot } from "./retainedExecutionClient.js";

type Binding = { message_id: number; turn_id: string; generation: string; session_key: string;
  engine_id: string; trusted: number; deadline: string; finalized: number };
type Local = { controller: AbortController; requests: Set<string>; pending: Set<string>; sequence: number;
  stage?: ExecutionWorkStage; observed?: string };
type Source = { messageId: number; engineId: string; sessionKey: string; trusted: boolean };
type Operation = Parameters<ExecutionNativeApproval>[0];
type Hooks = {
  workspace(): string;
  admit(source: Source): boolean;
  current(binding: Binding, sessionId?: string): boolean;
  acceptSession(binding: Binding, sessionId: string): void;
  acceptInput(binding: Binding, sessionId: string): void;
  authorize(binding: Binding, requestId: string, operation: Operation, signal: AbortSignal, stillCurrent: () => boolean): Promise<boolean>;
  observe(binding: Binding, sessionId: string, stage?: ExecutionWorkStage): boolean;
  finish(binding: Binding, result: ExecutionTurnResult | null): (() => void) | undefined;
  ended(binding: Binding, result: ExecutionTurnResult | null): void;
};

export class RetainedLarkExecution {
  private readonly client: RetainedExecutionClient;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<string, Local>();
  private readonly mcpSessions = new Map<string, string>();
  private readonly cancelling = new Set<string>();
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

  getForegroundMcpBinding(token: string): Binding | undefined {
    return this.foregroundMcpBinding(token, true);
  }

  async resolveForegroundMcpBinding(token: string): Promise<Binding | undefined> {
    const binding = this.foregroundMcpBinding(token, false);
    if (binding && await this.confirmForegroundMcp(binding.message_id, binding.turn_id, token)) return this.getForegroundMcpBinding(token);
  }

  private foregroundMcpBinding(token: string, confirmed: boolean): Binding | undefined {
    if (!this.db.open || this.lifetime.signal.aborted || confirmed && this.mcpSessions.size === 0
      || !/^[A-Za-z0-9_-]{32}$/.test(token)) return;
    return this.bindings().find(binding => {
      const sessionId = this.mcpSessions.get(binding.turn_id);
      return (!confirmed || sessionId !== undefined) && this.contextToken(binding) === token
        && this.foregroundCurrent(binding, confirmed ? sessionId : undefined);
    });
  }

  async confirmForegroundMcp(messageId: number, turnId: string, token: string): Promise<boolean> {
    if (!this.db.open || this.lifetime.signal.aborted) return false;
    const binding = this.get(messageId);
    if (!binding || binding.turn_id !== turnId || this.contextToken(binding) !== token || !this.foregroundCurrent(binding)) return false;
    try {
      const snapshot = await this.call<RetainedTurnSnapshot | null>(binding,
        { method: "attach", afterSequence: this.active.get(turnId)?.sequence ?? 0 });
      if (snapshot?.foregroundLarkToolsActive === true && snapshot.engineId === binding.engine_id
        && snapshot.status.state === "active" && typeof snapshot.status.sessionId === "string" && snapshot.status.sessionId
        && this.foregroundCurrent(binding)) {
        const sessionId = snapshot.status.sessionId;
        // The first tool can arrive before the observer poll, including after a restart.
        this.hooks.acceptSession(binding, sessionId);
        if (this.foregroundCurrent(binding, sessionId)) {
          this.hooks.acceptInput(binding, sessionId);
          this.mcpSessions.set(turnId, sessionId);
          return true;
        }
      }
    } catch { /* An unavailable or changed host cannot authorize a tool. */ }
    this.mcpSessions.delete(turnId);
    return false;
  }

  private foregroundCurrent(binding: Binding, sessionId?: string): boolean {
    if (this.lifetime.signal.aborted || !this.db.open || this.cancelling.has(binding.turn_id)
      || !this.supports(binding.engine_id) || !(Date.parse(binding.deadline) > Date.now())) return false;
    const current = this.get(binding.message_id);
    return Boolean(current?.turn_id === binding.turn_id && current.generation === binding.generation
      && current.engine_id === binding.engine_id && current.session_key === binding.session_key
      && current.trusted === binding.trusted && current.deadline === binding.deadline && this.hooks.current(current, sessionId));
  }

  private contextToken(binding: Binding): string {
    return this.client.foregroundMcpContextToken(binding.generation, binding.turn_id);
  }

  async start(input: Source & { prompt: string; model: string | null; sessionId: string | null; larkTools?: boolean }): Promise<void> {
    const host = await this.client.call<RetainedHostStatus>({ method: "status" }, this.lifetime.signal);
    if (host.workspace !== this.hooks.workspace()) throw new Error("Retained engine workspace mismatch");
    this.lifetime.signal.throwIfAborted();
    const foreground = input.larkTools && host.engines?.some(engine => engine.id === input.engineId && engine.foregroundLarkTools === true);
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
        text: input.prompt, sessionId: input.sessionId, model: input.model, trusted: input.trusted, deadline,
        ...(foreground ? { lane: "foreground" } : {}) }, this.lifetime.signal);
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
    this.mcpSessions.clear();
    this.cancelling.clear();
  }

  async cancel(binding: Binding): Promise<void> {
    this.cancelling.add(binding.turn_id);
    this.mcpSessions.delete(binding.turn_id);
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
    if (snapshot && snapshot.status.state !== "starting" && snapshot.foregroundLarkToolsActive !== true) {
      this.mcpSessions.delete(binding.turn_id);
    }
    if (snapshot?.status.state === "finished") {
      this.hooks.acceptSession(binding, snapshot.status.sessionId);
      if (snapshot.status.result.status === "completed" || snapshot.sequence > 0) {
        this.hooks.acceptInput(binding, snapshot.status.sessionId);
      }
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
    if (snapshot.sequence > 0 || snapshot.approvals.length > 0) this.hooks.acceptInput(binding, snapshot.status.sessionId);
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
    this.mcpSessions.delete(binding.turn_id);
    this.cancelling.delete(binding.turn_id);
    if (result?.status === "completed") result = { ...result, text: result.text.replaceAll(this.contextToken(binding), "[redacted]") };
    const commit = this.db.transaction(() => {
      if (!this.db.prepare(`UPDATE lark_retained_turns SET finalized=1 WHERE turn_id=? AND finalized=0`).run(binding.turn_id).changes) return;
      return { deliver: this.hooks.finish(binding, result) };
    })();
    if (!commit) return;
    this.hooks.ended(binding, result);
    commit.deliver?.();
  }
}
