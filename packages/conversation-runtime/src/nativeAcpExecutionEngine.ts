import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type LoadSessionResponse, type NewSessionResponse, type PromptResponse, type ResumeSessionResponse, type SetSessionConfigOptionResponse, type ToolKind } from "@agentclientprotocol/sdk";
import { maxReviewedOperationChars } from "./approvalPlan.js";
import type { ExecutionEngine, ExecutionEngineEvent, ExecutionWorkStage, LarkExecutionPolicy } from "./executionEngines.js";

const promptText = (text: string) => [{ type: "text" as const, text }];
const profiles = {
  claude: { label: "Claude Code", args: [], env: ["CLAUDE_CONFIG_DIR"] },
  dsh: { label: "DeepSeek Harness", args: ["--profile", "acp"], env: ["DSH_HOME"] },
  opencode: { label: "OpenCode", args: ["acp"], env: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] },
  agy: { label: "Antigravity CLI", args: ["acp", "--disable-telemetry"], env: [] }
} as const;
export type NativeAcpEngineId = keyof typeof profiles;

function workStage(kind: ToolKind | null | undefined): ExecutionWorkStage {
  if (kind === "read" || kind === "execute" || kind === "search") return kind;
  if (kind === "fetch") return "search";
  if (kind === "edit" || kind === "move" || kind === "delete") return "change";
  return "other";
}

function supportsOwnedClaudeSteering(version: string | undefined): boolean {
  const [, minor, patch] = /^0\.(\d+)\.(\d+)$/.exec(version ?? "") ?? [];
  // 0.81.1 keeps the prompt pending until the injected message has a result.
  return Number(minor) > 81 || Number(minor) === 81 && Number(patch) >= 1;
}

function supportsNativeAcpPolicy(policy: LarkExecutionPolicy): boolean {
  return policy.trustScope === "trusted" && policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never";
}

function executable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("ACP launcher must be an absolute path");
  const launcher = realpathSync(value);
  if (!statSync(launcher).isFile()) throw new Error("Invalid ACP launcher");
  accessSync(launcher, constants.X_OK);
  return launcher;
}

type PermissionTool = { name?: string | null; title?: string | null; rawInput?: unknown; _meta?: Record<string, unknown> | null };

function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, orderedJson(child)]));
  return value;
}

function permissionOperation(engineId: NativeAcpEngineId, tool: PermissionTool): string | undefined {
  const meta = tool._meta?.claudeCode as { toolName?: unknown } | undefined;
  const name = tool.name ?? (engineId === "claude" && typeof meta?.toolName === "string" ? meta.toolName : tool.title);
  if (!name || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name) || !tool.rawInput
    || typeof tool.rawInput !== "object" || Array.isArray(tool.rawInput)) return;
  try {
    const text = `acp.${engineId}.${name}: ${JSON.stringify(orderedJson(tool.rawInput))}`;
    return text.length <= maxReviewedOperationChars ? text : undefined;
  } catch { return; }
}

export function createNativeAcpExecutionEngine(engineId: NativeAcpEngineId, options: { launcher: string; models: string[]; restrictedLauncher?: string }): ExecutionEngine {
  const profile = profiles[engineId];
  const launcher = executable(options.launcher);
  const restrictedLauncher = options.restrictedLauncher ? executable(options.restrictedLauncher) : undefined;
  if (restrictedLauncher === launcher) throw new Error("Restricted ACP requires a distinct operator-managed executable");
  const supportsPolicy = (policy: LarkExecutionPolicy) => supportsNativeAcpPolicy(policy)
    || Boolean(restrictedLauncher && policy.trustScope === "untrusted" && policy.sandbox === "read-only" && policy.approvalPolicy === "on-request");
  return {
    descriptor: { id: engineId, label: profile.label, models: [...new Set(options.models)] },
    supportsLarkMcp: true,
    supportsNativeApproval: Boolean(restrictedLauncher),
    supportsPolicy,
    async open({ sessionId, model, policy, signal, mcpServers, authorizeNative }) {
      signal.throwIfAborted();
      const restricted = policy.trustScope === "untrusted";
      if (!supportsPolicy(policy) || restricted && !authorizeNative) throw new Error(`${profile.label} cannot enforce this execution policy`);
      const { cwd } = policy;
      if (!path.isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error("Invalid shared workspace");
      const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", ...profile.env]
        .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
      if (restricted && engineId === "dsh") env.DSH_PERMISSION_MODE = "read-only";
      const child = spawn(restricted ? restrictedLauncher! : launcher, profile.args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
      let id = sessionId;
      let output: { text: string; messageId?: string; retiredMessages: Set<string>; tools: Set<string>;
        permissionTools: Map<string, { operation: string; cancelled: AbortController }>; requestedPermissions: Set<string>;
        emit?: (event: ExecutionEngineEvent) => void } | null = null;
      let turnPermissionSignal: AbortSignal | null = null;
      const isOpenCodeChild = (meta?: Record<string, unknown> | null) =>
        engineId === "opencode" && Boolean(meta?.["opencode/child-session"]);
      const connection = client()
        .onRequest("session/request_permission", async ({ params, signal: requestSignal }) => {
          const cancel = { outcome: { outcome: "cancelled" as const } };
          const turn = turnPermissionSignal, current = output;
          if (!id || params.sessionId !== id || !turn || turn.aborted || requestSignal.aborted || !current
            || isOpenCodeChild(params.toolCall._meta) || (params.toolCall._meta?.claudeCode as { parentToolUseId?: unknown } | undefined)?.parentToolUseId)
            return cancel;
          const option = params.options.find(candidate => candidate.kind === "allow_once");
          if (!option) return cancel;
          if (restricted && authorizeNative) {
            const callId = params.toolCall.toolCallId;
            const record = current.permissionTools.get(callId);
            if (!record || current.requestedPermissions.has(callId)) return cancel;
            if (params.toolCall.rawInput !== undefined && permissionOperation(engineId, params.toolCall) !== record.operation) return cancel;
            current.requestedPermissions.add(callId);
            const lifetime = AbortSignal.any([turn, requestSignal, record.cancelled.signal]);
            const stillCurrent = () => !lifetime.aborted && output === current && turnPermissionSignal === turn
              && current.permissionTools.get(callId) === record;
            try {
              if (!await authorizeNative({ engineId, text: record.operation, cwd }, lifetime, stillCurrent) || !stillCurrent()) return cancel;
            } catch { return cancel; }
          }
          return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
        })
        .onNotification("session/update", ({ params: { sessionId: updatedId, update } }) => {
          if (updatedId !== id || !output || isOpenCodeChild(update._meta)) return;
          const meta = engineId === "claude" ? update._meta?.claudeCode as { parentToolUseId?: unknown; kind?: unknown } | undefined : undefined;
          if (meta?.parentToolUseId || meta?.kind === "informational" || meta?.kind === "mcpServerStatus") return;
          if (restricted && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
            const record = output.permissionTools.get(update.toolCallId);
            if (record && (update.status === "completed" || update.status === "failed" || update.rawInput !== undefined
              && permissionOperation(engineId, update) !== record.operation)) {
              record.cancelled.abort();
              output.permissionTools.delete(update.toolCallId);
            } else if (!record && update.sessionUpdate === "tool_call" && !output.tools.has(update.toolCallId)
              && (update.status == null || update.status === "pending" || update.status === "in_progress") && output.permissionTools.size < 256) {
              const operation = permissionOperation(engineId, update);
              if (operation) output.permissionTools.set(update.toolCallId, { operation, cancelled: new AbortController() });
            }
          }
          if (update.sessionUpdate === "tool_call" && !output.tools.has(update.toolCallId)
            && (update.status == null || update.status === "pending" || update.status === "in_progress")
            && update.kind !== "think" && update.kind !== "switch_mode") {
            output.tools.add(update.toolCallId);
            // Text leading into a tool call is commentary, not the terminal answer.
            output.text = "";
            if (output.messageId) output.retiredMessages.add(output.messageId);
            output.messageId = undefined;
            output.emit?.({ type: "work", stage: workStage(update.kind) });
            return;
          }
          if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text" || !update.content.text
            || update.content.annotations?.audience?.includes("user") === false) return;
          if (update.messageId && output.retiredMessages.has(update.messageId)) return;
          if (update.messageId && update.messageId !== output.messageId) {
            if (output.messageId) output.retiredMessages.add(output.messageId);
            output.text = "";
            output.messageId = update.messageId;
          }
          output.text = (output.text + update.content.text).slice(0, 40_000);
          output.emit?.({ type: "text-delta", text: update.content.text });
        })
        .connect(ndJsonStream(Writable.toWeb(child.stdin) as Parameters<typeof ndJsonStream>[0],
          Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1]));
      const peer = connection.agent;
      const terminate = () => {
        turnPermissionSignal = null;
        connection.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      };
      child.once("error", () => connection.close(new Error(`${profile.label} ACP launcher failed`)));
      signal.addEventListener("abort", terminate, { once: true });
      const startupTimer = setTimeout(terminate, 15_000);
      try {
        const hello = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: { session: { notices: {} } } });
        if (hello.protocolVersion !== 1) throw new Error("ACP protocol version is unsupported");
        const request = { cwd, mcpServers: mcpServers ?? [] };
        const options = sessionId
          ? await (async () => {
              if (engineId !== "claude" && hello.agentCapabilities?.sessionCapabilities?.resume != null) {
                const result = await peer.request<ResumeSessionResponse>("session/resume", { ...request, sessionId });
                return result.configOptions;
              }
              if (!hello.agentCapabilities?.loadSession) throw new Error("ACP agent cannot restore the saved session");
              const result = await peer.request<LoadSessionResponse>("session/load", { ...request, sessionId });
              return result.configOptions;
            })()
          : await (async () => {
              const result = await peer.request<NewSessionResponse>("session/new", request);
              id = result.sessionId;
              return result.configOptions;
            })();
        if (!id) throw new Error("ACP agent returned no session ID");
        const activeId = id;
        if (model) {
          const option = options?.find(item => item.category === "model");
          if (!option) throw new Error("ACP agent did not advertise a model selector");
          const result = await peer.request<SetSessionConfigOptionResponse>("session/set_config_option", { sessionId: activeId, configId: option.id, value: model });
          const selected = result.configOptions?.find(item => item.id === option.id);
          if (!selected || !("currentValue" in selected) || selected.currentValue !== model) throw new Error("ACP agent did not confirm the requested model");
        }
        const steering = !restricted && engineId === "claude" && supportsOwnedClaudeSteering(hello.agentInfo?.version)
          && (hello._meta?.steering as { supported?: boolean } | undefined)?.supported === true;
        signal.removeEventListener("abort", terminate);
        signal.throwIfAborted();
        let closing: Promise<void> | undefined;
        return {
          id: activeId,
          async run(text, turnSignal, onEvent) {
            turnSignal.throwIfAborted();
            const cancel = () => {
              void peer.notify("session/cancel", { sessionId: activeId }).catch(() => {});
            };
            turnSignal.addEventListener("abort", cancel, { once: true });
            const turnOutput = { text: "", tools: new Set<string>(), retiredMessages: new Set<string>(), emit: onEvent,
              permissionTools: new Map<string, { operation: string; cancelled: AbortController }>(), requestedPermissions: new Set<string>() };
            output = turnOutput;
            turnPermissionSignal = turnSignal;
            try {
              const result = await peer.request<PromptResponse>("session/prompt", { sessionId: activeId, prompt: promptText(text) });
              if (result.stopReason === "cancelled") return { status: "cancelled" };
              turnSignal.throwIfAborted();
              if (result.stopReason !== "end_turn") throw new Error("ACP turn did not finish normally");
              return { status: "completed", text: turnOutput.text };
            } finally {
              turnPermissionSignal = null;
              turnSignal.removeEventListener("abort", cancel);
              for (const record of turnOutput.permissionTools.values()) record.cancelled.abort();
              output = null;
            }
          },
          ...(steering ? {
            async steer(text: string, steerSignal: AbortSignal) {
              steerSignal.throwIfAborted();
              const result = await peer.request<{ outcome?: string }>("_session/steering", {
                sessionId: activeId, prompt: promptText(text), _meta: { steering: { idleBehavior: "promptRequired" } }
              }, { cancellationSignal: steerSignal, stopWaitingOnCancel: true });
              if (result.outcome === "injected") return "injected" as const;
              if (result.outcome === "promptRequired") return "idle" as const;
              throw new Error("Claude ACP did not confirm same-turn delivery");
            }
          } : {}),
          close() {
            turnPermissionSignal = null;
            if (closing) return closing;
            if (engineId === "claude" || hello.agentCapabilities?.sessionCapabilities?.close == null || child.exitCode !== null || child.signalCode !== null) {
              terminate();
              return;
            }
            // Release the saved session before the next process attempts to resume it.
            return closing = peer.request("session/close", { sessionId: activeId }, {
              cancellationSignal: AbortSignal.timeout(2_000), stopWaitingOnCancel: true
            }).then(terminate, terminate);
          }
        };
      } catch (error) {
        signal.removeEventListener("abort", terminate);
        terminate();
        throw error;
      } finally { clearTimeout(startupTimer); }
    }
  };
}

export function configuredNativeAcpEngines(env: NodeJS.ProcessEnv, invalidLauncher: (engineId: NativeAcpEngineId) => void): ExecutionEngine[] {
  const engines: ExecutionEngine[] = [];
  for (const id of Object.keys(profiles) as NativeAcpEngineId[]) {
    const prefix = `LARK_AGENT_${id.toUpperCase()}_ACP`;
    const launcher = env[`${prefix}_NATIVE_LAUNCHER`];
    if (!launcher) continue;
    const models = (env[`${prefix}_MODELS`] ?? "").split(",").map(model => model.trim()).filter(Boolean);
    const restrictedLauncher = env[`${prefix}_RESTRICTED_LAUNCHER`];
    try { engines.push(createNativeAcpExecutionEngine(id, { launcher, models, restrictedLauncher })); }
    catch {
      invalidLauncher(id);
      if (restrictedLauncher) {
        try { engines.push(createNativeAcpExecutionEngine(id, { launcher, models })); }
        catch { /* Neither configured path is usable. */ }
      }
    }
  }
  return engines;
}
