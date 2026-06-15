/**
 * Browser feature detection (design §6: unsupported-browser path). PURE: takes
 * an injected capability snapshot and returns a typed verdict, so it is fully
 * unit-testable without a real browser. The impure read of actual browser
 * globals lives in browser-capabilities.ts.
 */

export interface BrowserCapabilities {
  readonly hasRTCPeerConnection: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasWebSocket: boolean;
}

export type SupportVerdict =
  | { readonly supported: true }
  | { readonly supported: false; readonly missing: readonly string[] };

export function detectSupport(capabilities: BrowserCapabilities): SupportVerdict {
  const missing: string[] = [];
  if (!capabilities.hasRTCPeerConnection) {
    missing.push('WebRTC');
  }
  if (!capabilities.hasServiceWorker) {
    missing.push('Service Worker');
  }
  if (!capabilities.hasWebSocket) {
    missing.push('WebSocket');
  }
  return missing.length === 0 ? { supported: true } : { supported: false, missing };
}
