import { describe, expect, it } from 'vitest';
import { parseSessionCodeFromUrl } from '../src/url.js';

const CODE = 'k7x2m9q4w8r3t6y1u5z0a2b4c7';

// Exact copy of S8 WebSocketSignalingClient.buildUrl (src/infrastructure/
// signaling-client.ts) — the reconciliation reference. parseSessionCodeFromUrl
// MUST recover the code from whatever this produces.
function s8BuildUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${code}`;
}

describe('parseSessionCodeFromUrl — byte-identical to S8 buildUrl', () => {
  it('recovers the code from a bare base (no path)', () => {
    expect(parseSessionCodeFromUrl(s8BuildUrl('wss://signal.beam.workers.dev', CODE))).toBe(CODE);
  });

  it('recovers the code from a base WITH a path prefix', () => {
    expect(parseSessionCodeFromUrl(s8BuildUrl('wss://signal.beam.workers.dev/signal', CODE))).toBe(CODE);
  });

  it('recovers the code when the base has a trailing slash (S8 strips it)', () => {
    expect(parseSessionCodeFromUrl(s8BuildUrl('wss://signal.beam.workers.dev/', CODE))).toBe(CODE);
    expect(parseSessionCodeFromUrl(s8BuildUrl('ws://127.0.0.1:9000/signal/', CODE))).toBe(CODE);
  });

  it('round-trips for ws and wss schemes and an IP host', () => {
    expect(parseSessionCodeFromUrl(s8BuildUrl('ws://127.0.0.1:8787', CODE))).toBe(CODE);
  });
});

describe('parseSessionCodeFromUrl — rejection', () => {
  it('rejects a malformed URL without throwing', () => {
    expect(parseSessionCodeFromUrl('not a url')).toBeNull();
  });

  it('rejects a trailing segment that is not a valid session code', () => {
    expect(parseSessionCodeFromUrl('wss://signal.beam.workers.dev/tooshort')).toBeNull();
    expect(parseSessionCodeFromUrl('wss://signal.beam.workers.dev/')).toBeNull();
    expect(parseSessionCodeFromUrl(`wss://signal.beam.workers.dev/${CODE.toUpperCase()}`)).toBeNull();
  });

  it('ignores a query string after the code (validates the path segment only)', () => {
    // S8 never appends a query, but a hostile URL might; the code segment is
    // still the last PATH segment, and a query does not pollute it.
    expect(parseSessionCodeFromUrl(`wss://signal.beam.workers.dev/${CODE}?x=1`)).toBe(CODE);
  });
});
