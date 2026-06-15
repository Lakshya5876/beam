/**
 * Impure boundary: reads real browser globals into a BrowserCapabilities
 * snapshot for detectSupport(). Kept tiny and isolated; exercised in a real
 * browser at S18 (not unit-tested here, hence excluded from the coverage gate).
 */

import type { BrowserCapabilities } from './feature-detect.js';

export function readBrowserCapabilities(): BrowserCapabilities {
  return {
    hasRTCPeerConnection: typeof RTCPeerConnection !== 'undefined',
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasWebSocket: typeof WebSocket !== 'undefined',
  };
}
