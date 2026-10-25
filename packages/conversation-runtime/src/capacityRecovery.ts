export function isLarkModelCapacityError(error: { message?: unknown; codexErrorInfo?: unknown }): boolean {
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? (info as { type?: unknown }).type : null;
  if (code === "serverOverloaded") return true;
  // Do not classify quota, authorization, or arbitrary tool errors as capacity failures.
  return code == null && typeof error.message === "string"
    && /^(?:Selected model is at capacity\b|Model capacity exceeded\b)/i.test(error.message);
}

export function larkCapacityRetryDelayMs(attempt: number, random = Math.random): number | null {
  const delay = [30_000, 60_000, 120_000][attempt - 1];
  return delay === undefined ? null : Math.round(delay * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
}
