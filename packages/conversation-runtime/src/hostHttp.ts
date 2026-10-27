import http from "node:http";
import https from "node:https";

// Approval can wait ten minutes. Unlike fetch, this has no hidden headers deadline.
export function postHostJson(url: string, payload: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol)) return reject(new Error("Unsupported host protocol"));
    const body = JSON.stringify(payload);
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "POST", headers: { "content-type": "application/json", ...headers, "content-length": String(Buffer.byteLength(body)) }, signal
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const status = response.statusCode ?? 500;
        resolve({ ok: status >= 200 && status < 300, status, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.once("error", reject);
    request.end(body);
  });
}
