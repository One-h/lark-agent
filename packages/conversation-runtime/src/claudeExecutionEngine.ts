import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type LoadSessionResponse, type NewSessionResponse, type PromptResponse, type SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { ExecutionEngine, ExecutionEngineEvent } from "./executionEngines.js";

const promptText = (text: string) => [{ type: "text" as const, text }];

function supportsOwnedClaudeSteering(version: string | undefined): boolean {
  const [, minor, patch] = /^0\.(\d+)\.(\d+)$/.exec(version ?? "") ?? [];
  // 0.81.1 keeps the prompt pending until the injected message has a result.
  return Number(minor) > 81 || Number(minor) === 81 && Number(patch) >= 1;
}

export function createClaudeExecutionEngine(options: { launcher: string; cwd: string; models: string[] }): ExecutionEngine {
  if (!path.isAbsolute(options.launcher) || !path.isAbsolute(options.cwd)) throw new Error("Claude launcher and workspace must be absolute paths");
  const launcher = realpathSync(options.launcher);
  const cwd = realpathSync(options.cwd);
  if (!statSync(launcher).isFile() || !statSync(cwd).isDirectory()) throw new Error("Invalid Claude launcher or workspace");
  accessSync(launcher, constants.X_OK);
  return {
    descriptor: { id: "claude", label: "Claude Code", models: [...new Set(options.models)] },
    async open({ sessionId, model, signal }) {
      signal.throwIfAborted();
      // The operator-owned launcher supplies isolated storage, sandboxing, and Claude authentication.
      const child = spawn(launcher, [], { cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] });
      let id = sessionId;
      let answer: string | null = null;
      let emit: ((event: ExecutionEngineEvent) => void) | undefined;
      const connection = client()
        .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
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
            try {
              const result = await peer.request<PromptResponse>("session/prompt", { sessionId: activeId, prompt: promptText(text) });
              if (result.stopReason === "cancelled") return { status: "cancelled" };
              if (result.stopReason !== "end_turn") throw new Error("Claude ACP turn did not finish normally");
              return { status: "completed", text: answer ?? "" };
            } finally { turnSignal.removeEventListener("abort", cancel); answer = null; emit = undefined; }
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
