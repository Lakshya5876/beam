import { describe, expect, it } from 'vitest';
import { hashPin, PIN_HASH_KEY, PIN_ATTEMPTS_KEY, PIN_MAX_ATTEMPTS } from '../src/pin-store.js';

describe('hashPin', () => {
  it('returns a 64-char lowercase hex string (SHA-256)', async () => {
    const result = await hashPin('123456', 'mycode');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs always produce the same hash', async () => {
    const a = await hashPin('847291', 'sessionabc');
    const b = await hashPin('847291', 'sessionabc');
    expect(a).toBe(b);
  });

  it('produces different hashes for different PINs', async () => {
    const a = await hashPin('111111', 'session1');
    const b = await hashPin('999999', 'session1');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different session codes (salt effect)', async () => {
    const a = await hashPin('123456', 'codeA');
    const b = await hashPin('123456', 'codeB');
    expect(a).not.toBe(b);
  });
});

describe('pin-store constants', () => {
  it('exports PIN_HASH_KEY, PIN_ATTEMPTS_KEY, PIN_MAX_ATTEMPTS', () => {
    expect(typeof PIN_HASH_KEY).toBe('string');
    expect(typeof PIN_ATTEMPTS_KEY).toBe('string');
    expect(PIN_MAX_ATTEMPTS).toBe(3);
  });
});
