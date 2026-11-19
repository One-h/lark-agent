import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type LoadSessionResponse, type NewSessionResponse, type PromptResponse, type SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { ExecutionEngine, ExecutionEngineEvent, LarkExecutionPolicy } from "./executionEngines.js";

const promptText = (text: string) => [{ type: "text" as const, text }];

function supportsOwnedClaudeSteering(version: string | undefined): boolean {
  const [, minor, patch] = /^0\.(\d+)\.(\d+)$/.exec(version ?? "") ?? [];
  // 0.81.1 keeps the prompt pending until the injected message has a result.
  return Number(minor) > 81 || Number(minor) === 81 && Number(patch) >= 1;
}

function supportsNativeClaudePolicy(policy: LarkExecutionPolicy): boolean {
  // ACP tool permission callbacks do not enforce an OS read-only boundary.
  return policy.trustScope === "trusted" && policy.sandbox === "danger-full-access" && policy.approvalPolicy === "never";
}

export function createClaudeExecutionEngine(options: { launcher: string; models: string[] }): ExecutionEngine {
  if (!path.isAbsolute(options.launcher)) throw new Error("Claude launcher must be an absolute path");
  const launcher = realpathSync(options.launcher);
  if (!statSync(launcher).isFile()) throw new Error("Invalid Claude launcher");
  accessSync(launcher, constants.X_OK);
  return {
    descriptor: { id: "claude", label: "Claude Code", models: [...new Set(options.models)] },
    supportsPolicy: supportsNativeClaudePolicy,
    async open({ sessionId, model, policy, signal }) {
      signal.throwIfAborted();
      if (!supportsNativeClaudePolicy(policy)) throw new Error("Claude cannot enforce this execution policy");
      const { cwd } = policy;
      if (!path.isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error("Invalid shared workspace");
      const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR"]
        .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
      const child = spawn(launcher, [], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
      let id = sessionId;
      let answer: string | null = null;
      let emit: ((event: ExecutionEngineEvent) => void) | undefined;
      let turnPermissionSignal: AbortSignal | null = null;
      const connection = client()
        .onRequest("session/request_permission", ({ params, signal: requestSignal }) => {
          const option = id && params.sessionId === id && turnPermissionSignal && !turnPermissionSignal.aborted && !requestSignal.aborted
            ? params.options.find(candidate => candidate.kind === "allow_once") : undefined;
          return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
        })
        .onNotification("session/update", ({ params: { sessionId: updatedId, update } }) => {
          if (updatedId === id && answer !== null && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            answer = (answer + update.content.text).slice(0, 40_000);
            emit?.({ type: "text-delta", text: update.content.text });
          }
        })
        .connect(ndJsonStream(Writable.toWeb(child.stdin) as Parameters<typeof ndJsonStream>[0],
          Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1]));
      const peer = connection.agent;
      const close = () => {
        turnPermissionSignal = null;
        connection.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      };
      child.once("error", () => connection.close(new Error("Claude ACP launcher failed")));
      signal.addEventListener("abort", close, { once: true });
      const startupTimer = setTimeout(close, 15_000);
      try {
        const hello = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        if (hello.protocolVersion !== 1) throw new Error("Claude ACP protocol version is unsupported");
        const request = { cwd, mcpServers: [] };
        const options = sessionId
          ? await (async () => {
              if (!hello.agentCapabilities?.loadSession) throw new Error("Claude ACP cannot restore the saved session");
              const result = await peer.request<LoadSessionResponse>("session/load", { ...request, sessionId });
              return result.configOptions;
            })()
          : await (async () => {
              const result = await peer.request<NewSessionResponse>("session/new", request);
              id = result.sessionId;
              return result.configOptions;
            })();
        if (!id) throw new Error("Claude ACP returned no session ID");
        const activeId = id;
        if (model) {
          const option = options?.find(item => item.category === "model");
          if (!option) throw new Error("Claude ACP did not advertise a model selector");
          const result = await peer.request<SetSessionConfigOptionResponse>("session/set_config_option", { sessionId: activeId, configId: option.id, value: model });
          const selected = result.configOptions?.find(item => item.id === option.id);
          if (!selected || !("currentValue" in selected) || selected.currentValue !== model) throw new Error("Claude ACP did not confirm the requested model");
        }
        const steering = supportsOwnedClaudeSteering(hello.agentInfo?.version)
          && (hello._meta?.steering as { supported?: boolean } | undefined)?.supported === true;
        signal.removeEventListener("abort", close);
        signal.throwIfAborted();
        return {
          id: activeId,
          async run(text, turnSignal, onEvent) {
            turnSignal.throwIfAborted();
            const cancel = () => {
              void peer.notify("session/cancel", { sessionId: activeId }).catch(() => {});
            };
            turnSignal.addEventListener("abort", cancel, { once: true });
            answer = "";
            emit = onEvent;
            turnPermissionSignal = turnSignal;
            try {
              const result = await peer.request<PromptResponse>("session/prompt", { sessionId: activeId, prompt: promptText(text) });
              if (result.stopReason === "cancelled") return { status: "cancelled" };
              if (result.stopReason !== "end_turn") throw new Error("Claude ACP turn did not finish normally");
              return { status: "completed", text: answer ?? "" };
            } finally { turnPermissionSignal = null; turnSignal.removeEventListener("abort", cancel); answer = null; emit = undefined; }
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
          close() { signal.removeEventListener("abort", close); close(); }
        };
      } catch (error) {
        signal.removeEventListener("abort", close);
        close();
        throw error;
      } finally { clearTimeout(startupTimer); }
    }
  };
}
