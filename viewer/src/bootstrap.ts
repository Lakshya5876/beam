/**
 * Impure: feature-gate check, service-worker registration with clients.claim,
 * wire real browser ports, run the ViewerConnection orchestration.
 * NOT unit-tested here (live at S18); excluded from coverage gate.
 *
 * S17 obligation: sw.js must be served with the response header
 *   Service-Worker-Allowed: /
 * Without it, the scope:'/' registration below throws SecurityError at runtime.
 *
 * M3 PIN gate: after WebSocket connects, the viewer renders a PIN entry form.
 * The viewer submits the 6-digit code; the DO validates SHA-256(pin+":"+sessionCode)
 * against the stored hash. On pin-ok the DO flushes buffered SDP/ICE and WebRTC
 * negotiation begins. On pin-locked the session ends.
 */

import { readBrowserCapabilities } from './browser-capabilities.js';
import { detectSupport } from './feature-detect.js';
import { buildViewerSignalingUrl } from './viewer-url.js';
import { BrowserPeerAdapter } from './browser-peer.js';
import { BrowserWebSocketAdapter } from './browser-signaling.js';
import { ViewerConnection } from './viewer-connection.js';
import { renderConnecting, renderFailed, renderPinEntry, renderPinFailed, renderPinLocked, renderUnsupported } from './pages.js';
import { serializeSwMessage } from './sw-bridge.js';
import { decodeFrame, encodeFrame, isFrameDecodeError } from './protocol-bridge.js';
import type { StreamMultiplexer } from './protocol-bridge.js';

export async function bootstrap(signalingBaseUrl: string): Promise<void> {
  console.log(`[VIEWER-BOOT] bootstrap() signalingBaseUrl=${signalingBaseUrl}`);
  const root = document.getElementById('beam-root');
  if (!root) return;

  const verdict = detectSupport(readBrowserCapabilities());
  console.log(`[VIEWER-BOOT] feature detection: supported=${String(verdict.supported)}`);
  if (!verdict.supported) {
    root.textContent = renderUnsupported(verdict.missing);
    return;
  }

  // N4: register with scope:'/' so the SW intercepts all same-origin fetches.
  // Requires Service-Worker-Allowed: / header on /__beam/sw.js (S17 obligation).
  if (navigator.serviceWorker) {
    try {
      console.log('[VIEWER-BOOT] registering SW /__beam/sw.js');
      await navigator.serviceWorker.register('/__beam/sw.js', { scope: '/', type: 'module' });
      console.log('[VIEWER-BOOT] SW registered');
    } catch (e) {
      console.log('[VIEWER-BOOT] SW registration FAILED:', e);
    }
  } else {
    console.log('[VIEWER-BOOT] navigator.serviceWorker unavailable');
  }

  const sessionCode = extractSessionCode();
  console.log(`[VIEWER-BOOT] sessionCode=${String(sessionCode)}`);
  if (!sessionCode) {
    root.textContent = renderFailed('no session code');
    return;
  }

  const base = signalingBaseUrl.replace(new RegExp(`/${sessionCode}$`), '');
  const wsUrl = buildViewerSignalingUrl(base, sessionCode);
  console.log(`[VIEWER-BOOT] base=${base} wsUrl=${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => { console.log('[VIEWER-BOOT] WS OPEN'); });
  ws.addEventListener('close', (e) => { console.log(`[VIEWER-BOOT] WS CLOSE code=${String(e.code)} reason=${e.reason}`); });
  ws.addEventListener('error', () => { console.log('[VIEWER-BOOT] WS ERROR'); });

  // M3 PIN gate: show PIN form, wait for DO to confirm or lock.
  const pinOk = await requestPinVerification(ws, root);
  if (!pinOk) {
    return; // renderPinLocked already shown inside requestPinVerification
  }

  root.textContent = renderConnecting();

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  console.log('[VIEWER-BOOT] RTCPeerConnection created');

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
 * Show the PIN entry form in root, let the user submit, and negotiate with the DO.
 * Returns true on pin-ok (WebRTC can start), false on pin-locked or WS close.
 */
async function requestPinVerification(ws: WebSocket, root: HTMLElement): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    root.innerHTML = renderPinEntry();

    function wireForm(): void {
      const form = root.querySelector<HTMLFormElement>('#beam-pin-form');
      const input = root.querySelector<HTMLInputElement>('#beam-pin');
      if (!form || !input) return;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = input.value.replace(/\s/g, '');
        console.log(`[VIEWER-BOOT] submitting PIN (${String(raw.length)} chars)`);
        ws.send(JSON.stringify({ type: 'pin', value: raw }));
      }, { once: true });
    }

    wireForm();

    function onMessage(event: MessageEvent): void {
      const control = parsePinControl(event.data as unknown);
      if (!control) return;

      if (control.type === 'pin-ok') {
        ws.removeEventListener('message', onMessage);
        resolve(true);
      } else if (control.type === 'pin-failed') {
        const left = control.attemptsLeft ?? 0;
        console.log(`[VIEWER-BOOT] pin-failed attemptsLeft=${String(left)}`);
        root.innerHTML = renderPinFailed(left);
        wireForm();
      } else if (control.type === 'pin-locked') {
        ws.removeEventListener('message', onMessage);
        root.innerHTML = renderPinLocked();
        resolve(false);
      }
    }

    ws.addEventListener('message', onMessage);

    // WS closed before pin-ok (host disconnected or lockout via ws.close)
    ws.addEventListener('close', () => {
      ws.removeEventListener('message', onMessage);
      if (root.querySelector('#beam-pin-form')) {
        root.innerHTML = renderPinLocked();
      }
      resolve(false);
    }, { once: true });
  });
}

/**
 * Wire the relay bridge: handle relay-request messages from the SW,
 * feed frames into the mux, and post relay-response back.
 * Called only after the mux exists (B1 guarantee).
 *
 * Each HTTP request now arrives as multiple relay-request messages (one per
 * Beam frame: REQUEST_HEAD, REQUEST_BODY_CHUNK*, REQUEST_END).  The response
 * listener must be registered exactly once per stream — on the first message —
 * and frames for the same stream are written on every subsequent message.
 */
function wireRelayBridge(mux: StreamMultiplexer, conn: ViewerConnection, sessionCode: string): void {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return;

  // B1: now that mux exists, tell the SW it's ready (mux-ready, not claim-ready)
  sw.postMessage(serializeSwMessage({ type: 'mux-ready', sessionCode }));

  // Track which streams already have a response listener to avoid duplicates.
  const listeningStreams = new Set<number>();

  // Handle relay-request frames from the SW
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data as { type?: string; streamId?: number; data?: Uint8Array } | null;
    if (!msg || msg.type !== 'relay-request' || typeof msg.streamId !== 'number') return;

    const streamId = msg.streamId;

    // Register the response listener on the first frame for this stream only.
    if (!listeningStreams.has(streamId)) {
      listeningStreams.add(streamId);
      conn.trackStream(streamId);

      const unsubscribe = mux.onInbound((frame) => {
        if (frame.streamId !== streamId) return;
        const encoded = encodeFrame(frame);
        sw.postMessage(
          serializeSwMessage({ type: 'relay-response', streamId, data: encoded }),
        );
        if (frame.type === 6 /* RESPONSE_END */ || frame.type === 7 /* ERROR */) {
          unsubscribe();
          listeningStreams.delete(streamId);
          conn.untrackStream(streamId);
        }
      });
    }

    // Decode the encoded Beam frame bytes and write into the mux.
    if (msg.data && msg.data.byteLength > 0) {
      const frame = decodeFrame(msg.data);
      if (!isFrameDecodeError(frame)) {
        mux.writeFrame(frame);
      }
    }
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

interface PinControl {
  type: 'pin-ok' | 'pin-failed' | 'pin-locked';
  attemptsLeft?: number;
}

function parsePinControl(raw: unknown): PinControl | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const type = obj['type'];
    if (type === 'pin-ok') return { type: 'pin-ok' };
    if (type === 'pin-failed') {
      const left = typeof obj['attemptsLeft'] === 'number' ? obj['attemptsLeft'] : 0;
      return { type: 'pin-failed', attemptsLeft: left };
    }
    if (type === 'pin-locked') return { type: 'pin-locked' };
  } catch {
    // not JSON
  }
  return null;
}
