import { describe, it, expect } from 'vitest';
import { buildViewerSignalingUrl, extractSessionCodeFromSearch, extractSessionCodeFromUrl } from '../src/viewer-url.js';

// S8 replica: the same URL building rule that host WebSocketSignalingClient uses
function buildUrlS8Replica(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${code}`;
}

describe('buildViewerSignalingUrl (URL triangle: S8 ↔ S14 ↔ S15b parity)', () => {
  it('is byte-identical to S8 buildUrl', () => {
    const bases = [
      'ws://localhost:8081',
      'ws://localhost:8081/',
      'ws://localhost:8081///',
      'wss://signaling.example.com',
      'wss://signaling.example.com/',
      'ws://localhost:8081/signaling',
    ];
    const code = 'abcdefghijklmnopqrstuvwxyz';

    for (const base of bases) {
      const viewer = buildViewerSignalingUrl(base, code);
      const s8 = buildUrlS8Replica(base, code);
      expect(viewer).toBe(s8);
    }
  });

  it('strips trailing slashes before appending code', () => {
    expect(buildViewerSignalingUrl('ws://localhost:8081/', 'abc')).toBe('ws://localhost:8081/abc');
    expect(buildViewerSignalingUrl('ws://localhost:8081///', 'abc')).toBe('ws://localhost:8081/abc');
  });

  it('handles code with all valid characters', () => {
    const code = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const url = buildViewerSignalingUrl('ws://localhost', code);
    expect(url).toBe(`ws://localhost/${code}`);
  });
});

describe('extractSessionCodeFromSearch', () => {
  it('reads ?session=<code> directly', () => {
    expect(extractSessionCodeFromSearch('?session=abc123')).toBe('abc123');
  });

  it('falls back to the last path segment of ?signaling=<url>/<code>', () => {
    expect(extractSessionCodeFromSearch('?signaling=wss%3A%2F%2Fhost%2Fabcdefgh1234'))
      .toBe('abcdefgh1234');
  });

  it('prefers ?session= over ?signaling= when both are present', () => {
    expect(extractSessionCodeFromSearch('?session=direct&signaling=wss://host/fromurl123'))
      .toBe('direct');
  });

  it('returns null when neither param is present', () => {
    expect(extractSessionCodeFromSearch('')).toBeNull();
    expect(extractSessionCodeFromSearch('?foo=bar')).toBeNull();
  });

  it('returns null for a signaling URL whose last segment does not look like a code', () => {
    // Too short (<4 chars) to plausibly be a session code.
    expect(extractSessionCodeFromSearch(`?signaling=${encodeURIComponent('wss://host/abc')}`)).toBeNull();
  });
});

describe('extractSessionCodeFromUrl — the SW-side referrer parser (SECURITY_AUDIT_20-08.md #1)', () => {
  it('extracts the session code from a full outer-window URL', () => {
    const url = 'https://beam-viewer.pages.dev/?signaling=wss://beam-viewer.pages.dev/abcdefgh12345678';
    expect(extractSessionCodeFromUrl(url)).toBe('abcdefgh12345678');
  });

  it('extracts from a direct ?session= referrer', () => {
    expect(extractSessionCodeFromUrl('https://beam-viewer.pages.dev/?session=zzz999')).toBe('zzz999');
  });

  it('returns null for an unparseable or empty referrer rather than throwing', () => {
    expect(extractSessionCodeFromUrl('')).toBeNull();
    expect(extractSessionCodeFromUrl('not a url')).toBeNull();
  });

  it('returns null for a referrer with no session information (e.g. the iframe\'s own prior page)', () => {
    expect(extractSessionCodeFromUrl('https://beam-viewer.pages.dev/dashboard')).toBeNull();
  });
});
