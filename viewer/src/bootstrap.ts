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
import { renderConnectedShell, renderConnecting, renderFailed, renderPinEntry, renderPinFailed, renderPinLocked, renderUnsupported } from './pages.js';
import { parseSwMessage, serializeSwMessage } from './sw-bridge.js';
import { decodeFrame, encodeFrame, isFrameDecodeError } from './protocol-bridge.js';
import type { StreamMultiplexer } from './protocol-bridge.js';
import { createWsBridge } from './ws-bridge.js';
import {
  OutcomeReporter,
  extractTransportUsage,
  outcomeForSelectedPath,
  telemetryUrlFor,
  type CandidatePairStatsLike,
  type SessionUsage,
  type TelemetryOutcome,
} from './telemetry.js';
import {
  classifySelectedPath,
  ConnectionReport,
  describeFailure,
  isRelayOnlyRequested,
  type ConnectionFacts,
  type SelectedPath,
} from './connection-report.js';

declare global {
  interface Window {
    /**
     * The connection's own diagnostic facts — which stage it reached, whether
     * a relay was available, and which ICE path was actually selected. Read by
     * the E2E suite to assert direct-vs-relay, and available in the console
     * when supporting a user whose session failed. Contains no application
     * data (see connection-report.ts).
     */
    __beamConnection?: ConnectionFacts;
  }
}

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_CONFIG_TIMEOUT_MS = 3000;

/**
 * How long the viewer waits for the DataChannel before declaring failure.
 *
 * Without this the viewer waited forever: an ICE agent that never nominates a
 * pair (no reachable relay, a firewall dropping every candidate) leaves
 * RTCPeerConnection in 'checking' indefinitely and no 'failed' event ever
 * fires, so the page sat on "connecting…" with no explanation and no cleanup.
 * ICE normally settles in a few seconds; a relayed path adds little. 45s is
 * well past any healthy case while still bounded for the user.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

export interface IceConfigResult {
  readonly iceServers: RTCIceServer[];
  /** `x-beam-turn` from the worker: 'available' | 'not-configured' | a typed
   *  mint failure. Null when the response did not carry it. */
  readonly turnState: string | null;
  /** True when at least one usable TURN server came back. */
  readonly hasRelay: boolean;
}

/** A relay server is only usable if it carries the credentials TURN needs. */
function containsUsableRelay(servers: readonly RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    const isTurn = urls.some((u) => /^turns?:/i.test(u));
    return isTurn && typeof server.username === 'string' && typeof server.credential === 'string';
  });
}

/**
 * Fetch ICE configuration from the signaling origin (GET /ice-config) — the
 * same endpoint and response the host CLI reads, so both ends of the session
 * get the same STUN and (when configured) the same TURN relay.
 *
 * Total: any failure — network, timeout, bad JSON — falls back to public STUN
 * so a direct connection is still attempted. A TURN outage must never be a
 * Beam outage.
 */
export async function fetchIceServers(signalingBaseUrl: string): Promise<IceConfigResult> {
  try {
    const httpBase = signalingBaseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
    // Strip a trailing session-code path segment if present: the worker
    // serves /ice-config at the origin root.
    const url = new URL('/ice-config', httpBase).href;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, ICE_CONFIG_TIMEOUT_MS);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const turnState = resp.headers.get('x-beam-turn');
    if (!resp.ok) {
      return { iceServers: FALLBACK_ICE_SERVERS, turnState, hasRelay: false };
    }
    const body = (await resp.json()) as { iceServers?: unknown };
    if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
      const iceServers = body.iceServers as RTCIceServer[];
      return { iceServers, turnState, hasRelay: containsUsableRelay(iceServers) };
    }
    return { iceServers: FALLBACK_ICE_SERVERS, turnState, hasRelay: false };
  } catch {
    return { iceServers: FALLBACK_ICE_SERVERS, turnState: null, hasRelay: false };
  }
}

/**
 * Read the ICE pair that actually carried the session, so a successful
 * connection reports whether it went direct or through TURN. Uses getStats()
 * — the standard API, supported in Chrome, Edge, Firefox, and Safari — rather
 * than any vendor-specific accessor. Returns 'unknown' rather than throwing if
 * a browser reports stats differently than expected.
 */
export async function readSelectedPath(pc: RTCPeerConnection): Promise<SelectedPath> {
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, { type?: string; candidateType?: string; nominated?: boolean; state?: string; localCandidateId?: string; remoteCandidateId?: string }>();
    stats.forEach((entry, id) => { byId.set(id, entry as never); });
    for (const entry of byId.values()) {
      if (entry.type !== 'candidate-pair' || entry.state !== 'succeeded') {
        continue;
      }
      const local = entry.localCandidateId !== undefined ? byId.get(entry.localCandidateId) : undefined;
      const remote = entry.remoteCandidateId !== undefined ? byId.get(entry.remoteCandidateId) : undefined;
      return classifySelectedPath(local?.candidateType, remote?.candidateType);
    }
  } catch {
    // Diagnostics must never break a working connection.
  }
  return 'unknown';
}

/**
 * Read transport-layer usage (bytesSent/bytesReceived on the succeeded
 * candidate pair) for the telemetry beacon's usage fields — see telemetry.ts
 * for exactly what these numbers do and do not measure. The actual
 * extraction is pure (extractTransportUsage, unit-tested); this wrapper is
 * only the getStats() I/O call, same shape as readSelectedPath above.
 */
async function readTransportUsage(pc: RTCPeerConnection): Promise<{ bytesSent: number; bytesReceived: number }> {
  try {
    const stats = await pc.getStats();
    const entries: CandidatePairStatsLike[] = [];
    stats.forEach((entry) => { entries.push(entry as never); });
    return extractTransportUsage(entries);
  } catch {
    // Telemetry must never break a working connection.
    return { bytesSent: 0, bytesReceived: 0 };
  }
}

/** How often to snapshot transport usage while connected — see the
 *  lastKnownUsage doc in bootstrap() for why this snapshot exists at all.
 *  Deliberately short: live testing showed a short-lived session (connect,
 *  transfer, host disconnects within ~1-2s) can otherwise end before a
 *  longer interval ever ticks once, leaving nothing cached to fall back on. */
const USAGE_POLL_INTERVAL_MS = 1000;

export async function bootstrap(signalingBaseUrl: string): Promise<void> {
// console.log(`[VIEWER-BOOT] bootstrap() signalingBaseUrl=${signalingBaseUrl}`);
  const root = document.getElementById('beam-root');
  if (!root) return;

  const verdict = detectSupport(readBrowserCapabilities());
// console.log(`[VIEWER-BOOT] feature detection: supported=${String(verdict.supported)}`);
  if (!verdict.supported) {
    root.textContent = renderUnsupported(verdict.missing);
    return;
  }

  // N4: register with scope:'/' so the SW intercepts all same-origin fetches.
  // Requires Service-Worker-Allowed: / header on /__beam/sw.js (S17 obligation).
  if (navigator.serviceWorker) {
    try {
// console.log('[VIEWER-BOOT] registering SW /__beam/sw.js');
      await navigator.serviceWorker.register('/__beam/sw.js', { scope: '/', type: 'module' });
// console.log('[VIEWER-BOOT] SW registered');
    } catch {
// console.log('[VIEWER-BOOT] SW registration FAILED');
    }
  } else {
// console.log('[VIEWER-BOOT] navigator.serviceWorker unavailable');
  }

  const sessionCode = extractSessionCode();
// console.log(`[VIEWER-BOOT] sessionCode=${String(sessionCode)}`);
  if (!sessionCode) {
    root.textContent = renderFailed('no session code');
    return;
  }

  // Records how far the connection actually got, so a failure can say which
  // stage it died at instead of one generic message for every cause. Exposed
  // as a live getter rather than a snapshot — a snapshot taken at 'connected'
  // would permanently omit every stage reached afterwards.
  const report = new ConnectionReport();
  Object.defineProperty(window, '__beamConnection', {
    configurable: true,
    get: () => report.facts(),
  });

  const base = signalingBaseUrl.replace(new RegExp(`/${sessionCode}$`), '');
  const wsUrl = buildViewerSignalingUrl(base, sessionCode);
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => { report.reach('signaling-connect'); });

  // At most one outcome beacon per session (see telemetry.ts). Fire-and-
  // forget: the request is never awaited, its response never inspected, and
  // a failed send is swallowed here rather than surfaced — telemetry must
  // never affect the Beam connection or the user's experience of it.
  // keepalive lets the request survive if the page is being torn down (e.g.
  // the connect-timeout closing the connection) right as it's sent.
  const outcomeReporter = new OutcomeReporter((payload) => {
    fetch(telemetryUrlFor(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => { /* best-effort — see class doc */ });
  });

  // Wall-clock start of this attempt — the only definition of "duration" that
  // stays well-defined for every outcome, including one that never connects.
  const sessionStartedAtMs = Date.now();

  // getStats() read reactively AFTER a failure is confirmed to be too late:
  // live testing showed candidate-pair entries disappear from the stats
  // report entirely (not just change state) once connectionState reaches
  // 'failed' — by the time any failure handler fires, the transport-level
  // history is already gone. So usage is snapshotted periodically WHILE the
  // connection is healthy, and finalization prefers whichever of the fresh
  // read or this last-known-good snapshot is larger per field (a fresh read
  // may still be legitimately complete for a graceful close; the snapshot is
  // the fallback for the case just described).
  let lastKnownUsage = { bytesSent: 0, bytesReceived: 0 };
  let usagePollHandle: ReturnType<typeof setInterval> | null = null;

  function startUsagePolling(peerConnection: RTCPeerConnection): void {
    const poll = (): void => {
      void readTransportUsage(peerConnection).then((usage) => {
        if (usage.bytesSent > 0 || usage.bytesReceived > 0) {
          lastKnownUsage = usage;
        }
      });
    };
    poll(); // immediate first snapshot — don't wait for the first interval tick
    usagePollHandle = setInterval(poll, USAGE_POLL_INTERVAL_MS);
  }

  function stopUsagePolling(): void {
    if (usagePollHandle !== null) {
      clearInterval(usagePollHandle);
      usagePollHandle = null;
    }
  }

  /**
   * Finalize and report ONE outcome for this session — must only be called
   * once the session has genuinely reached a terminal point (a real failure,
   * or the connection closing after having worked). claim() is synchronous
   * and happens BEFORE the async getStats() read: more than one of this
   * file's terminal call sites can independently decide to finalize, and if
   * the dedup check lived only at send time, two concurrent calls could both
   * pass it during their respective async gaps and both send — this
   * happened in live testing before claim()/report() were split (see
   * telemetry.ts's OutcomeReporter doc).
   */
  async function finalizeOutcome(outcome: TelemetryOutcome, peerConnection: RTCPeerConnection): Promise<void> {
    if (!outcomeReporter.claim()) {
      return;
    }
    stopUsagePolling();
    const fresh = await readTransportUsage(peerConnection);
    const usage: SessionUsage = {
      durationMs: Date.now() - sessionStartedAtMs,
      bytesSent: Math.max(fresh.bytesSent, lastKnownUsage.bytesSent),
      bytesReceived: Math.max(fresh.bytesReceived, lastKnownUsage.bytesReceived),
    };
    outcomeReporter.report(outcome, report.facts(), usage);
  }

  // M3 PIN gate: show PIN form, wait for DO to confirm or lock.
  // Returns buffered post-pin-ok messages to prevent the offer-drop race.
  const buffered = await requestPinVerification(ws, root);
  if (buffered === null) {
    return; // renderPinLocked already shown inside requestPinVerification
  }
  report.reach('pin-verify');

  root.textContent = renderConnecting();

  const ice = await fetchIceServers(base);
  report.reach('ice-config');
  report.noteTurnState(ice.turnState, ice.hasRelay);

  // relay=1 forces every candidate through TURN. This exists to VERIFY the
  // relay path (and to diagnose a network that needs it) — normal sessions
  // leave it off so ICE prefers a direct pair and relays only as fallback.
  const relayOnly = isRelayOnlyRequested(window.location.search);
  if (relayOnly) {
    report.noteRelayOnlyRequested();
  }
  const pc = new RTCPeerConnection({
    iceServers: ice.iceServers,
    ...(relayOnly && { iceTransportPolicy: 'relay' as const }),
  });

  const peerAdapter = new BrowserPeerAdapter(pc);
  const socketAdapter = new BrowserWebSocketAdapter(ws);
  const conn = new ViewerConnection(peerAdapter, socketAdapter, { ipv4Only: isIpv4OnlyRequested() });
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState !== 'new') {
      report.reach('ice-gathering');
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'checking') {
      report.reach('ice-connect');
    }
  });
  // CRITICAL ORDER: stop the pin-gate buffer listener BEFORE replaying.
  // Replay uses ws.dispatchEvent, which fires EVERY listener — with the
  // buffer listener still attached, each replayed event re-appends to the
  // array being iterated and the loop feeds itself forever (observed as
  // tens of thousands of duplicate offers in the local e2e harness).
  buffered.stop();
  const replay = buffered.events.splice(0);
// console.log(`[VIEWER-BOOT] replaying ${String(replay.length)} buffered post-pin-ok messages`);
  for (const event of replay) {
    ws.dispatchEvent(new MessageEvent('message', { data: event.data }));
  }

  // Bounded wait: without it a never-nominating ICE agent leaves the page on
  // "connecting…" forever (see CONNECT_TIMEOUT_MS). Cleared on success.
  const connectTimer = setTimeout(() => {
    if (report.transportEstablished()) {
      return;
    }
    void finalizeOutcome('failed', pc);
    root.textContent = describeFailure(report.facts());
    conn.close();
  }, CONNECT_TIMEOUT_MS);

  conn.onconnectionstate((state) => {
    if (state === 'connected') {
      clearTimeout(connectTimer);
      report.reach('datachannel-open');
      // Report the path ICE actually chose — the evidence for whether this
      // session went direct or fell back to TURN. The OUTCOME beacon itself
      // is deliberately NOT sent here: duration/bytes would be ~0 this early
      // (see telemetry.ts's file doc) — it fires once the session actually
      // ends, from conn.onclose or the 'failed' branch below.
      void readSelectedPath(pc).then((path) => {
        report.noteSelectedPath(path);
      });
      startUsagePolling(pc);
      // Embed the tunneled app in an iframe rather than navigating this
      // document to it — a full navigation here would unload the
      // RTCPeerConnection/SW registration living in this page (see
      // renderConnectedShell doc). The iframe's own navigation to '/' is
      // relayed by the SW (shouldBypassRelay treats destination==='iframe'
      // as never-bypassed) even though '/' is reserved for THIS shell on a
      // genuine top-level navigation.
      root.innerHTML = renderConnectedShell();
      const frame = root.querySelector<HTMLIFrameElement>('#beam-frame');
      if (frame) {
        frame.src = '/';
      }
    } else if (state === 'failed') {
      clearTimeout(connectTimer);
      // ViewerConnection.handleConnectionStateChange maps 'failed',
      // 'disconnected', AND 'closed' to this one signal for UI purposes —
      // but 'disconnected' is not necessarily terminal; ICE can recover from
      // it back to 'connected' without the session ever truly ending. A
      // transient blip finalizing HERE was tried and proven wrong by live
      // testing: it consumed the one-shot report with a near-zero, premature
      // snapshot, permanently losing the session's real final usage when the
      // connection then continued for much longer. So this branch only
      // reports 'failed' for a connection that never succeeded at all — a
      // session that DID succeed and then genuinely ends is finalized via
      // conn.onTerminalFailure/conn.onclose below, which only fire for the
      // definitively-terminal sub-states, not a merely transient blip.
      if (!report.transportEstablished()) {
        void finalizeOutcome('failed', pc);
      }
      root.textContent = describeFailure(report.facts());
    }
  });

  // Finalizes a session that already succeeded, once it definitively ends.
  // outcomeForSelectedPath returns null (no-op) if the session never reached
  // a selected path, so this is safe to call unconditionally.
  function finalizeIfEstablished(): void {
    const priorOutcome = outcomeForSelectedPath(report.facts().selectedPath);
    if (priorOutcome) {
      void finalizeOutcome(priorOutcome, pc);
    }
  }

  // Nothing in ViewerConnection calls peer.close() in response to a remote
  // disconnect, so the data channel's own 'close' event (conn.onclose below)
  // is not guaranteed to fire just because the aggregate connection state
  // went terminal — confirmed by live testing: a real host-side Ctrl-C
  // reached 'failed' within seconds, but the data channel never closed and
  // no beacon was sent. onTerminalFailure is ViewerConnection's dedicated
  // signal for the definitively-terminal sub-states ('failed'/'closed'),
  // and is the primary way an established session gets finalized in
  // practice. OutcomeReporter's dedup guard makes it safe for this and
  // conn.onclose to both attempt a report for the same session.
  conn.onTerminalFailure(() => {
    finalizeIfEstablished();
  });

  // B1: wire mux-ready AFTER data channel is open (not on SW claim)
  conn.onmux((mux) => {
    report.reach('relay-ready');
    wireRelayBridge(mux, conn, sessionCode);
    // Exposed for ws-shim.ts, which runs in the tunneled-app iframe and
    // reaches this OUTER window directly (same-origin `window.parent`) since
    // a service worker cannot intercept `new WebSocket()` the way it does fetch().
    window.__beamWsBridge = createWsBridge(mux);
  });

  // N3: on transport close, emit relay-error for all open streams
  conn.onclose((openStreamIds) => {
    // The data channel's own close can fire independently of (and possibly
    // before, or in some cases instead of) onTerminalFailure above — see its
    // wiring comment for why both exist. OutcomeReporter's dedup guard makes
    // it safe for both to attempt a report for the same session.
    finalizeIfEstablished();
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
 * Hand the PIN to the signaling socket, tolerating a socket that has not
 * finished connecting yet — the form is on screen before the WebSocket opens,
 * so a fast typist (or an automated client) can submit during CONNECTING,
 * where send() throws InvalidStateError.
 *
 * Returns true once the PIN is either sent or committed to be sent on open,
 * false if the socket is already gone and the caller should stay retryable.
 */
export function submitPin(ws: WebSocket, rawPin: string): boolean {
  const message = JSON.stringify({ type: 'pin', value: rawPin });
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(message);
      return true;
    } catch {
      return false;
    }
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', () => {
      try {
        ws.send(message);
      } catch {
        // The close handler already drives the failure path from here.
      }
    }, { once: true });
    return true;
  }
  return false;
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

      // A touch "double-tap" (or a keyboard Enter racing a button tap) can
      // fire TWO submit events. `{ once: true }` here meant the SECOND event
      // had no listener to call preventDefault() on, so the browser did a
      // REAL HTML form submission — a GET to this page's own URL using the
      // form's own field as the query string, wiping out ?session=/?signaling=
      // and reloading into "no session code". preventDefault() must run on
      // EVERY submit event; only the SEND to the DO is guarded to happen once.
      let sent = false;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (sent) return;
        const raw = input.value.replace(/\s/g, '');
        // Latch ONLY on a successful hand-off. The PIN form is visible as
        // soon as the page renders, which can be before the signaling socket
        // finishes connecting; sending then throws InvalidStateError. Latching
        // first (as this did) left the user permanently stuck on the PIN
        // screen — the guard blocked every retry while nothing had been sent.
        sent = submitPin(ws, raw);
      });
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
// console.log('[VIEWER-BOOT] pin-ok received');
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
// console.log(`[VIEWER-BOOT] pin-failed attemptsLeft=${String(left)}`);
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
// console.log('[VIEWER-BOOT] SW controller not ready — waiting for controllerchange');
      navigator.serviceWorker.addEventListener('controllerchange', sendMuxReady, { once: true });
      return;
    }
// console.log('[VIEWER-BOOT] sending mux-ready to SW');
    controller.postMessage(serializeSwMessage({ type: 'mux-ready', sessionCode }));
  }
  sendMuxReady();

  // SW restart recovery: re-send mux-ready whenever the SW asks for it.
  // A fresh SW instance has gate.ready=false and cannot receive the one-shot
  // mux-ready that already fired into the previous instance.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = parseSwMessage(event.data as unknown);
    if (msg?.type === 'request-mux-ready') {
// console.log('[VIEWER-BOOT] SW requested mux-ready re-send');
      sendMuxReady();
    }
  });

  // Handle relay-request frames from the SW
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data as { type?: string; streamId?: number; data?: Uint8Array } | null;
    if (!msg || msg.type !== 'relay-request' || typeof msg.streamId !== 'number') return;

    const streamId = msg.streamId;
// console.log(`[PAGE] relay-request sid=${String(streamId)} dataLen=${String(msg.data?.byteLength ?? 0)}`);

    // Register the response listener on the first frame for this stream only.
    if (!listeningStreams.has(streamId)) {
      listeningStreams.add(streamId);
      conn.trackStream(streamId);
      // The SW allocated this id — the mux must adopt it before writeFrame,
      // which rejects unknown streams as 'not-open'.
      const adopted = mux.adoptStream(streamId);
      if (!adopted.ok) {
// console.log(`[PAGE] adoptStream REJECTED sid=${String(streamId)} reason=${adopted.error.reason}`);
      }

      const unsubscribe = mux.onInbound((frame) => {
        if (frame.streamId !== streamId) return;
        const encoded = encodeFrame(frame);
        const sw = navigator.serviceWorker.controller;
        if (sw) {
          sw.postMessage(serializeSwMessage({ type: 'relay-response', streamId, data: encoded }));
        }
        // This page forwards response bytes to the service worker and retains
        // nothing, so the mux must stop counting them against the stream's
        // buffer cap. Without this, the cap measured the response's TOTAL size
        // and killed any response over 1 MiB mid-body (see releaseInbound).
        mux.releaseInbound(frame);
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
// console.log(`[PAGE] decodeFrame ERROR sid=${String(streamId)}`, frame);
    return;
  }
  mux.writeFrame(frame);
// console.log(`[PAGE] writeFrame sid=${String(streamId)} type=${String(frame.type)}`);
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
