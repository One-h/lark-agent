import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export type SourceThread = { id: string; cwd: string; status: { type: string }; archived?: boolean };
export interface AgentReplyBridge {
  inspect(threadId: string): Promise<SourceThread>;
  deliver(threadId: string, payload: unknown): Promise<string>;
}

// Connect to the existing desktop daemon. Never start a second server or resume a
// notLoaded thread: another desktop/CLI process may currently own that conversation.
export class DesktopReplyBridge implements AgentReplyBridge {
  constructor(private readonly socket = process.env.LARK_AGENT_CODEX_SOCKET
    ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "app-server-control/app-server-control.sock")) {}
  private async connect() {
    const ws = new WebSocket(`ws+unix://${this.socket}:/`, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    let next = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    ws.on("error", () => {});
    ws.on("close", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex 连接已断开。")); } pending.clear(); });
    ws.on("message", raw => {
      let value: any; try { value = JSON.parse(raw.toString()); } catch { return; }
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) entry.reject(new Error("Codex 拒绝了会话请求，请检查来源会话状态。")); else entry.resolve(value.result);
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("无法连接 Codex 本地服务。"))); });
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex 会话请求超时。")); ws.terminate(); }, 10000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    try { await request("initialize", { clientInfo: { name: "lark_reply_router", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
    } catch (error) { ws.terminate(); throw error; }
    return { request, close: () => ws.close() };
  }
  async inspect(threadId: string): Promise<SourceThread> {
    const connection = await this.connect();
    try { return (await connection.request("thread/read", { threadId, includeTurns: false })).thread; }
    finally { connection.close(); }
  }
  async deliver(threadId: string, payload: unknown) {
    const connection = await this.connect();
    try {
      const { thread } = await connection.request("thread/read", { threadId, includeTurns: false });
      if (thread.archived || !["idle", "active"].includes(thread.status?.type)) throw new SourceNotLoadedError();
      const response = await connection.request("turn/start", { threadId, input: [], toolOutput: {
        name: "lark_colleague_reply", output: JSON.stringify({ trust: "third-party-message-data", ...payload as object })
      } });
      return response.turn?.id ?? "queued";
    } finally { connection.close(); }
  }
}
export class SourceNotLoadedError extends Error { constructor() { super("原会话由其他进程管理或未加载；已保留消息，等待原 Agent 领取。"); } }
