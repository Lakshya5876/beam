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
import { parseSwMessage, serializeSwMessage } from './sw-bridge.js';
import { decodeFrame, encodeFrame, isFrameDecodeError } from './protocol-bridge.js';
import type { StreamMultiplexer } from './protocol-bridge.js';

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_CONFIG_TIMEOUT_MS = 3000;

/**
 * Fetch deploy-time ICE configuration from the signaling worker
 * (GET /ice-config). Total: any failure — network, timeout, bad JSON —
 * falls back to the public STUN default so the connection still attempts.
 */
export async function fetchIceServers(signalingBaseUrl: string): Promise<RTCIceServer[]> {
  try {
    const httpBase = signalingBaseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
    // Strip a trailing session-code path segment if present: the worker
    // serves /ice-config at the origin root.
    const url = new URL('/ice-config', httpBase).href;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, ICE_CONFIG_TIMEOUT_MS);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return FALLBACK_ICE_SERVERS;
    }
    const body = (await resp.json()) as { iceServers?: unknown };
    if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
      console.log(`[VIEWER-BOOT] ice-config loaded: ${String(body.iceServers.length)} server(s)`);
      return body.iceServers as RTCIceServer[];
    }
    return FALLBACK_ICE_SERVERS;
  } catch {
    console.log('[VIEWER-BOOT] ice-config fetch failed — using STUN fallback');
    return FALLBACK_ICE_SERVERS;
  }
}

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
  // Returns buffered post-pin-ok messages to prevent the offer-drop race.
  const buffered = await requestPinVerification(ws, root);
  if (buffered === null) {
    return; // renderPinLocked already shown inside requestPinVerification
  }

  root.textContent = renderConnecting();

  const iceServers = await fetchIceServers(base);
  const pc = new RTCPeerConnection({ iceServers });
  console.log('[VIEWER-BOOT] RTCPeerConnection created');

  const peerAdapter = new BrowserPeerAdapter(pc);
  const socketAdapter = new BrowserWebSocketAdapter(ws);
  const conn = new ViewerConnection(peerAdapter, socketAdapter, { ipv4Only: isIpv4OnlyRequested() });
  // CRITICAL ORDER: stop the pin-gate buffer listener BEFORE replaying.
  // Replay uses ws.dispatchEvent, which fires EVERY listener — with the
  // buffer listener still attached, each replayed event re-appends to the
  // array being iterated and the loop feeds itself forever (observed as
  // tens of thousands of duplicate offers in the local e2e harness).
  buffered.stop();
  const replay = buffered.events.splice(0);
  console.log(`[VIEWER-BOOT] replaying ${String(replay.length)} buffered post-pin-ok messages`);
  for (const event of replay) {
    ws.dispatchEvent(new MessageEvent('message', { data: event.data }));
  }

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

/** Post-pin-ok message buffer: events captured while the caller sets up
 *  ViewerConnection, plus stop() to detach the capture listener before the
 *  caller replays them (see CRITICAL ORDER note at the call site). */
interface PostPinBuffer {
  readonly events: MessageEvent[];
  stop(): void;
}

/**
 * Show the PIN entry form in root, let the user submit, and negotiate with the DO.
 * Returns buffered post-pin-ok messages on success (so the caller can replay them
 * into ViewerConnection before any new messages arrive), or null on failure.
 *
 * Race prevention: after pin-ok the DO immediately flushes buffered SDP/ICE onto
 * the same WebSocket. The caller does async work (ICE config fetch) before
 * ViewerConnection's handler is registered, so every non-pin message arriving
 * after pin-ok is buffered here and replayed by the caller once setup is done.
 */
async function requestPinVerification(ws: WebSocket, root: HTMLElement): Promise<PostPinBuffer | null> {
  return new Promise<PostPinBuffer | null>((resolve) => {
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

    // After pin-ok, buffer all arriving messages until ViewerConnection is ready.
    const postPinBuffer: MessageEvent[] = [];

    function onMessage(event: MessageEvent): void {
      const control = parsePinControl(event.data as unknown);

      if (control === null) {
        // Not a pin control message — if we're already past pin-ok, buffer it.
        if (postPinBuffer !== null) {
          postPinBuffer.push(event);
        }
        return;
      }

      if (control.type === 'pin-ok') {
        console.log('[VIEWER-BOOT] pin-ok received');
        // Swap to buffer-only mode: capture messages until the caller has
        // ViewerConnection listening, then the caller calls stop() and
        // replays. The named listener makes it detachable — an anonymous
        // one here caused the infinite replay loop.
        ws.removeEventListener('message', onMessage);
        const capture = (e: MessageEvent): void => { postPinBuffer.push(e); };
        ws.addEventListener('message', capture);
        resolve({ events: postPinBuffer, stop: () => { ws.removeEventListener('message', capture); } });
      } else if (control.type === 'pin-failed') {
        const left = control.attemptsLeft ?? 0;
        console.log(`[VIEWER-BOOT] pin-failed attemptsLeft=${String(left)}`);
        root.innerHTML = renderPinFailed(left);
        wireForm();
      } else if (control.type === 'pin-locked') {
        ws.removeEventListener('message', onMessage);
        root.innerHTML = renderPinLocked();
        resolve(null);
      }
    }

    ws.addEventListener('message', onMessage);

    // WS closed before pin-ok (host disconnected or lockout via ws.close)
    ws.addEventListener('close', () => {
      ws.removeEventListener('message', onMessage);
      if (root.querySelector('#beam-pin-form')) {
        root.innerHTML = renderPinLocked();
      }
      resolve(null);
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
 *
 * SW controller timing: on a fresh registration the SW activates and calls
 * clients.claim() asynchronously. navigator.serviceWorker.controller may be
 * null when the DataChannel first opens. We wait for the controllerchange
 * event in that case before sending mux-ready.
 */
function wireRelayBridge(mux: StreamMultiplexer, conn: ViewerConnection, sessionCode: string): void {
  if (!navigator.serviceWorker) return;

  // Track which streams already have a response listener to avoid duplicates.
  const listeningStreams = new Set<number>();

  // Send mux-ready once the SW is controlling this page. On a fresh registration
  // navigator.serviceWorker.controller is null until clients.claim() fires
  // controllerchange — so we wait for that event if needed.
  function sendMuxReady(): void {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      console.log('[VIEWER-BOOT] SW controller not ready — waiting for controllerchange');
      navigator.serviceWorker.addEventListener('controllerchange', sendMuxReady, { once: true });
      return;
    }
    console.log('[VIEWER-BOOT] sending mux-ready to SW');
    controller.postMessage(serializeSwMessage({ type: 'mux-ready', sessionCode }));
  }
  sendMuxReady();

  // SW restart recovery: re-send mux-ready whenever the SW asks for it.
  // A fresh SW instance has gate.ready=false and cannot receive the one-shot
  // mux-ready that already fired into the previous instance.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = parseSwMessage(event.data as unknown);
    if (msg?.type === 'request-mux-ready') {
      console.log('[VIEWER-BOOT] SW requested mux-ready re-send');
      sendMuxReady();
    }
  });

  // Handle relay-request frames from the SW
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data as { type?: string; streamId?: number; data?: Uint8Array } | null;
    if (!msg || msg.type !== 'relay-request' || typeof msg.streamId !== 'number') return;

    const streamId = msg.streamId;
    console.log(`[PAGE] relay-request sid=${String(streamId)} dataLen=${String(msg.data?.byteLength ?? 0)}`);

    // Register the response listener on the first frame for this stream only.
    if (!listeningStreams.has(streamId)) {
      listeningStreams.add(streamId);
      conn.trackStream(streamId);
      // The SW allocated this id — the mux must adopt it before writeFrame,
      // which rejects unknown streams as 'not-open'.
      const adopted = mux.adoptStream(streamId);
      if (!adopted.ok) {
        console.log(`[PAGE] adoptStream REJECTED sid=${String(streamId)} reason=${adopted.error.reason}`);
      }

      const unsubscribe = mux.onInbound((frame) => {
        if (frame.streamId !== streamId) return;
        console.log(`[PAGE] inbound frame sid=${String(streamId)} type=${String(frame.type)}`);
        const encoded = encodeFrame(frame);
        const sw = navigator.serviceWorker.controller;
        if (sw) {
          sw.postMessage(serializeSwMessage({ type: 'relay-response', streamId, data: encoded }));
        } else {
          console.log(`[PAGE] WARN controller null — relay-response dropped sid=${String(streamId)}`);
        }
        if (frame.type === 6 /* RESPONSE_END */ || frame.type === 7 /* ERROR */) {
          unsubscribe();
          listeningStreams.delete(streamId);
          conn.untrackStream(streamId);
        }
      });
    }

    writeRelayFrame(mux, streamId, msg.data);
  });
}

/** Decode SW-relayed frame bytes and write into the mux, logging rejections. */
function writeRelayFrame(mux: StreamMultiplexer, streamId: number, data: Uint8Array | undefined): void {
  if (!data || data.byteLength === 0) {
    return;
  }
  const frame = decodeFrame(data);
  if (isFrameDecodeError(frame)) {
    console.log(`[PAGE] decodeFrame ERROR sid=${String(streamId)}`, frame);
    return;
  }
  const written = mux.writeFrame(frame);
  console.log(`[PAGE] writeFrame sid=${String(streamId)} type=${String(frame.type)} ok=${String(written.ok)}${written.ok ? '' : ` reason=${JSON.stringify(written.error)}`}`);
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

/** `?ipv4=1` — set by the CLI on the printed viewer URL when --ipv4-only is passed. */
function isIpv4OnlyRequested(): boolean {
  return new URLSearchParams(window.location.search).get('ipv4') === '1';
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
