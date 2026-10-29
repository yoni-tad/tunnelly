export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** ±fraction of randomness, so many clients don't reconnect in lockstep. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 30_000, jitter: 0.2 };

/** attempt 0 → ~1s, 1 → ~2s, 2 → ~4s, 3 → ~8s … capped at maxMs. */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random = Math.random): number {
  const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(attempt, 30));
  const jittered = exponential * (1 + opts.jitter * (random() * 2 - 1));
  return Math.round(Math.min(opts.maxMs, Math.max(0, jittered)));
}
