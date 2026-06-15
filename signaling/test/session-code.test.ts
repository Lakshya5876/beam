import { describe, expect, it } from 'vitest';
import {
  generateSessionCode,
  InMemoryUsedTokenStore,
  isValidSessionCode,
  mintUnusedCode,
  SESSION_CODE_PATTERN,
  type RandomBytes,
} from '../src/session-code.js';

describe('generateSessionCode', () => {
  it('produces a >=26-char lowercase-alphanumeric code (>=128 bits)', () => {
    const code = generateSessionCode();
    expect(code).toMatch(SESSION_CODE_PATTERN);
    expect(code.length).toBeGreaterThanOrEqual(26);
  });

  it('uses the full alphabet without modulo bias (rejects bytes >= 252)', () => {
    // A source that yields 251 (just below threshold) then 252/255 (rejected).
    // 251 % 36 = 35 -> 'z'. The rejected bytes must NOT appear as 252%36 etc.
    const bytes = [251, 252, 255];
    let i = 0;
    const random: RandomBytes = (length) => {
      const out = new Uint8Array(length);
      for (let j = 0; j < length; j += 1) {
        out[j] = bytes[i % bytes.length] as number;
        i += 1;
      }
      return out;
    };
    const code = generateSessionCode(random);
    // 251 % 36 = 35 -> alphabet index 35 = '9' (indices 26..35 are '0'..'9').
    // The 252 and 255 bytes are rejected (>= threshold), never mapped — so the
    // only symbol that appears is '9'. Were bias not removed, 252%36=0 ('a')
    // and 255%36=3 ('d') would also leak in.
    expect(code).toBe('9'.repeat(26));
  });

  it('is overwhelmingly unique across many draws (CSPRNG default)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateSessionCode());
    }
    expect(seen.size).toBe(1000);
  });
});

describe('isValidSessionCode', () => {
  it('accepts a valid code and rejects short/upper/symbol codes', () => {
    expect(isValidSessionCode('k7x2m9q4w8r3t6y1u5z0a2b4c7')).toBe(true);
    expect(isValidSessionCode('tooshort')).toBe(false);
    expect(isValidSessionCode('K7X2M9Q4W8R3T6Y1U5Z0A2B4C7')).toBe(false);
    expect(isValidSessionCode('k7x2m9q4w8r3t6y1u5z0a2b4c-')).toBe(false);
  });
});

describe('mintUnusedCode — never-reuse guard', () => {
  it('marks the minted code used so it is never issued again', () => {
    const store = new InMemoryUsedTokenStore();
    const code = mintUnusedCode(store);
    expect(code).not.toBeNull();
    if (code) {
      expect(store.has(code)).toBe(true);
    }
  });

  it('skips an already-used code and returns a fresh one', () => {
    const store = new InMemoryUsedTokenStore();
    const codes = [generateSessionCode(), generateSessionCode()];
    store.add(codes[0] as string); // pre-mark the first as used
    let i = 0;
    const random: RandomBytes = () => {
      // Deterministically feed the alphabet bytes for codes[0] then codes[1].
      const source = (codes[Math.min(i, 1)] as string)
        .split('')
        .map((ch) => 'abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(ch));
      i += 1;
      return new Uint8Array(source);
    };
    const minted = mintUnusedCode(store, random);
    expect(minted).toBe(codes[1]);
    expect(store.has(codes[1] as string)).toBe(true);
  });

  it('returns null after bounded attempts when every draw collides (never loops forever)', () => {
    const store = new InMemoryUsedTokenStore();
    const collision = generateSessionCode();
    store.add(collision);
    const alwaysCollide: RandomBytes = () =>
      new Uint8Array(collision.split('').map((ch) => 'abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(ch)));
    expect(mintUnusedCode(store, alwaysCollide, 4)).toBeNull();
  });
});
