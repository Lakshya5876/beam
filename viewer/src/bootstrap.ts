/**
 * Impure: feature-gate check, service-worker registration with clients.claim,
 * wire real browser ports, run the ViewerConnection orchestration.
 * NOT unit-tested here (live at S18); excluded from coverage gate.
 */

import { readBrowserCapabilities } from './browser-capabilities.js';
import { detectSupport } from './feature-detect.js';
import { buildViewerSignalingUrl } from './viewer-url.js';
import { BrowserPeerAdapter } from './browser-peer.js';
import { BrowserWebSocketAdapter } from './browser-signaling.js';
import { ViewerConnection } from './viewer-connection.js';
import { renderConnecting, renderFailed, renderUnsupported } from './pages.js';

export async function bootstrap(signalingBaseUrl: string): Promise<void> {
  const root = document.getElementById('beam-root');
  if (!root) return;

  const verdict = detectSupport(readBrowserCapabilities());
  if (!verdict.supported) {
    root.textContent = renderUnsupported(verdict.missing);
    return;
  }

  root.textContent = renderConnecting();

  // Register service worker with clients.claim
  if (navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (reg.active) {
        const controller = reg.active as ServiceWorkerContainer;
        await (controller as unknown as ServiceWorker).postMessage({ type: 'clients.claim' });
      }
    } catch {
      // SW registration failed; continue without it (S16 deferred)
    }
  }

  // Wire and run the viewer connection
  const sessionCode = extractSessionCode(); // TODO: derive from URL or prop
  if (!sessionCode) {
    root.textContent = renderFailed('no session code');
    return;
  }

  const pc = new RTCPeerConnection();
  const ws = new WebSocket(buildViewerSignalingUrl(signalingBaseUrl, sessionCode));

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
}

function extractSessionCode(): string | null {
  // Placeholder: derive from URL query param or DOM attribute
  return null;
}
