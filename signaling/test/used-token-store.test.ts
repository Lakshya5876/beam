import { describe, expect, it } from 'vitest';
import { mintUnusedCode } from '../src/session-code.js';
import { StorageUsedTokenStore, type TokenPersister } from '../src/used-token-store.js';

function fakePersister(): { persister: TokenPersister; puts: string[] } {
  const puts: string[] = [];
  return { persister: { put: (code) => puts.push(code) }, puts };
}

describe('StorageUsedTokenStore', () => {
  it('reports a hydrated code as used and never re-persists it', () => {
    const { persister, puts } = fakePersister();
    const store = new StorageUsedTokenStore(new Set(['existing']), persister);
    expect(store.has('existing')).toBe(true);
    store.add('existing'); // already known -> no persist
    expect(puts).toEqual([]);
  });

  it('adds a new code to the set and persists it exactly once', () => {
    const { persister, puts } = fakePersister();
    const store = new StorageUsedTokenStore(new Set(), persister);
    store.add('fresh');
    store.add('fresh'); // idempotent
    expect(store.has('fresh')).toBe(true);
    expect(puts).toEqual(['fresh']);
  });

  it('integrates with mintUnusedCode: a hydrated (already-used) code is skipped and the mint is persisted', () => {
    const { persister, puts } = fakePersister();
    // Pre-load one code as used; feed the generator that code first, then a fresh one.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const used = 'a'.repeat(26);
    const fresh = 'b'.repeat(26);
    const sequence = [used, fresh];
    let i = 0;
    const random = (): Uint8Array => {
      const code = sequence[Math.min(i, sequence.length - 1)] as string;
      i += 1;
      return new Uint8Array(code.split('').map((ch) => alphabet.indexOf(ch)));
    };
    const store = new StorageUsedTokenStore(new Set([used]), persister);
    const minted = mintUnusedCode(store, random);
    expect(minted).toBe(fresh);
    expect(puts).toEqual([fresh]); // only the freshly-minted code is persisted
  });
});
