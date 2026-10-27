export type PromptInstructionSnapshot = {
  threadId: string;
  fingerprint: string;
  included: boolean;
  epoch: object;
};

// A cache miss only causes a safe refresh. Never infer delivery from preparation.
export class PromptInstructionCache {
  private readonly entries = new Map<string, { fingerprint?: string }>();

  constructor(private readonly limit = 256) {}

  prepare(threadId: string, fingerprint: string, force = false): PromptInstructionSnapshot {
    const entry = this.entries.get(threadId) ?? {};
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return { threadId, fingerprint, included: force || entry.fingerprint !== fingerprint, epoch: entry };
  }

  accept(snapshot: PromptInstructionSnapshot): void {
    const entry = this.entries.get(snapshot.threadId);
    // A compaction or process reset during an RPC must not restore a stale mark.
    if (entry && entry === snapshot.epoch && snapshot.included) entry.fingerprint = snapshot.fingerprint;
  }

  invalidate(threadId: string): void { this.entries.delete(threadId); }
  clear(): void { this.entries.clear(); }
}
