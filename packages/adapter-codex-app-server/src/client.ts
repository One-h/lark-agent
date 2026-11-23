import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { resolveCodexExecutable } from "./executable.js";
import { serializeCodexAppServerMessage } from "./unicode.js";

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RpcResponse = {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function errorText(error: RpcResponse["error"]): string {
  if (!error) {
    return "Unknown Codex app-server error";
  }
  const suffix = error.data === undefined ? "" : `: ${JSON.stringify(error.data)}`;
  return `${error.message ?? `Codex app-server error ${error.code ?? "unknown"}`}${suffix}`;
}

export function codexAppServerStderrError(text: string): string | null {
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { level?: unknown };
      const level = typeof parsed.level === "string" ? parsed.level.toUpperCase() : "";
      if (level === "ERROR" || level === "FATAL") {
        errors.push(line);
      }
    } catch {
      if (/\b(?:error|fatal|panic)\b/i.test(line)) {
        errors.push(line);
      }
    }
  }
  return errors.length > 0 ? errors.join("\n") : null;
}

export function codexAppServerArgs(extraConfig: string[] = []): string[] {
  return ["app-server", "--disable", "hooks", "--listen", "stdio://", ...extraConfig.flatMap((value) => ["-c", value])];
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly requestListeners = new Set<(request: CodexAppServerRequest) => boolean>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly stderrListeners = new Set<(text: string) => void>();
  private lastError: string | null = null;
  private stopping = false;

  constructor(
    private readonly cwd: () => string,
    private readonly launch: { config?: () => string[]; env?: () => NodeJS.ProcessEnv; socketPath?: string } = {}
  ) {}

  status(): { running: boolean; pid: number | null; lastError: string | null } {
    return {
      running: this.initialized && Boolean(this.socket?.readyState === WebSocket.OPEN || this.process && !this.process.killed),
      pid: this.process?.pid ?? null,
      lastError: this.lastError
    };
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: CodexAppServerRequest) => boolean): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  respondToRequest(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  rejectRequest(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onStderr(listener: (text: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    await this.start();
    return this.requestStarted<T>(method, params, timeoutMs);
  }

  async requestIfRunning<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T | null> {
    if (!this.status().running) {
      return null;
    }
    return this.requestStarted<T>(method, params, timeoutMs);
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.status().running) return;

    this.startPromise = this.startTransport();
    try {
      await this.startPromise;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stop();
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  stop(): void {
    this.stopping = true;
    this.initialized = false;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    const child = this.process;
    this.process = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    this.rejectPending(new Error("Codex app-server stopped"));
  }

  private async startTransport(): Promise<void> {
    this.stopping = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.lastError = null;
    if (this.launch.socketPath) await this.connectSocket(this.launch.socketPath);
    else this.spawnProcess();
    await this.requestStarted("initialize", {
      clientInfo: {
        name: "lark_agent",
        title: "Lark Agent",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private spawnProcess(): void {
    const child = spawn(resolveCodexExecutable(), codexAppServerArgs(this.launch.config?.() ?? []), {
      cwd: this.cwd(),
      env: this.launch.env?.() ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.process === child) this.handleStdout(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.process === child) this.handleStderr(chunk);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("close", (code, signal) => {
      if (this.process === child) this.flushStderrBuffer();
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleExit(child, new Error(`Codex app-server exited with ${detail}`));
    });

  }

  private async connectSocket(socketPath: string): Promise<void> {
    if (!path.isAbsolute(socketPath) || /[:?#%]/.test(socketPath)) throw new Error("Invalid Codex App Server socket path");
    const uid = process.getuid?.();
    const privateDirectory = (candidate: string) => {
      const directory = lstatSync(candidate);
      return uid !== undefined && directory.isDirectory() && directory.uid === uid && (directory.mode & 0o077) === 0;
    };
    const target = realpathSync(socketPath);
    const endpoint = lstatSync(target);
    // Codex can use an alias to keep the actual Unix socket path short.
    if (!privateDirectory(path.dirname(socketPath)) || lstatSync(socketPath).uid !== uid
      || /[:?#%]/.test(target) || !privateDirectory(path.dirname(target)) || !endpoint.isSocket() || endpoint.uid !== uid) {
      throw new Error("Codex App Server socket must be in a private user-owned directory");
    }
    const socket = new WebSocket(`ws+unix://${target}:/`, { handshakeTimeout: 5_000, maxPayload: 32 * 1024 * 1024 });
    this.socket = socket;
    const disconnect = (error: Error) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleDisconnect(error);
    };
    socket.on("error", disconnect);
    socket.on("close", () => disconnect(new Error("Codex App Server socket closed")));
    socket.on("message", (data, binary) => {
      if (this.socket !== socket) return;
      if (binary) {
        socket.terminate();
        return;
      }
      this.handleJson(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Codex App Server socket closed before initialization")));
    });
  }

  private requestStarted<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        this.lastError = error.message;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        const cause = error instanceof Error ? error : new Error(String(error));
        this.lastError = cause.message;
        reject(cause);
      }
    });
  }

  private write(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serializeCodexAppServerMessage(message));
      return;
    }
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    child.stdin.write(`${serializeCodexAppServerMessage(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.handleJson(trimmed);
    }
  }

  private handleJson(json: string): void {
    try {
      this.handleMessage(JSON.parse(json) as RpcResponse | CodexAppServerRequest | CodexAppServerNotification);
    } catch (error) {
      this.lastError = `Invalid Codex app-server JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private handleStderr(chunk: string): void {
    if (!chunk) {
      return;
    }
    for (const listener of this.stderrListeners) {
      listener(chunk);
    }
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const error = codexAppServerStderrError(line);
      if (error) {
        this.lastError = error;
      }
    }
  }

  private flushStderrBuffer(): void {
    const error = codexAppServerStderrError(this.stderrBuffer);
    if (error) {
      this.lastError = error;
    }
    this.stderrBuffer = "";
  }

  private handleMessage(message: RpcResponse | CodexAppServerRequest | CodexAppServerNotification): void {
    if ("method" in message) {
      if ("id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
        const handled = [...this.requestListeners].some((listener) => listener(message));
        if (!handled) {
          this.rejectRequest(message.id, -32601, `Unsupported server request: ${message.method}`);
        }
        return;
      }
      for (const listener of this.notificationListeners) {
        listener(message);
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(errorText(message.error));
      this.lastError = error.message;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) {
      return;
    }
    this.process = null;
    this.handleDisconnect(error);
  }

  private handleDisconnect(error: Error): void {
    this.initialized = false;
    this.lastError = error.message;
    this.rejectPending(error);
    if (!this.stopping) {
      for (const listener of this.exitListeners) {
        listener(error);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
