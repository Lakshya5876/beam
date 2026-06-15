import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter — per-IP fixed window', () => {
  it('allows up to the cap then denies within the window', () => {
    const limiter = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    expect(limiter.check('1.1.1.1', 0)).toBe(true);
    expect(limiter.check('1.1.1.1', 100)).toBe(true);
    expect(limiter.check('1.1.1.1', 200)).toBe(true);
    expect(limiter.check('1.1.1.1', 300)).toBe(false); // 4th in-window → denied
  });

  it('resets after the window elapses', () => {
    const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
    expect(limiter.check('1.1.1.1', 0)).toBe(true);
    expect(limiter.check('1.1.1.1', 500)).toBe(true);
    expect(limiter.check('1.1.1.1', 600)).toBe(false);
    // New window starts at >= 1000ms after the first.
    expect(limiter.check('1.1.1.1', 1000)).toBe(true);
  });

  it('tracks each IP independently', () => {
    const limiter = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    expect(limiter.check('1.1.1.1', 0)).toBe(true);
    expect(limiter.check('1.1.1.1', 10)).toBe(false);
    // A different IP has its own budget.
    expect(limiter.check('2.2.2.2', 10)).toBe(true);
  });
});
