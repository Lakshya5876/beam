import { describe, it, expect } from 'vitest';
import { buildViewerSignalingUrl } from '../src/viewer-url.js';

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
