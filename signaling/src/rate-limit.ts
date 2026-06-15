/**
 * Per-IP fixed-window rate limiting (design §A.2.4). Pure accounting — time is
 * injected (nowMs), so it is deterministic and unit-testable. The Durable
 * Object drives it with real timestamps in S14b.
 */

export interface RateLimitOptions {
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

interface WindowState {
  start: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly options: RateLimitOptions) {}

  /** Record a request from `ip` at `nowMs`; returns true if within the cap. */
  check(ip: string, nowMs: number): boolean {
    const current = this.windows.get(ip);
    if (!current || nowMs - current.start >= this.options.windowMs) {
      this.windows.set(ip, { start: nowMs, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.options.maxPerWindow;
  }
}
