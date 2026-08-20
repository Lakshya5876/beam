/**
 * Per-session isolation over sw-fetch-gate.ts's (deliberately single-session)
 * FetchGate — the fix for SECURITY_AUDIT_20-08.md finding #1 (Critical):
 * cross-session relay hijack.
 *
 * One Service Worker instance controls EVERY tab open to this origin,
 * including two entirely unrelated Beam sessions running concurrently in two
 * tabs (the common case, since the default viewer deployment is a single
 * shared public origin — see src/presentation/cli.ts DEFAULT_VIEWER_URL).
 * The vulnerable implementation kept exactly one FetchGate — one relay
 * target, one open-stream set, one pending queue — as SW module state, so
 * whichever tab's `mux-ready` landed last silently became the routing target
 * for every fetch from every tab. This module gives each session its own
 * FetchGate, keyed by its sessionCode (a >=128-bit CSPRNG value minted by the
 * signaling Durable Object — signaling/src/session-code.ts — so it is safe
 * to use as a map key: an attacker cannot choose or predict one to collide
 * with another session's).
 *
 * The other half of the fix is routing: a fetch must be attributed to a
 * session BEFORE it is ever handed to a gate, and an unattributable fetch
 * must fail closed (504), never fall back to "whichever session is current"
 * — see sw.ts's resolveSession for how a fetch's owning session is
 * determined (a direct client-id mapping first, the outer document's own
 * referrer for a brand-new iframe navigation second, and a bounded wait for
 * a re-announcement third — never a guess).
 */

import { createFetchGate, onMuxGone, onMuxReady, type FetchGate, type PendingItem } from './sw-fetch-gate.js';

/** How long a fetch waits for its owning session to (re-)announce itself
 *  (SW-restart recovery — see sw.ts requestReannounce) before failing
 *  closed. Short relative to RELAY_TIMEOUT_MS: a same-origin postMessage
 *  round-trip normally settles in well under a second. */
export const REANNOUNCE_TIMEOUT_MS = 3000;

interface ClientLike {
  readonly id: string;
}

export interface SessionRegistry {
  readonly gates: Map<string, FetchGate>;
  readonly clientToSession: Map<string, string>;
  readonly waiters: Map<string, Array<(sessionCode: string | null) => void>>;
}

export function createSessionRegistry(): SessionRegistry {
  return { gates: new Map(), clientToSession: new Map(), waiters: new Map() };
}

/** Get this session's FetchGate, creating a fresh (not-ready) one on first use. */
export function gateFor(registry: SessionRegistry, sessionCode: string): FetchGate {
  let gate = registry.gates.get(sessionCode);
  if (!gate) {
    gate = createFetchGate();
    registry.gates.set(sessionCode, gate);
  }
  return gate;
}

function resolveWaiters(registry: SessionRegistry, clientId: string, sessionCode: string | null): void {
  const list = registry.waiters.get(clientId);
  if (!list) return;
  registry.waiters.delete(clientId);
  for (const resolve of list) resolve(sessionCode);
}

/**
 * First-claim-wins: a client id is bound to a session at most once. Every
 * document (top-level or nested) gets a brand-new, never-reused client id
 * from the browser on each navigation, so a client id legitimately needing
 * to be RE-bound to a DIFFERENT session never happens — the only way this
 * check ever fires is a second, contradicting claim for an id that already
 * has an answer.
 *
 * This closes a bypass a fresh adversarial pass found in this fix itself:
 * 'iframe-owner' announcements are self-reported by whatever script is
 * running inside the tunneled-app iframe — ordinarily Beam's own trusted
 * ws-shim.ts, but if the developer's tunneled app has an XSS vulnerability,
 * attacker-controlled script running there could otherwise call
 * `controller.postMessage({type:'iframe-owner', sessionCode: <anything>})`
 * directly, with no need to know a PIN, and — without this guard — silently
 * redirect its OWN iframe's future fetches to a DIFFERENT, already-active
 * session's gate merely by naming that session's code. Rejecting a second,
 * different claim for an already-bound client id means the only way to
 * BOOTSTRAP a fresh binding is the trustworthy paths (the browser-controlled
 * Referer on a brand-new navigation, or this exact clientId's own first,
 * unclaimed announcement) — a claim can confirm what is already true, or
 * fill an actual gap, but never override an established one.
 */
function tryBind(registry: SessionRegistry, clientId: string, sessionCode: string): boolean {
  const existing = registry.clientToSession.get(clientId);
  if (existing !== undefined && existing !== sessionCode) {
    return false;
  }
  registry.clientToSession.set(clientId, sessionCode);
  return true;
}

/**
 * The outer shell's own window announced its mux is ready (bootstrap.ts
 * wireRelayBridge -> 'mux-ready'). Binds this WindowClient as the session's
 * routing target and records its client id -> session mapping (so a
 * 'relay-response'/'relay-error' arriving later from this same client can be
 * attributed without trusting anything in the message body itself — see
 * sw.ts, which looks up the SENDER's client id, not a session code the
 * message claims). A mismatched re-announcement for an already-bound outer
 * client id is rejected the same as registerClientOwner's — see tryBind.
 */
export function registerSessionSource<S extends ClientLike>(
  registry: SessionRegistry,
  sessionCode: string,
  source: S,
): { gate: FetchGate; toFlush: PendingItem[] } | null {
  if (!tryBind(registry, source.id, sessionCode)) {
    return null;
  }
  const gate = gateFor(registry, sessionCode);
  const toFlush = onMuxReady(source, sessionCode, gate as FetchGate & { source: S | null });
  resolveWaiters(registry, source.id, sessionCode);
  return { gate, toFlush };
}

/**
 * A client has identified which session it belongs to — sent by ws-shim.ts
 * on every relayed HTML page load (using window.parent.__beamSessionCode,
 * same-origin, always current) so every subsequent fetch from that iframe
 * document routes correctly, including after a full-page navigation inside
 * it that swaps in a brand-new client id. Returns false (a no-op past the
 * bind attempt) if this client id already belongs to a DIFFERENT session —
 * see tryBind's doc for why that must never be allowed to change.
 */
export function registerClientOwner(registry: SessionRegistry, clientId: string, sessionCode: string): boolean {
  if (!clientId) return false; // never a map key — an empty id would be indistinguishable
  // from "no client id" (a fresh navigation) and silently resolve every
  // future clientId-less fetch to whichever session last registered one.
  if (!tryBind(registry, clientId, sessionCode)) {
    return false;
  }
  gateFor(registry, sessionCode); // ensure a (possibly not-yet-ready) gate exists
  resolveWaiters(registry, clientId, sessionCode);
  return true;
}

/** Best-effort, synchronous, no waiting: what is already known right now. */
export function knownSessionFor(registry: SessionRegistry, clientId: string): string | null {
  return clientId ? (registry.clientToSession.get(clientId) ?? null) : null;
}

/**
 * Wait briefly for `clientId` to identify itself (registerClientOwner /
 * registerSessionSource) — the SW-restart-recovery path, where module state
 * (and so the registry) was lost and the caller has already broadcast a
 * re-announce request to every window client. Resolves null on timeout
 * rather than hanging, so the caller can fail closed instead of guessing.
 */
export function waitForClientOwner(
  registry: SessionRegistry,
  clientId: string,
  timeoutMs: number = REANNOUNCE_TIMEOUT_MS,
): Promise<string | null> {
  const already = knownSessionFor(registry, clientId);
  if (already) return Promise.resolve(already);
  if (!clientId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const list = registry.waiters.get(clientId) ?? [];
    const onResolved = (sessionCode: string | null): void => {
      clearTimeout(timer);
      resolve(sessionCode);
    };
    const timer = setTimeout(() => {
      const current = registry.waiters.get(clientId);
      if (current) {
        const idx = current.indexOf(onResolved);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) registry.waiters.delete(clientId);
      }
      resolve(null);
    }, timeoutMs);
    list.push(onResolved);
    registry.waiters.set(clientId, list);
  });
}

export interface DroppedSession {
  readonly pending: PendingItem[];
  readonly openStreamIds: number[];
}

/**
 * The session's DataChannel/mux is gone (host disconnected, the tab's
 * RTCPeerConnection closed, or the tab itself unloaded) — drop all
 * bookkeeping for it so a stale sessionCode, or a stale client-id mapping,
 * can never again be resolved to a dead target. Returns what sw-fetch-
 * gate.ts's onMuxGone reports (open streams to fail, pending fetches to
 * reject) so the caller can finish them off. No-op (returns null) if the
 * session was already gone or never existed — this can be reported more
 * than once (e.g. both an explicit 'mux-gone' message and a later cleanup
 * sweep) without harm.
 */
export function dropSession(registry: SessionRegistry, sessionCode: string): DroppedSession | null {
  const gate = registry.gates.get(sessionCode);
  if (!gate) return null;
  const result = onMuxGone(gate);
  registry.gates.delete(sessionCode);
  for (const [clientId, code] of registry.clientToSession) {
    if (code === sessionCode) registry.clientToSession.delete(clientId);
  }
  return result;
}
