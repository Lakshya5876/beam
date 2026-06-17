/**
 * Impure: feature-gate check, service-worker registration with clients.claim,
 * wire real browser ports, run the ViewerConnection orchestration.
 * NOT unit-tested here (live at S18); excluded from coverage gate.
 *
 * S17 obligation: sw.js must be served with the response header
 *   Service-Worker-Allowed: /
 * Without it, the scope:'/' registration below throws SecurityError at runtime.
 */

import { readBrowserCapabilities } from './browser-capabilities.js';
import { detectSupport } from './feature-detect.js';
import { buildViewerSignalingUrl } from './viewer-url.js';
import { BrowserPeerAdapter } from './browser-peer.js';
import { BrowserWebSocketAdapter } from './browser-signaling.js';
import { ViewerConnection } from './viewer-connection.js';
import { renderConnecting, renderFailed, renderUnsupported } from './pages.js';
import { serializeSwMessage } from './sw-bridge.js';
import { decodeFrame, encodeFrame, isFrameDecodeError } from './protocol-bridge.js';
import type { StreamMultiplexer } from './protocol-bridge.js';

export async function bootstrap(signalingBaseUrl: string): Promise<void> {
  const root = document.getElementById('beam-root');
  if (!root) return;

  const verdict = detectSupport(readBrowserCapabilities());
  if (!verdict.supported) {
    root.textContent = renderUnsupported(verdict.missing);
    return;
  }

  root.textContent = renderConnecting();

  // N4: register with scope:'/' so the SW intercepts all same-origin fetches.
  // Requires Service-Worker-Allowed: / header on /__beam/sw.js (S17 obligation).
  if (navigator.serviceWorker) {
    try {
      await navigator.serviceWorker.register('/__beam/sw.js', { scope: '/' });
    } catch {
      // SW registration failed; relay will not work but connection attempt continues
    }
  }

  const sessionCode = extractSessionCode();
  if (!sessionCode) {
    root.textContent = renderFailed('no session code');
    return;
  }

  // Strip the session code from signalingBaseUrl (which may be a full URL including the code)
  // to avoid duplicating the code when calling buildViewerSignalingUrl
  const base = signalingBaseUrl.replace(new RegExp(`/${sessionCode}$`), '');
  const pc = new RTCPeerConnection();
  const ws = new WebSocket(buildViewerSignalingUrl(base, sessionCode));

  const peerAdapter = new BrowserPeerAdapter(pc);
  const socketAdapter = new BrowserWebSocketAdapter(ws);
  const conn = new ViewerConnection(peerAdapter, socketAdapter);

  conn.onconnectionstate((state) => {
    if (state === 'connected') {
      root.textContent = 'Connected — ready to relay.';
    } else if (state === 'failed') {
      root.textContent = renderFailed('peer connection failed');
    }
  });

  // B1: wire mux-ready AFTER data channel is open (not on SW claim)
  conn.onmux((mux) => {
    wireRelayBridge(mux, conn, sessionCode);
  });

  // N3: on transport close, emit relay-error for all open streams
  conn.onclose((openStreamIds) => {
    const sw = navigator.serviceWorker.controller;
    if (!sw) return;
    for (const streamId of openStreamIds) {
      sw.postMessage(serializeSwMessage({ type: 'relay-error', streamId, reason: 'disconnect' }));
    }
  });
}

/**
 * Wire the relay bridge: handle relay-request messages from the SW,
 * feed frames into the mux, and post relay-response back.
 * Called only after the mux exists (B1 guarantee).
 */
function wireRelayBridge(mux: StreamMultiplexer, conn: ViewerConnection, sessionCode: string): void {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return;

  // B1: now that mux exists, tell the SW it's ready (mux-ready, not claim-ready)
  sw.postMessage(serializeSwMessage({ type: 'mux-ready', sessionCode }));

  // Handle relay-request frames from the SW
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data as { type?: string; streamId?: number; data?: Uint8Array } | null;
    if (!msg || msg.type !== 'relay-request' || typeof msg.streamId !== 'number') return;

    const streamId = msg.streamId;
    conn.trackStream(streamId);

    // Decode the frame bytes and write into the mux
    if (msg.data && msg.data.byteLength > 0) {
      const frame = decodeFrame(msg.data);
      if (!isFrameDecodeError(frame)) {
        mux.writeFrame(frame);
      }
    }

    // Listen for response frames from the mux and relay back to SW
    const unsubscribe = mux.onFrame((frame) => {
      if (frame.streamId !== streamId) return;
      const encoded = encodeFrame(frame);
      sw.postMessage(
        serializeSwMessage({ type: 'relay-response', streamId, data: encoded }),
      );
      if (frame.type === 6 /* RESPONSE_END */ || frame.type === 7 /* ERROR */) {
        unsubscribe();
        conn.untrackStream(streamId);
      }
    });
  });
}

/**
 * Extract session code from URL.
 * Checks ?session=<code> first, then last path segment of ?signaling=<url>/<code>.
 */
function extractSessionCode(): string | null {
  const params = new URLSearchParams(window.location.search);

  const direct = params.get('session');
  if (direct && direct.length > 0) return direct;

  const signalingUrl = params.get('signaling');
  if (signalingUrl) {
    const segments = signalingUrl.split('/').filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last && /^[a-z0-9]{4,}$/.test(last)) return last;
  }

  return null;
}
