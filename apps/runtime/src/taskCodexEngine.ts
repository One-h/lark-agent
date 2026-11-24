import { isAbsolute } from "node:path";
import { unicodeSafePrefix, type CodexAppServerClient, type CodexAppServerNotification } from "@lark-agent/adapter-codex-app-server";
import type { ExecutionEngine, ExecutionEngineEvent, ExecutionEngineSession, ExecutionTurnResult, LarkExecutionPolicy } from "@lark-agent/conversation-runtime";

const textLimit = 24_000;
const rpcTimeout = 10_000;
const interruptTimeout = 4_000;

type AgentItem = { type?: unknown; phase?: unknown; text?: unknown };
type NativeTurn = { id?: string; status?: string; items?: AgentItem[] };
type ActiveTurn = { turnId?: string; terminal: boolean; signal: AbortSignal; done?: Promise<ExecutionTurnResult> };
type NativeEvent = { turnId: string } & (
  | { kind: "delta"; text: string; truncated: boolean }
  | { kind: "answer"; text: string; final: boolean }
  | { kind: "terminal"; status?: string; answer?: string }
);

function supportsPolicy(policy: LarkExecutionPolicy): boolean {
  return policy.trustScope === "trusted" && policy.sandbox === "danger-full-access"
    && policy.approvalPolicy === "never" && isAbsolute(policy.cwd);
}

function textInput(text: string) {
  if (typeof text !== "string" || text.length > textLimit || !text.trim() || /[\uD800-\uDFFF]/u.test(text)) {
    throw new Error("Codex input must be non-blank, well-formed text of at most 24000 UTF-16 code units");
  }
  return [{ type: "text", text }];
}

function answer(item?: AgentItem): string | undefined {
  if (item?.type === "agentMessage" && (item.phase === "final_answer" || item.phase == null) && typeof item.text === "string") {
    return unicodeSafePrefix(item.text, textLimit);
  }
}

function terminal(turn: NativeTurn & { id: string }): NativeEvent {
  let final: string | undefined, unphased: string | undefined;
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    const text = answer(item);
    if (text === undefined) continue;
    if (item.phase === "final_answer") final = text;
    else unphased = text;
  }
  return { kind: "terminal", turnId: turn.id, status: turn.status, answer: final ?? unphased };
}

function turnEvent(threadId: string, { method, params }: CodexAppServerNotification): NativeEvent | undefined {
  const data = params as { threadId?: string; turnId?: string; turn?: NativeTurn; delta?: unknown; item?: AgentItem } | undefined;
  if (data?.threadId !== threadId) return;
  if (method === "turn/completed" && typeof data.turn?.id === "string") return terminal({ ...data.turn, id: data.turn.id });
  if (typeof data.turnId !== "string") return;
  if (method === "item/agentMessage/delta" && typeof data.delta === "string") {
    return { kind: "delta", turnId: data.turnId, text: unicodeSafePrefix(data.delta, textLimit), truncated: data.delta.length > textLimit };
  }
  if (method === "item/completed") {
    const text = answer(data.item);
    if (text !== undefined) return { kind: "answer", turnId: data.turnId, text, final: data.item?.phase === "final_answer" };
  }
}

// The host owns the client lifetime and supplies a client dedicated to these sessions.
export function createTaskCodexEngine(client: CodexAppServerClient, models: readonly string[] = []): ExecutionEngine {
  const configuredModels = [...models];
  const ownedThreads = new Set<string>();
  return {
    descriptor: { id: "codex", label: "Codex", models: configuredModels },
    supportsPolicy,
    async open({ sessionId, model, policy, signal, mcpServers }) {
      if (!supportsPolicy(policy) || mcpServers?.length) throw new Error("Codex task engine cannot enforce requested execution policy or MCP servers");
      if (model !== null && !configuredModels.includes(model)) throw new Error("Codex task model is not configured");
      signal.throwIfAborted();
      if (sessionId !== null && (!sessionId.trim() || ownedThreads.has(sessionId))) throw new Error("Invalid or already open Codex thread");
      let id = sessionId, attached = false, disconnected = false;
      if (id !== null) ownedThreads.add(id);
      const offExit = client.onExit(() => { disconnected = true; });
      const release = async () => {
        try {
          if (attached && !disconnected) await client.requestIfRunning("thread/unsubscribe", { threadId: id }, interruptTimeout);
        } finally {
          offExit();
          if (id !== null) ownedThreads.delete(id);
        }
      };
      try {
        await client.start();
        signal.throwIfAborted();
        const { cwd, approvalPolicy, sandbox } = policy;
        const opened = await client.requestIfRunning<{
          thread?: { id?: string; status?: { type?: string } };
          model?: string; sandbox?: { type?: string }; approvalPolicy?: string;
        }>(sessionId === null ? "thread/start" : "thread/resume", {
          ...(sessionId === null ? { ephemeral: false, allowProviderModelFallback: false } : { threadId: sessionId, excludeTurns: true }),
          cwd, model, approvalPolicy, approvalsReviewer: "user", sandbox
        }, rpcTimeout);
        const nativeId = opened?.thread?.id;
        if (typeof nativeId !== "string" || !nativeId || (sessionId !== null ? nativeId !== sessionId : ownedThreads.has(nativeId))) {
          throw new Error("Codex did not return the requested thread identity");
        }
        id = nativeId;
        attached = true;
        ownedThreads.add(id);
        signal.throwIfAborted();
        if (opened?.sandbox?.type !== "dangerFullAccess" || opened.approvalPolicy !== approvalPolicy
          || (model !== null && opened.model !== model)) throw new Error("Codex did not confirm the requested execution policy or model");
        if (sessionId !== null && opened.thread?.status?.type !== "idle") throw new Error("Resumed Codex thread is not idle");
        return codexSession(client, id, cwd, model, () => disconnected, release);
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
    }
  };
}

function codexSession(client: CodexAppServerClient, id: string, cwd: string, model: string | null,
  disconnected: () => boolean, release: () => Promise<void>): ExecutionEngineSession {
  const lifetime = new AbortController();
  let active: ActiveTurn | undefined;
  let closing: Promise<void> | undefined, uncertain = false;

  return {
    id,
    async run(text, signal, onEvent) {
      if (lifetime.signal.aborted || disconnected() || uncertain) throw new Error("Codex session is unavailable");
      if (active) throw new Error("Codex session already has an active turn");
      const input = textInput(text);
      if (signal.aborted) return { status: "cancelled" };
      const current: ActiveTurn = { terminal: false, signal: AbortSignal.any([signal, lifetime.signal]) };
      active = current;
      current.done = runNative(current, input, onEvent).finally(() => { active = undefined; });
      return current.done;
    },
    async steer(text, signal) {
      const input = textInput(text);
      signal.throwIfAborted();
      if (lifetime.signal.aborted || disconnected() || uncertain) throw new Error("Codex session is unavailable");
      const turnId = active?.turnId;
      if (!active || !turnId || active.terminal || active.signal.aborted) return "idle";
      const accepted = await client.requestIfRunning<{ turnId?: string }>("turn/steer", { threadId: id, expectedTurnId: turnId, input }, rpcTimeout);
      if (accepted?.turnId !== turnId) throw new Error("Codex did not confirm steering the expected turn");
      return "injected";
    },
    close() {
      return closing ??= (async () => {
        lifetime.abort();
        await active?.done?.catch(() => {});
        await release();
      })();
    }
  };

  async function runNative(current: ActiveTurn, input: ReturnType<typeof textInput>, onEvent?: (event: ExecutionEngineEvent) => void) {
    let finish!: (result: ExecutionTurnResult) => void, fail!: (error: unknown) => void;
    const completed = new Promise<ExecutionTurnResult>((resolve, reject) => { finish = resolve; fail = reject; });
    void completed.catch(() => {});
    let streamed = 0, buffered = 0, overflow = false, final: string | undefined, unphased: string | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    const early: NativeEvent[] = [];
    const interrupt = () => {
      if (!current.turnId || current.terminal || interruptTimer) return;
      interruptTimer = setTimeout(() => fail(new Error("Codex did not confirm turn interruption")), interruptTimeout);
      void client.requestIfRunning("turn/interrupt", { threadId: id, turnId: current.turnId }, interruptTimeout).catch(() => {});
    };
    const apply = (event: NativeEvent) => {
      if (current.terminal || event.turnId !== current.turnId) return;
      if (event.kind === "delta") {
        const delta = unicodeSafePrefix(event.text, textLimit - streamed);
        streamed += delta.length;
        if (event.truncated || delta.length < event.text.length) streamed = textLimit;
        if (delta && !current.signal.aborted) onEvent?.({ type: "text-delta", text: delta });
      } else if (event.kind === "answer") {
        if (event.final) final = event.text;
        else unphased = event.text;
      } else {
        current.terminal = true;
        if (event.status === "completed") finish({ status: "completed", text: final ?? event.answer ?? unphased ?? "" });
        else if (event.status === "interrupted") finish({ status: "cancelled" });
        else fail(new Error("Codex turn did not complete successfully"));
      }
    };
    const offNotification = client.onNotification(notification => {
      const event = turnEvent(id, notification);
      if (!event) return;
      try {
        if (current.turnId) apply(event);
        else {
          // Stdio can deliver notifications in the same read as the RPC acknowledgement.
          buffered += ("text" in event ? event.text : event.answer)?.length ?? 0;
          if (early.length >= 128 || buffered > 128_000) overflow = true;
          else early.push(event);
        }
      } catch (error) { fail(error); }
    });
    const offExit = client.onExit(fail);
    current.signal.addEventListener("abort", interrupt, { once: true });
    try {
      const started = await client.requestIfRunning<{ turn?: NativeTurn }>("turn/start", {
        threadId: id, cwd, model, input, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" }
      }, rpcTimeout);
      const turn = started?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("Codex did not confirm the turn identity");
      current.turnId = turn.id;
      if (overflow) throw new Error("Codex sent too many notifications before confirming the turn");
      for (const event of early) apply(event);
      if (turn.status && turn.status !== "inProgress") apply(terminal({ ...turn, id: turn.id }));
      if (current.signal.aborted) interrupt();
      return await completed;
    } catch (error) {
      if (!current.terminal) {
        uncertain = true;
        interrupt();
      }
      throw error;
    } finally {
      clearTimeout(interruptTimer);
      current.signal.removeEventListener("abort", interrupt);
      offNotification();
      offExit();
    }
  }
}
