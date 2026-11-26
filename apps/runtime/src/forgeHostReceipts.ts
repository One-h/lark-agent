import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import { postHostJson } from "@lark-agent/conversation-runtime";

type Receipt = { host_request_id: string; status: string; result_json: string | null; error: string | null; host_started_at: string };
const unknown = "未能确认原宿主操作的结果；没有重新执行。";

export class ForgeHostReceipts {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly reading = new Map<string, Promise<void>>();

  constructor(private readonly db: Database.Database, hostUrl: string, token: string, private readonly lifetime: AbortSignal) {
    this.base = hostUrl.replace(/\/$/, "") + "/api/lark-agent";
    this.headers = { authorization: `Bearer ${token}` };
  }

  private get(path: string) {
    return fetch(this.base + path, { headers: this.headers, redirect: "error",
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(3_000)]) });
  }

  async supported(): Promise<boolean> {
    const r = await this.get("/requests/protocol");
    if (r.status === 404) { await r.body?.cancel(); return false; }
    if (!r.ok || (await r.json() as { version?: unknown }).version !== 1) throw Error("宿主回执协议未能确认，未提交操作。");
    return true;
  }

  async execute(capability: string, turnId: string, inputHash: string, key: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.lifetime.throwIfAborted();
    const id = randomUUID();
    const registered = this.db.prepare(`UPDATE lark_capability_invocations SET host_request_id=?,host_receipt_key=?,host_started_at=?
      WHERE turn_id=? AND capability_id=? AND input_hash=? AND status='running' AND host_request_id IS NULL`)
      .run(id, key, new Date().toISOString(), turnId, capability, inputHash);
    if (registered.changes !== 1) throw Error("原宿主请求未能登记，未提交操作。");
    const waitSignal = AbortSignal.any([signal, this.lifetime]);
    // Admission is attempted only once. Even a lost acknowledgement leads only to receipt reads.
    try {
      await postHostJson(`${this.base}/capabilities/${encodeURIComponent(capability)}`, body, { ...this.headers, "x-lark-request-id": id },
        AbortSignal.any([waitSignal, AbortSignal.timeout(6_000)]));
    } catch { /* The owner may have accepted the original request. */ }
    for (;;) {
      waitSignal.throwIfAborted();
      const receipt = await this.read(key);
      if (!receipt) throw Error(unknown);
      if (receipt.status === "completed") return JSON.parse(receipt.result_json ?? "null");
      if (receipt.status === "failed" || receipt.status === "unknown") throw Error(receipt.error ?? unknown);
      await delay(1_000, undefined, { signal: waitSignal });
    }
  }

  async read(key: string): Promise<Receipt | undefined> {
    if (!this.db.open || this.lifetime.aborted) return;
    const row = () => this.db.prepare("SELECT host_request_id,status,result_json,error,host_started_at FROM lark_capability_invocations WHERE host_receipt_key=?").get(key) as Receipt | undefined;
    const receipt = row();
    if (!receipt || !["running", "unknown"].includes(receipt.status)) return receipt;
    await this.refresh(receipt);
    return this.db.open && !this.lifetime.aborted ? row() : undefined;
  }

  private refresh(receipt: Receipt): Promise<void> {
    const existing = this.reading.get(receipt.host_request_id);
    if (existing) return existing;
    const requested = this.readForge(receipt).finally(() => this.reading.delete(receipt.host_request_id));
    this.reading.set(receipt.host_request_id, requested);
    return requested;
  }

  private async readForge(receipt: Receipt): Promise<void> {
    let result: { state?: unknown; httpStatus?: unknown; body?: unknown } = {};
    let missing = false;
    try {
      const response = await this.get(`/requests/${receipt.host_request_id}`);
      if (response.ok) result = await response.json() as typeof result;
      else { missing = response.status === 404; await response.body?.cancel(); }
    } catch { /* Temporarily unreachable: keep the original request ID. */ }
    if (!this.db.open || this.lifetime.aborted) return;
    const age = Date.now() - Date.parse(receipt.host_started_at);
    const finished = result?.state === "finished" && typeof result.httpStatus === "number" && Number.isInteger(result.httpStatus);
    const success = finished && Number(result.httpStatus) >= 200 && Number(result.httpStatus) < 300;
    const checkedAt = new Date().toISOString();
    const unresolved = result?.state === "unknown" || missing && age > 30_000 || result?.state !== "running" && age >= 1_800_000;
    if (!finished && !unresolved) {
      this.db.prepare(`UPDATE lark_capability_invocations SET status=CASE WHEN ? THEN 'running' ELSE status END,
        host_checked_at=? WHERE host_request_id=? AND status IN ('running','unknown')`)
        .run(result?.state === "running" ? 1 : 0, checkedAt, receipt.host_request_id);
      return;
    }
    const error = success ? null : finished ? JSON.stringify(result.body ?? null) : unknown;
    this.db.prepare(`UPDATE lark_capability_invocations SET status=?,result_json=?,error=?,finished_at=?,host_checked_at=?
      WHERE host_request_id=? AND status IN ('running','unknown')`).run(finished ? success ? "completed" : "failed" : "unknown",
      success ? JSON.stringify(result.body ?? null) : null, error, finished ? checkedAt : null, checkedAt, receipt.host_request_id);
  }

  tick(): void {
    if (!this.db.open || this.lifetime.aborted || this.reading.size) return;
    const pending = this.db.prepare(`SELECT host_request_id,status,host_started_at FROM lark_capability_invocations
      WHERE host_request_id IS NOT NULL AND (status='running' OR (status='unknown' AND host_started_at>?
        AND (host_checked_at IS NULL OR host_checked_at<=?))) ORDER BY COALESCE(host_checked_at,host_started_at) LIMIT 8`)
      .all(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 60_000).toISOString()) as Receipt[];
    for (const receipt of pending) void this.refresh(receipt).catch(() => console.warn("lark_host_receipt_readback_failed"));
  }
}
