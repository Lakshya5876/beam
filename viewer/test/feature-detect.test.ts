import { describe, expect, it } from 'vitest';
import { detectSupport, type BrowserCapabilities } from '../src/feature-detect.js';

const ALL: BrowserCapabilities = { hasRTCPeerConnection: true, hasServiceWorker: true, hasWebSocket: true };

describe('detectSupport', () => {
  it('reports supported when all capabilities are present', () => {
    expect(detectSupport(ALL)).toEqual({ supported: true });
  });

  it('reports the missing capability names when any are absent', () => {
    expect(detectSupport({ ...ALL, hasRTCPeerConnection: false })).toEqual({ supported: false, missing: ['WebRTC'] });
    expect(detectSupport({ ...ALL, hasServiceWorker: false })).toEqual({ supported: false, missing: ['Service Worker'] });
    expect(detectSupport({ ...ALL, hasWebSocket: false })).toEqual({ supported: false, missing: ['WebSocket'] });
  });

  it('lists all missing capabilities when none are present', () => {
    const verdict = detectSupport({ hasRTCPeerConnection: false, hasServiceWorker: false, hasWebSocket: false });
    expect(verdict).toEqual({ supported: false, missing: ['WebRTC', 'Service Worker', 'WebSocket'] });
  });
});
