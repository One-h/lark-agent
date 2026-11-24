import { randomUUID } from "node:crypto";
import type { ExecutionEngine, ExecutionEngineEvent, ExecutionNativeApproval, ExecutionTurnResult } from "./executionEngines.js";

type OpenOptions = Omit<Parameters<ExecutionEngine["open"]>[0], "signal" | "authorizeNative">;
type NativeOperation = Parameters<ExecutionNativeApproval>[0];
type Event = { sequence: number; event: ExecutionEngineEvent };
type Approval = { id: string; operation: NativeOperation };
type PendingApproval = { approval: Approval; answer: (allow: boolean) => boolean; stillCurrent: () => boolean };
type Status = { state: "starting" } | { state: "active"; sessionId: string }
  | { state: "finished"; sessionId: string; result: ExecutionTurnResult }
  | { state: "failed"; sessionId: string | null }
  | { state: "acknowledged"; sessionId: string | null };
type Turn = {
  engineId: string;
  status: Status;
  controller: AbortController;
  events: Event[];
  retainedTextChars: number;
  sequence: number;
  approvals: Map<string, PendingApproval>;
  done: Promise<void>;
};

// Owned by the process that owns the engine connection, not by a Lark subscriber.
export class RetainedExecutionTurns {
  private readonly turns = new Map<string, Turn>();
  private readonly boundSessions = new Set<string>();
  private stopping = false;

  constructor(private readonly limits = { turns: 64, eventsPerTurn: 512, rememberedIds: 16_384 }) {}

  start(id: string, engine: ExecutionEngine, options: OpenOptions, text: string, duration?: number): void {
    if (this.stopping) throw new Error("Execution host is stopping");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || this.turns.has(id)) throw new Error("Invalid or existing execution turn ID");
    if (this.turns.size >= this.limits.rememberedIds
      || [...this.turns.values()].filter(turn => turn.status.state !== "acknowledged").length >= this.limits.turns) {
      throw new Error("Execution host is at capacity");
    }
    const turn: Turn = {
      engineId: engine.descriptor.id, status: { state: "starting" }, controller: new AbortController(),
      events: [], retainedTextChars: 0, sequence: 0, approvals: new Map(), done: Promise.resolve()
    };
    this.turns.set(id, turn);
    const timer = duration === undefined ? undefined : setTimeout(() => turn.controller.abort(), duration).unref();
    turn.done = this.run(turn, engine, options, text).finally(() => clearTimeout(timer));
  }

  attach(id: string, afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Invalid execution event cursor");
    const turn = this.turns.get(id);
    if (!turn) return null;
    if (afterSequence > turn.sequence) throw new Error("Execution event cursor is ahead of the retained turn");
    return {
      engineId: turn.engineId,
      status: turn.status,
      sequence: turn.sequence,
      gap: afterSequence < (turn.events[0]?.sequence ?? (turn.sequence + 1)) - 1,
      events: turn.events.filter(entry => entry.sequence > afterSequence),
      approvals: [...turn.approvals.values()].filter(entry => entry.stillCurrent()).map(entry => entry.approval)
    };
  }

  answerApproval(id: string, requestId: string, allow: boolean): boolean {
    const turn = this.turns.get(id);
    return turn?.status.state === "active" && (turn.approvals.get(requestId)?.answer(allow) ?? false);
  }

  cancel(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn) {
      if (this.turns.size >= this.limits.rememberedIds) return false;
      this.turns.set(id, { engineId: "", status: { state: "acknowledged", sessionId: null }, controller: new AbortController(),
        events: [], retainedTextChars: 0, sequence: 0, approvals: new Map(), done: Promise.resolve() });
      return true;
    }
    if (turn.status.state !== "active" && turn.status.state !== "starting") return false;
    turn.controller.abort();
    return true;
  }

  // Keep the turn ID reserved until this host exits. Late retries cannot start it twice.
  async acknowledge(id: string): Promise<boolean> {
    const turn = this.turns.get(id);
    if (turn?.status.state === "acknowledged") return true;
    if (!turn || turn.status.state !== "finished" && turn.status.state !== "failed") return false;
    const sessionId = turn.status.sessionId;
    await turn.done;
    turn.events = [];
    turn.retainedTextChars = 0;
    turn.status = { state: "acknowledged", sessionId };
    return true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const turn of this.turns.values()) turn.controller.abort();
    await Promise.all([...this.turns.values()].map(turn => turn.done));
  }

  private async run(turn: Turn, engine: ExecutionEngine, options: OpenOptions, text: string): Promise<void> {
    let session: Awaited<ReturnType<ExecutionEngine["open"]>> | undefined;
    let sessionKey: string | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    const closeSession = () => closing ??= Promise.resolve().then(() => session?.close()).catch(() => {});
    const closeOnAbort = () => { closeTimer = setTimeout(() => { void closeSession(); }, 5_000).unref(); };
    const bindSession = (sessionId: string) => {
      const key = JSON.stringify([engine.descriptor.id, sessionId]);
      if (this.boundSessions.has(key)) throw new Error("Execution engine session is already active");
      this.boundSessions.add(key);
      sessionKey = key;
    };
    try {
      if (options.sessionId !== null) bindSession(options.sessionId);
      const authorizeNative: ExecutionNativeApproval = (operation, signal, stillCurrent) => {
        if (turn.status.state !== "active" || signal.aborted || !stillCurrent()) return Promise.resolve(false);
        const id = randomUUID();
        return new Promise<boolean>(resolve => {
          const active = () => turn.status.state === "active" && !signal.aborted && !turn.controller.signal.aborted && stillCurrent();
          const done = (result: boolean) => {
            turn.approvals.delete(id);
            signal.removeEventListener("abort", abort);
            turn.controller.signal.removeEventListener("abort", abort);
            resolve(result);
          };
          const abort = () => done(false);
          turn.approvals.set(id, {
            approval: { id, operation },
            stillCurrent: active,
            answer: allow => {
              if (!active() || !turn.approvals.has(id)) return false;
              done(allow);
              return true;
            }
          });
          signal.addEventListener("abort", abort, { once: true });
          turn.controller.signal.addEventListener("abort", abort, { once: true });
        });
      };
      session = await engine.open({ ...options, signal: turn.controller.signal, authorizeNative });
      turn.controller.signal.throwIfAborted();
      if (options.sessionId === null) bindSession(session.id);
      else if (options.sessionId !== session.id) throw new Error("Execution engine returned a different session");
      turn.status = { state: "active", sessionId: session.id };
      turn.controller.signal.addEventListener("abort", closeOnAbort, { once: true });
      const result = await session.run(text, turn.controller.signal, event => {
        turn.events.push({ sequence: ++turn.sequence, event });
        if (event.type === "text-delta") turn.retainedTextChars += event.text.length;
        while (turn.events.length > this.limits.eventsPerTurn || turn.retainedTextChars > 128_000) {
          const removed = turn.events.shift()?.event;
          if (removed?.type === "text-delta") turn.retainedTextChars -= removed.text.length;
        }
      });
      turn.status = { state: "finished", sessionId: session.id, result };
    } catch {
      turn.status = { state: "failed", sessionId: session?.id ?? null };
    } finally {
      turn.controller.signal.removeEventListener("abort", closeOnAbort);
      clearTimeout(closeTimer);
      turn.controller.abort();
      await closeSession();
      if (sessionKey) this.boundSessions.delete(sessionKey);
    }
  }
}
