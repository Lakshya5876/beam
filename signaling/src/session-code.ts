/**
 * Session-code generation and never-reuse guard (design §A.2.3, §A.5).
 *
 * Codes are >=128-bit, CSPRNG-derived, and match the domain SessionCode
 * charset/length ([a-z0-9], >=26 chars) so they parse cleanly on the host side
 * (S2/S8). The used-token guard guarantees a code is never reused; the DO backs
 * it with storage in S14b, but the accounting and the bounded mint loop live
 * here, pure and unit-tested.
 */

// 36-char alphabet == the domain SessionCode charset.
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// 26 chars * log2(36) ≈ 134 bits — above the 128-bit floor (design §5).
const CODE_LENGTH = 26;
// Largest multiple of 36 below 256; bytes >= this are rejected to remove the
// modulo bias, so every alphabet symbol is equiprobable.
const REJECTION_THRESHOLD = 256 - (256 % CODE_ALPHABET.length); // 252

export const SESSION_CODE_PATTERN = /^[a-z0-9]{26,}$/;

/** Injectable CSPRNG source (default: the runtime's Web Crypto). */
export type RandomBytes = (length: number) => Uint8Array;

const cryptoRandom: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  // Bare global `crypto` — Web Crypto, present in both Node 22 and the Workers
  // runtime (and declared by both @types/node and the generated Worker types).
  crypto.getRandomValues(bytes);
  return bytes;
};

/** Generate a fresh code via unbiased rejection sampling over the alphabet. */
export function generateSessionCode(random: RandomBytes = cryptoRandom): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH)) {
      if (byte < REJECTION_THRESHOLD) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (code.length === CODE_LENGTH) {
          break;
        }
      }
    }
  }
  return code;
}

export function isValidSessionCode(raw: string): boolean {
  return SESSION_CODE_PATTERN.test(raw);
}

/** Used-token store. Backed by Durable Object storage in S14b. */
export interface UsedTokenStore {
  has(code: string): boolean;
  add(code: string): void;
}

/** In-memory store for tests and single-instance use. */
export class InMemoryUsedTokenStore implements UsedTokenStore {
  private readonly used = new Set<string>();
  has(code: string): boolean {
    return this.used.has(code);
  }
  add(code: string): void {
    this.used.add(code);
  }
}

/**
 * Mint a code that has never been issued. Bounded retry (never infinite); with
 * 134-bit codes a collision is astronomically unlikely, so exhausting the
 * attempts returns null rather than looping. A returned code is marked used.
 */
export function mintUnusedCode(
  store: UsedTokenStore,
  random: RandomBytes = cryptoRandom,
  maxAttempts = 8,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateSessionCode(random);
    if (!store.has(code)) {
      store.add(code);
      return code;
    }
  }
  return null;
}
