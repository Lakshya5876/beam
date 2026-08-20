/// <reference lib="webworker" />
/**
 * Service Worker entry point (S16 — impure boundary, verified live at S18).
 * Thin glue over sw-fetch-gate.ts, sw-session-registry.ts, and sw-bridge.ts
 * pure modules.
 *
 * Path-based exclusion (N1, see sw-fetch-gate.ts shouldBypassRelay): /,
 * /assets/*, and /__beam/* pass through — the viewer's own shell, bundle,
 * and bootstrap assets. Everything else same-origin is relayed.
 *
 * SESSION ISOLATION (SECURITY_AUDIT_20-08.md finding #1): this SW instance
 * can be controlling several unrelated Beam sessions' tabs at once. Every
 * fetch is attributed to a specific session BEFORE it is dispatched to that
 * session's own FetchGate (sw-session-registry.ts) — never to "whichever
 * session most recently connected". An unattributable fetch fails closed
 * (504) rather than guessing.
 */

import { parseSwMessage, serializeSwMessage } from './sw-bridge.js';
import { ResponseAssembler } from './response-assembler.js';
import {
  enqueue,
  make504,
  nextStreamId,
  shouldBypassRelay,
  trackStreamClose,
  RELAY_TIMEOUT_MS,
  type FetchGate,
} from './sw-fetch-gate.js';
import {
  createSessionRegistry,
  dropSession,
  gateFor,
  knownSessionFor,
  registerClientOwner,
  registerSessionSource,
  waitForClientOwner,
  type SessionRegistry,
} from './sw-session-registry.js';
import { extractSessionCodeFromUrl } from './viewer-url.js';
import { encodeFrame, decodeFrame, FrameType, isFrameDecodeError } from './protocol-bridge.js';
import { encodeRequest } from './request-serializer.js';

declare const self: ServiceWorkerGlobalScope;

const registry: SessionRegistry = createSessionRegistry();

/** Keyed by `${sessionCode}:${streamId}` — NEVER a bare streamId. Stream ids
 *  are only unique within one session's own gate (each session's counter
 *  starts at 1 independently), so a bare-number key would let two sessions'
 *  in-flight streams collide and cross-deliver responses the moment both
 *  happened to be mid-request at once. This is the second half of finding
 *  #1's fix: gate.source routing alone is not enough if this bookkeeping can
 *  still cross-wire. */
const assemblers = new Map<string, ResponseAssembler>();
const responseResolvers = new Map<string, (r: Response) => void>();

function bookKey(sessionCode: string, streamId: number): string {
  return `${sessionCode}:${String(streamId)}`;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = parseSwMessage(event.data as unknown);
  if (!msg) return;
  const source = event.source as WindowClient;
  if (msg.type === 'mux-ready') handleMuxReady(source, msg.sessionCode);
  else if (msg.type === 'iframe-owner') handleIframeOwner(source, msg.sessionCode);
  else if (msg.type === 'mux-gone') handleMuxGone(msg.sessionCode);
  else if (msg.type === 'relay-response' || msg.type === 'relay-error') handleFromOuterWindow(source, msg);
});

function handleMuxReady(source: WindowClient, sessionCode: string): void {
  const registered = registerSessionSource(registry, sessionCode, source);
  if (!registered) return; // this client id already claimed a DIFFERENT session — never rebind, see tryBind
  const { gate, toFlush } = registered;
  for (const item of toFlush) {
    clearTimeout(item.timer);
    const idx = gate.pending.indexOf(item);
    if (idx >= 0) gate.pending.splice(idx, 1);
    item.resolve({ ok: true });
  }
}

function handleIframeOwner(source: WindowClient, sessionCode: string): void {
  registerClientOwner(registry, source.id, sessionCode);
}

/** The session's DataChannel/mux is gone — fail every stream still open or
 *  queued for it and forget its routing so a stale sessionCode can never
 *  again resolve to a dead target. */
function handleMuxGone(sessionCode: string): void {
  const dropped = dropSession(registry, sessionCode);
  if (!dropped) return;
  for (const item of dropped.pending) {
    clearTimeout(item.timer);
    item.resolve({ ok: false, response: make504('disconnect') });
  }
  for (const streamId of dropped.openStreamIds) {
    finishWithError(sessionCode, streamId, 'disconnect');
  }
}

/** 'relay-response' / 'relay-error' only ever come from the outer window that
 *  registered itself via 'mux-ready' — the sender's OWN client id (not
 *  anything the message body claims) determines which session's bookkeeping
 *  to touch. A message from an unregistered sender is dropped: it cannot be
 *  attributed to any session, so there is nothing safe to do with it. */
function handleFromOuterWindow(
  source: WindowClient,
  msg: { type: 'relay-response' | 'relay-error'; streamId: number; data?: Uint8Array; reason?: string },
): void {
  const sessionCode = knownSessionFor(registry, source.id);
  if (!sessionCode) return;
  if (msg.type === 'relay-response' && msg.data) {
    handleRelayResponse(sessionCode, msg.streamId, msg.data);
  } else if (msg.type === 'relay-error') {
    const reason = msg.reason ?? 'relay error';
    finishWithError(sessionCode, msg.streamId, reason);
  }
}

function handleRelayResponse(sessionCode: string, streamId: number, frameBytes: Uint8Array): void {
  const frame = decodeFrame(frameBytes);
  if (isFrameDecodeError(frame)) return;

  // ERROR frame (type 7): the host rejected or failed the request. Resolve
  // the pending fetch with 502 instead of hanging it forever (the silent-hang
  // variant was caught by the local e2e harness).
  if (frame.type === FrameType.ERROR) {
    const reason = new TextDecoder().decode(frame.payload) || 'relay error';
    finishWithError(sessionCode, streamId, reason);
    return;
  }

  const key = bookKey(sessionCode, streamId);
  let assembler = assemblers.get(key);
  if (!assembler) {
    assembler = new ResponseAssembler();
    assemblers.set(key, assembler);
  }

  const feedResult = assembler.feed(frame);

  // Resolve respondWith on first RESPONSE_HEAD (streaming body continues after)
  const resolver = responseResolvers.get(key);
  if (resolver) {
    try {
      const response = assembler.buildResponse();
      responseResolvers.delete(key);
      resolver(response);
    } catch {
      // buildResponse throws before RESPONSE_HEAD — ignore, wait for next frame
    }
  }

  if (feedResult === 'complete' || feedResult === 'error') {
    assemblers.delete(key);
    finishStream(sessionCode, streamId);
  }
}

function finishWithError(sessionCode: string, streamId: number, reason: string): void {
  const key = bookKey(sessionCode, streamId);
  assemblers.get(key)?.abort(reason);
  assemblers.delete(key);
  const resolver = responseResolvers.get(key);
  if (resolver) {
    responseResolvers.delete(key);
    resolver(make504(reason));
  }
  finishStream(sessionCode, streamId);
}

function finishStream(sessionCode: string, streamId: number): void {
  const gate = registry.gates.get(sessionCode);
  if (gate) trackStreamClose(streamId, gate);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (shouldBypassRelay(url.pathname, event.request.destination)) return; // Viewer's own shell/bundle/bootstrap assets — pass through (never the iframe's own navigations, see shouldBypassRelay)
  if (url.origin !== self.location.origin) return;  // Cross-origin — pass through
  event.respondWith(handleFetch(event.request, event.clientId));
});

/**
 * Ask every window client (every tab this SW controls, across every
 * session) to re-announce itself: outer windows re-send 'mux-ready',
 * tunneled-app iframes re-send 'iframe-owner' (see ws-shim.ts). Used both
 * for SW-restart recovery (module state — the whole registry — was lost)
 * and for a plain unregistered client id, since either way the only safe
 * thing to do is ask, never guess.
 */
function requestReannounce(): void {
  void self.clients.matchAll({ type: 'window' }).then((clients) => {
    const msg = serializeSwMessage({ type: 'request-mux-ready' });
    for (const client of clients) client.postMessage(msg);
  });
}

/**
 * Attribute a fetch to exactly one session, or null if it cannot be —
 * NEVER a fallback to "whichever session is current" (that was the Critical
 * cross-session hijack this module fixes; see file doc and
 * SECURITY_AUDIT_20-08.md finding #1).
 *
 *   1. A client id we already have an owner for (the common case for every
 *      fetch after the first on a page: images, XHR/fetch calls, subsequent
 *      SPA navigations that don't reload the document).
 *   2. A brand-new iframe navigation has no client yet (clientId is empty —
 *      nothing has loaded there before), so the only signal available BEFORE
 *      any response has been seen is the referring document's own URL: the
 *      OUTER window set `frame.src` on a same-origin target, so the browser
 *      sends the outer window's full URL (including its session code) as
 *      this navigation's referrer. Trusted ONLY for an actual navigation
 *      (`request.mode === 'navigate'`) — a page can freely pass a spoofed,
 *      same-origin `referrer` option to its OWN fetch()/XHR calls (case 1
 *      already covers those anyway via the client id), but it cannot forge
 *      the Referer the browser sends for a real navigation it triggers,
 *      which is exactly the property this path depends on. A LATER
 *      full-page navigation *within* the already-loaded iframe carries the
 *      iframe's own prior client id instead (case 1), not the outer
 *      window's URL, which is why this path alone is not sufficient for the
 *      whole session lifetime — case 3 covers that.
 *   3. Neither of the above resolved anything: either this SW instance was
 *      just restarted (all in-memory registry state, and the browser's own
 *      per-client identity together, were lost) or the owning session simply
 *      hasn't announced itself yet. Ask every client to re-announce and wait
 *      briefly. If nothing claims this client id in time, fail closed.
 *      registerClientOwner's first-claim-wins rule (sw-session-registry.ts)
 *      means whatever wins this race is permanent for this client id — see
 *      that function's doc for why a SECOND, contradicting claim can never
 *      override it later, which is what actually matters here: even a
 *      compromised tunneled app racing its own forged 'iframe-owner' claim
 *      can only ever contest the FIRST assignment, never hijack an
 *      already-correctly-bound client away from its real session.
 */
async function resolveSession(request: Request, clientId: string): Promise<string | null> {
  const known = knownSessionFor(registry, clientId);
  if (known) return known;

  if (request.mode === 'navigate') {
    const fromReferrer = extractSessionCodeFromUrl(request.referrer);
    if (fromReferrer) return fromReferrer;
  }

  if (!clientId) return null; // nothing to correlate a re-announce against
  requestReannounce();
  return waitForClientOwner(registry, clientId);
}

function postRelayFrames(source: WindowClient, streamId: number, frames: ReturnType<typeof encodeRequest>): void {
  for (const frame of frames) {
    source.postMessage(serializeSwMessage({ type: 'relay-request', streamId, data: encodeFrame(frame) }));
  }
}

/**
 * Resolve which session owns this fetch AND make sure that clientId is
 * registered for next time — split out of handleFetch purely to keep that
 * function's branching within the lint complexity budget; the two steps
 * always run together.
 */
async function resolveSessionAndRegister(request: Request, clientId: string): Promise<string | null> {
  const sessionCode = await resolveSession(request, clientId);
  if (!sessionCode) return null;
  // Resolved via the referrer (a brand-new iframe navigation) or a fresh
  // re-announce — either way this exact clientId may not be registered yet.
  // Register it now so every later fetch from the same client resolves
  // directly, without re-parsing a referrer or waiting again.
  if (clientId && knownSessionFor(registry, clientId) !== sessionCode) {
    registerClientOwner(registry, clientId, sessionCode);
  }
  return sessionCode;
}

/** Build the REQUEST_HEAD + REQUEST_BODY_CHUNK(s) + REQUEST_END frames for one relayed fetch. */
async function buildRequestFrames(streamId: number, request: Request): Promise<ReturnType<typeof encodeRequest>> {
  const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname + (reqUrl.search ?? '');
  // Record shape — the host's decodeRequestHead contract (NOT array-of-pairs).
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  return encodeRequest(streamId, { method: request.method, path, headers, body: bodyBytes });
}

async function handleFetch(request: Request, clientId: string): Promise<Response> {
  // Tracked outside the try body so the catch clause can release this
  // stream's slot from the RIGHT session's gate if something throws after
  // it was opened — mirrors the pre-fix behavior, now session-scoped.
  let opened: { sessionCode: string; streamId: number } | null = null;
  try {
    const sessionCode = await resolveSessionAndRegister(request, clientId);
    if (!sessionCode) return make504('no-session');

    const gate: FetchGate = gateFor(registry, sessionCode);
    const streamId = nextStreamId(gate);
    opened = { sessionCode, streamId };
    if (!gate.ready) {
      requestReannounce();
    }

    const result = await enqueue(streamId, RELAY_TIMEOUT_MS, gate);
    if (!result.ok) return result.response;

    const source = gate.source as WindowClient | null;
    if (!source) return make504('no-source');

    const frames = await buildRequestFrames(streamId, request);
    postRelayFrames(source, streamId, frames);

    return new Promise<Response>((resolve) => {
      responseResolvers.set(bookKey(sessionCode, streamId), resolve);
    });
  } catch (err) {
    if (opened) finishStream(opened.sessionCode, opened.streamId);
    return make504(`internal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

