import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveCodexExecutable } from "./executable.js";

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
    private readonly launch: { config?: () => string[]; env?: () => NodeJS.ProcessEnv } = {}
  ) {}

  status(): { running: boolean; pid: number | null; lastError: string | null } {
    return {
      running: Boolean(this.process && !this.process.killed),
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
    if (!this.process || this.process.killed) {
      return null;
    }
    return this.requestStarted<T>(method, params, timeoutMs);
  }

  async start(): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  stop(): void {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    this.rejectPending(new Error("Codex app-server stopped"));
  }

  private async startProcess(): Promise<void> {
    this.stopping = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.lastError = null;
    const child = spawn(resolveCodexExecutable(), codexAppServerArgs(this.launch.config?.() ?? []), {
      cwd: this.cwd(),
      env: this.launch.env?.() ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk.toString()));
    child.on("error", (error) => this.handleExit(child, error));
    child.on("close", (code, signal) => {
      this.flushStderrBuffer();
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleExit(child, new Error(`Codex app-server exited with ${detail}`));
    });

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
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
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
      try {
        this.handleMessage(JSON.parse(trimmed) as RpcResponse | CodexAppServerRequest | CodexAppServerNotification);
      } catch (error) {
        this.lastError = `Invalid Codex app-server JSON: ${error instanceof Error ? error.message : String(error)}`;
      }
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
