import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CodexAppServerClient, unicodeSafePrefix, type CodexAppServerNotification } from "@lark-agent/adapter-codex-app-server";
import type { ExecutionEngine, ExecutionEngineEvent, ExecutionEngineSession, ExecutionTurnResult, LarkExecutionPolicy } from "@lark-agent/conversation-runtime";

const textLimit = 24_000;
const rpcTimeout = 10_000;
const interruptTimeout = 4_000;
const restrictedConfig = {
  "features.apps": false, "features.plugins": false, "features.hooks": false,
  "features.browser_use": false, "features.browser_use_external": false, "features.computer_use": false,
  "features.skill_mcp_dependency_install": false, web_search: "disabled"
};

type NativeItem = { type?: unknown; phase?: unknown; text?: unknown; content?: unknown };
type NativeTurn = { id?: string; status?: string; items?: NativeItem[] };
type NativeThread = { id?: string; cwd?: string; status?: { type?: string }; turns?: NativeTurn[] };
type RetainedDispatch = { key: string; recordNativeIdentity(identity: { sessionId: string; turnId: string | null }): unknown };
type TaskCodexOpen = Parameters<ExecutionEngine["open"]>[0] & { retainedDispatch?: RetainedDispatch };
type NativeSandbox = { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: false };
type ActiveTurn = { turnId?: string; terminal: boolean; signal: AbortSignal; done?: Promise<ExecutionTurnResult> };
type NativeEvent = { turnId: string } & (
  | { kind: "delta"; text: string; truncated: boolean }
  | { kind: "answer"; text: string; final: boolean }
  | { kind: "terminal"; status?: string; answer?: string }
);

function supportsPolicy(policy: LarkExecutionPolicy): boolean {
  return isAbsolute(policy.cwd) && !policy.cwd.includes("\0") && (
    policy.trustScope === "trusted" && policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never"
    || policy.trustScope === "untrusted" && policy.sandbox === "read-only" && policy.approvalPolicy === "on-request");
}

function sameDirectory(actual: unknown, expected: string): boolean {
  try { return typeof actual === "string" && isAbsolute(actual) && realpathSync(actual) === realpathSync(expected); }
  catch { return false; }
}

function containsInitialInput(item: NativeItem | undefined, text: string): boolean {
  return item?.type === "userMessage" && Array.isArray(item.content) && item.content.length === 1
    && item.content[0]?.type === "text" && item.content[0].text === text;
}

function textInput(text: string) {
  if (typeof text !== "string" || text.length > textLimit || !text.trim() || /[\uD800-\uDFFF]/u.test(text)) {
    throw new Error("Codex input must be non-blank, well-formed text of at most 24000 UTF-16 code units");
  }
  return [{ type: "text", text }];
}

function answer(item?: NativeItem): string | undefined {
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
  const data = params as { threadId?: string; turnId?: string; turn?: NativeTurn; delta?: unknown; item?: NativeItem } | undefined;
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

// Startup overrides remove inherited servers before the restricted process opens a thread.
export function createTaskRestrictedCodexPool(env?: () => NodeJS.ProcessEnv) {
  const clients = new Map<string, CodexAppServerClient>();
  return {
    get(cwd: string, disabled: Record<string, false>) {
      const overrides = Object.keys(disabled).sort().map(key => key + "=false");
      const key = JSON.stringify(overrides);
      const previous = clients.get(key);
      if (previous) return previous;
      if (clients.size >= 8) throw new Error("Too many distinct restricted Codex configurations");
      const created = new CodexAppServerClient(() => cwd, { env,
        config: () => [...Object.entries(restrictedConfig).map(([name, value]) => name + "=" + JSON.stringify(value)), ...overrides] });
      clients.set(key, created);
      return created;
    },
    close() { for (const client of clients.values()) client.stop(); clients.clear(); }
  };
}

async function mcpEntries(client: CodexAppServerClient, cwd: string): Promise<Record<string, unknown>> {
  const effective = await client.requestIfRunning<{ config?: Record<string, unknown> }>("config/read", { cwd, includeLayers: false }, rpcTimeout);
  const config = effective?.config;
  const mcp = config?.mcp_servers;
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (mcp != null && (typeof mcp !== "object" || Array.isArray(mcp)))) throw new Error("Codex restricted tasks require verifiable MCP configuration");
  return (mcp ?? {}) as Record<string, unknown>;
}

// The host owns the trusted client and isolated restricted client lifetimes.
export function createTaskCodexEngine(baseClient: CodexAppServerClient, models: readonly string[] = [],
  restrictedPool?: ReturnType<typeof createTaskRestrictedCodexPool>): ExecutionEngine {
  const configuredModels = [...models];
  const ownedThreads = new Set<string>();
  return {
    descriptor: { id: "codex", label: "Codex", models: configuredModels },
    supportsPolicy,
    async open({ sessionId, model, policy, signal, mcpServers, retainedDispatch }: TaskCodexOpen) {
      if (!supportsPolicy(policy) || mcpServers?.length) throw new Error("Codex task engine cannot enforce requested execution policy or MCP servers");
      if (model !== null && !configuredModels.includes(model)) throw new Error("Codex task model is not configured");
      signal.throwIfAborted();
      const { cwd, sandbox } = policy;
      const restricted = policy.trustScope === "untrusted";
      let disabledMcp: Record<string, false> = {};
      if (restricted) {
        await baseClient.start();
        const names = Object.keys(await mcpEntries(baseClient, cwd));
        if (names.length > 100 || names.some(name => !/^[A-Za-z0-9_-]{1,100}$/.test(name)))
          throw new Error("Codex cannot disable inherited MCP configuration");
        disabledMcp = Object.fromEntries(names.map(name => [`mcp_servers.${name}.enabled`, false]));
      }
      signal.throwIfAborted();
      const client = restricted ? restrictedPool?.get(cwd, disabledMcp) ?? baseClient : baseClient;
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
        const confirmedDisabled = new Set<string>();
        if (restricted && client !== baseClient) {
          for (const [name, entry] of Object.entries(await mcpEntries(client, cwd))) {
            if (!Object.hasOwn(disabledMcp, `mcp_servers.${name}.enabled`)
              || !entry || typeof entry !== "object" || (entry as { enabled?: unknown }).enabled !== false)
              throw new Error("Codex restricted process has an enabled MCP server");
            confirmedDisabled.add(name);
          }
        }
        // Authorization to dispatch is not permission to elevate a native operation.
        const approvalPolicy = "never";
        const sandboxPolicy: NativeSandbox = restricted ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" };
        if (sessionId !== null) {
          const existing = await client.requestIfRunning<{ thread?: NativeThread }>("thread/read", { threadId: sessionId, includeTurns: false }, rpcTimeout);
          if (existing?.thread?.id !== sessionId || !sameDirectory(existing.thread.cwd, cwd)) {
            throw new Error("Codex could not verify the original thread identity and workspace");
          }
          if (existing.thread.status?.type === "active") throw new Error("Resumed Codex thread is not idle");
        }
        signal.throwIfAborted();
        const opened = await client.requestIfRunning<{
          thread?: NativeThread; cwd?: string; model?: string;
          sandbox?: { type?: string; networkAccess?: boolean }; approvalPolicy?: string;
        }>(sessionId === null ? "thread/start" : "thread/resume", {
          ...(sessionId === null ? { ephemeral: false, allowProviderModelFallback: false } : { threadId: sessionId, excludeTurns: true }),
          cwd, model, approvalPolicy, approvalsReviewer: "user", sandbox,
          ...(restricted ? { config: { ...restrictedConfig, ...disabledMcp } } : {})
        }, rpcTimeout);
        const nativeId = opened?.thread?.id;
        if (typeof nativeId !== "string" || !nativeId || (sessionId !== null ? nativeId !== sessionId : ownedThreads.has(nativeId))) {
          throw new Error("Codex did not return the requested thread identity");
        }
        id = nativeId;
        attached = true;
        ownedThreads.add(id);
        signal.throwIfAborted();
        if (!sameDirectory(opened?.cwd, cwd) || !sameDirectory(opened?.thread?.cwd, cwd)
          || opened?.sandbox?.type !== sandboxPolicy.type || restricted && opened.sandbox.networkAccess !== false || opened.approvalPolicy !== approvalPolicy
          || (model !== null && opened.model !== model)) throw new Error("Codex did not confirm the requested execution policy or model");
        if (sessionId !== null && opened.thread?.status?.type !== "idle") throw new Error("Resumed Codex thread is not idle");
        if (restricted) {
          type InventoryEntry = { name?: unknown; authStatus?: unknown; tools?: unknown; resources?: unknown; resourceTemplates?: unknown };
          const inventory = await client.requestIfRunning<{ data?: InventoryEntry[]; nextCursor?: unknown }>("mcpServerStatus/list",
            { threadId: id, detail: "toolsAndAuthOnly", limit: 100 }, rpcTimeout);
          // App Server may include disabled config entries in its inventory.
          if (!Array.isArray(inventory?.data) || inventory.nextCursor != null || inventory.data.some(entry =>
            !entry || typeof entry.name !== "string" || !confirmedDisabled.has(entry.name) || entry.authStatus !== "unsupported"
            || !entry.tools || typeof entry.tools !== "object" || Object.keys(entry.tools).length
            || entry.resources != null && (!Array.isArray(entry.resources) || entry.resources.length)
            || entry.resourceTemplates != null && (!Array.isArray(entry.resourceTemplates) || entry.resourceTemplates.length))) {
            throw new Error("Codex did not confirm that the restricted thread has no MCP servers");
          }
        }
        signal.throwIfAborted();
        retainedDispatch?.recordNativeIdentity({ sessionId: id, turnId: null });
        return codexSession(client, id, cwd, model, sandboxPolicy, retainedDispatch, () => disconnected, release);
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
    }
  };
}

function codexSession(client: CodexAppServerClient, id: string, cwd: string, model: string | null, sandboxPolicy: NativeSandbox,
  dispatch: RetainedDispatch | undefined, disconnected: () => boolean, release: () => Promise<void>): ExecutionEngineSession {
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
    // clientUserMessageId is accepted by turn/start but not part of native turn readback.
    const dispatchInput = dispatch && `[Lark task dispatch: ${dispatch.key}]\n\n${input[0].text}`;
    let observedTurnId: string | undefined, ambiguous = false;
    const observeInput = (turnId: string, items: NativeItem[]) => {
      if (!dispatchInput || !containsInitialInput(items[0], dispatchInput)) return;
      if (observedTurnId && observedTurnId !== turnId) ambiguous = true;
      else observedTurnId = turnId;
    };
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
      if (dispatchInput && !current.turnId) {
        const data = notification.params as { threadId?: string; turnId?: string; turn?: NativeTurn; item?: NativeItem } | undefined;
        if (data?.threadId === id) {
          if ((notification.method === "item/started" || notification.method === "item/completed") && typeof data.turnId === "string" && data.item) {
            observeInput(data.turnId, [data.item]);
          }
          if ((notification.method === "turn/started" || notification.method === "turn/completed")
            && typeof data.turn?.id === "string" && Array.isArray(data.turn.items)) observeInput(data.turn.id, data.turn.items);
        }
      }
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
    let transportError: Error | undefined;
    const offExit = client.onExit(error => {
      transportError = error;
      if (current.turnId) fail(error);
    });
    current.signal.addEventListener("abort", interrupt, { once: true });
    try {
      let turn: NativeTurn | undefined;
      try {
        const started = await client.requestIfRunning<{ turn?: NativeTurn }>("turn/start", {
          threadId: id, cwd, model, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy,
          ...(dispatch && dispatchInput ? { input: [{ type: "text", text: dispatchInput }], clientUserMessageId: dispatch.key } : { input })
        }, rpcTimeout);
        turn = started?.turn;
      } catch (error) {
        if (!dispatchInput) throw error;
      }
      if (typeof turn?.id !== "string" || !turn.id) {
        if (dispatchInput && !ambiguous && (!observedTurnId || !early.some(event => event.turnId === observedTurnId && event.kind === "terminal"))) {
          const history = await client.requestIfRunning<{ thread?: NativeThread }>("thread/read", { threadId: id, includeTurns: true }, interruptTimeout).catch(() => null);
          if (history?.thread?.id === id && sameDirectory(history.thread.cwd, cwd) && Array.isArray(history.thread.turns)) {
            for (const candidate of history.thread.turns.slice(-128)) {
              if (typeof candidate?.id !== "string" || !Array.isArray(candidate.items)) continue;
              observeInput(candidate.id, candidate.items);
              if (candidate.id === observedTurnId) turn = candidate;
            }
          }
        }
        if (!ambiguous && observedTurnId && turn?.id !== observedTurnId) turn = { id: observedTurnId };
      }
      if (ambiguous || typeof turn?.id !== "string" || !turn.id || observedTurnId && observedTurnId !== turn.id) {
        throw new Error("Codex did not confirm the turn identity");
      }
      current.turnId = turn.id;
      dispatch?.recordNativeIdentity({ sessionId: id, turnId: turn.id });
      if (overflow) throw new Error("Codex sent too many notifications before confirming the turn");
      for (const event of early) apply(event);
      if (turn.status && turn.status !== "inProgress") apply(terminal({ ...turn, id: turn.id }));
      if (!current.terminal && transportError) throw transportError;
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
