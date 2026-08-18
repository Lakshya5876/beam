import { describe, expect, it } from 'vitest';
import {
  CachingTurnProvider,
  mintFailed,
  mintOk,
  REFRESH_MARGIN_MS,
  type TurnMintResult,
  type TurnProvider,
} from '../src/turn-provider.js';

/** Counts mints so cache hits are observable, not inferred. */
class CountingProvider implements TurnProvider {
  public calls = 0;
  private resolvers: Array<() => void> = [];

  constructor(
    private readonly result: (nowMs: number, call: number) => TurnMintResult,
    private readonly deferred = false,
  ) {}

  mint(nowMs: number): Promise<TurnMintResult> {
    this.calls += 1;
    const call = this.calls;
    if (!this.deferred) {
      return Promise.resolve(this.result(nowMs, call));
    }
    return new Promise<TurnMintResult>((resolve) => {
      this.resolvers.push(() => { resolve(this.result(nowMs, call)); });
    });
  }

  releaseAll(): void {
    const pending = this.resolvers.splice(0);
    for (const release of pending) release();
  }
}

function mintedAt(expiresAtMs: number): TurnMintResult {
  return mintOk({ iceServers: [{ urls: 'turn:a:80', username: 'u', credential: 'c' }], expiresAtMs });
}

describe('CachingTurnProvider', () => {
  it('mints once and serves subsequent requests from cache', async () => {
    const inner = new CountingProvider(() => mintedAt(10_000_000));
    const provider = new CachingTurnProvider(inner);

    await provider.mint(0);
    await provider.mint(1_000);
    await provider.mint(2_000);

    expect(inner.calls).toBe(1);
  });

  it('re-mints once the credential is inside the refresh margin', async () => {
    const expiresAtMs = 10_000_000;
    const inner = new CountingProvider(() => mintedAt(expiresAtMs));
    const provider = new CachingTurnProvider(inner);

    await provider.mint(0);
    // Still outside the margin — cached.
    await provider.mint(expiresAtMs - REFRESH_MARGIN_MS - 1);
    expect(inner.calls).toBe(1);

    // Inside the margin — refreshed before it can be handed out nearly expired.
    await provider.mint(expiresAtMs - REFRESH_MARGIN_MS);
    expect(inner.calls).toBe(2);
  });

  it('honours a custom refresh margin', async () => {
    const inner = new CountingProvider(() => mintedAt(1_000));
    const provider = new CachingTurnProvider(inner, 100);

    await provider.mint(0);
    await provider.mint(899);
    expect(inner.calls).toBe(1);
    await provider.mint(900);
    expect(inner.calls).toBe(2);
  });

  it('collapses concurrent misses onto a single upstream mint', async () => {
    // The host and viewer of one session hit /ice-config near-simultaneously.
    const inner = new CountingProvider(() => mintedAt(10_000_000), true);
    const provider = new CachingTurnProvider(inner);

    const all = Promise.all([provider.mint(0), provider.mint(0), provider.mint(0)]);
    inner.releaseAll();
    const results = await all;

    expect(inner.calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('does not cache a failure — the next request retries', async () => {
    let first = true;
    const inner = new CountingProvider(() => {
      if (first) {
        first = false;
        return mintFailed('provider-unreachable');
      }
      return mintedAt(10_000_000);
    });
    const provider = new CachingTurnProvider(inner);

    await expect(provider.mint(0)).resolves.toEqual({ ok: false, failure: 'provider-unreachable' });
    await expect(provider.mint(1)).resolves.toMatchObject({ ok: true });
    expect(inner.calls).toBe(2);
  });

  it('recovers after an in-flight mint rejects rather than wedging forever', async () => {
    let attempt = 0;
    const inner: TurnProvider = {
      mint: () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(mintedAt(10_000_000));
      },
    };
    const provider = new CachingTurnProvider(inner);

    await expect(provider.mint(0)).rejects.toThrow('boom');
    await expect(provider.mint(1)).resolves.toMatchObject({ ok: true });
  });
});
