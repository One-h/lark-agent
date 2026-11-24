import http from "node:http";
import path from "node:path";
import { lstatSync } from "node:fs";
import type { RetainedExecutionTurns } from "./retainedExecutionTurns.js";
import { retainedForegroundMcpContextToken } from "./retainedForegroundMcp.js";

export { retainedForegroundMcpBearer, retainedForegroundMcpPrompt } from "./retainedForegroundMcp.js";

export type RetainedHostConfig = { socketPath: string; token: string; engineIds: readonly string[] };
export type RetainedTurnSnapshot = NonNullable<ReturnType<RetainedExecutionTurns["attach"]>> & { foregroundLarkToolsActive?: boolean };
export type RetainedHostStatus = { generation: string; workspace: string; engines?: readonly { id: string; foregroundLarkTools?: boolean }[] };

export class RetainedHostError extends Error {
  constructor(readonly status: number) { super(`Retained engine host returned HTTP ${status}`); }
}

export class RetainedExecutionClient {
  constructor(private readonly config: RetainedHostConfig) {
    if (!path.isAbsolute(config.socketPath) || config.token.length < 32) throw new Error("Invalid retained engine host configuration");
  }

  supports(engineId: string): boolean { return this.config.engineIds.includes(engineId); }

  foregroundMcpContextToken(generation: string, turnId: string): string {
    return retainedForegroundMcpContextToken(this.config.token, generation, turnId);
  }

  call<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const dir = lstatSync(path.dirname(this.config.socketPath));
      const socket = lstatSync(this.config.socketPath);
      const uid = process.getuid?.();
      if (uid === undefined || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0
        || !socket.isSocket() || socket.uid !== uid) throw new Error("Engine host socket is not private");
      const payload = JSON.stringify(input);
      const request = http.request({ socketPath: this.config.socketPath, method: "POST", path: "/turns", signal,
        headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json",
          "content-length": Buffer.byteLength(payload) } }, response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2_000_000) response.destroy(new Error("Engine host response is too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new RetainedHostError(status));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
          catch (error) { reject(error); }
        });
      });
      request.setTimeout(4_000, () => request.destroy(new Error("Engine host request timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }
}
