/**
 * Pure PIN-pairing helpers for the session Durable Object.
 * Depends only on the Web Crypto API (available in both CF Workers and Node 18+).
 */

export const PIN_HASH_KEY = 'pin-hash';
export const PIN_ATTEMPTS_KEY = 'pin-attempts';
export const PIN_MAX_ATTEMPTS = 3;

/**
 * Returns SHA-256(pin + ":" + salt) as a 64-char lowercase hex string.
 * Salt is the session code — binds the stored hash to a specific session.
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${pin}:${salt}`);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
