export type RecoverySample = { ok: boolean; activeTurns: number };

// Missing health is not evidence that a possibly-running paid task is idle.
// Restart only after repeated failures, with a shared startup/restart budget.
export class RecoveryPolicy {
  private failures = 0;
  private starts: number[];

  constructor(starts: number[] = []) {
    this.starts = starts.filter(start => Number.isFinite(start) && start >= 0);
  }

  snapshot(): number[] { return [...this.starts]; }

  reserveStart(now: number): boolean {
    this.starts = this.starts.filter(start => now - start < 3_600_000);
    if (this.starts.length >= 3 || this.starts.some(start => now - start < 60_000)) return false;
    this.starts.push(now);
    return true;
  }

  observe(sample: RecoverySample | null, now: number): boolean {
    if (sample?.ok) { this.failures = 0; return false; }
    this.failures++;
    if (!sample || sample.activeTurns !== 0 || this.failures < 3 || !this.reserveStart(now)) return false;
    this.failures = 0;
    return true;
  }
}
