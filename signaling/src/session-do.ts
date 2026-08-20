/**
 * Session Durable Object (design §10 S14, §A.2.4). One instance per session
 * code pairs a host + viewer and relays SDP/ICE OPAQUELY; the single
 * "registry" instance mints unique codes and holds the used-token set.
 *
 * WebSocket Hibernation API: sockets are accepted with state.acceptWebSocket
 * (NOT ws.accept()), so idle sessions bill no duration (free-tier). Because
 * hibernation discards in-memory instance state, peer ROLE is stored as a
 * socket TAG (survives eviction) and read back via state.getTags — never an
 * in-memory map. The pure role/relay logic is in pairing.ts.
 *
 * PIN pairing (M3): host sends {"type":"pin-register","hash":"<sha256>"} after
 * connecting; DO stores the hash. Viewer sends {"type":"pin","value":"<6digits>"};
 * DO verifies SHA-256(value + ":" + sessionCode) against stored hash. On match,
 * pendingForViewer is flushed and WebRTC signaling begins. Three-strike lockout.
 *
 * Security invariant: relayMessage forwards NEITHER direction until pinVerified
 * — not just host->viewer. Before this fix, a viewer socket that never submitted
 * a PIN (or the wrong one) could still have its SDP-answer/ICE-candidate frames
 * relayed straight to the host, and — because assignRole grants the 'viewer' tag
 * on connect, before any PIN check — an attacker holding only the shareable link
 * (no PIN) could occupy the sole viewer slot indefinitely, permanently locking
 * out the real viewer (assignRole rejects a third connection as session-full).
 * Two mitigations: (1) relayMessage below drops viewer-origin messages outright
 * pre-verification instead of forwarding them; (2) an unverified viewer socket
 * is evicted by a DO alarm after VIEWER_VERIFY_TIMEOUT_MS so a squatter cannot
 * hold the slot forever — the wrong-PIN lockout already frees it after 3
 * attempts, this covers the "never attempts" case.
 *
 * Security invariant (SECURITY_AUDIT_20-08.md finding #2 — host-role hijack):
 * role assignment is "first to (re-)connect to this code claims the free
 * slot" with no per-connection identity beyond that. Before this fix,
 * PIN_VERIFIED_KEY was written once and never cleared, so if either peer's
 * socket ever dropped (a network blip, a laptop sleeping — ordinary events
 * over a session's lifetime, not just attacker action) the vacated role slot
 * could be reclaimed by ANY holder of the session code — including someone
 * who never proved PIN knowledge — and relayMessage would immediately start
 * relaying to/from them anyway, because it only ever checked the STICKY,
 * session-scoped verified flag, never "is this the same connection that
 * earned it". A viewer already past the PIN gate had no way to tell the
 * difference between the real host and an impostor who simply reconnected
 * faster. Fix: onPeerGone (wired to webSocketClose/webSocketError, which the
 * pre-fix implementation did not handle AT ALL — the DO did nothing when a
 * socket disappeared) tears the PIN state back down to "unverified" and
 * closes the other peer's socket — but NOT symmetrically for both roles;
 * see onPeerGone's own doc for exactly why. In short: a HOST disconnect
 * always resets everything (the host owns the PIN hash, so a reconnecting
 * party — legitimate or not — must prove PIN knowledge again before any
 * further signaling is relayed), while a VIEWER disconnect only resets
 * anything if that viewer had ALREADY verified — an unverified viewer
 * leaving (T1b's squatter-eviction case) must NOT disturb the host or the
 * still-valid hash, or the very recovery flow T1b relies on breaks. An
 * impostor who does not know the real PIN can register any hash they like
 * for the 'host' role and it will never match what the real viewer types,
 * so no relaying can begin. This is a live pairing, not a durable
 * credential: it does not outlive the verified connections that formed it.
 *
 * Runtime-bound; the live pairing/relay/hibernation path is verified at S18.
 */

import { assignRole, relayTargetRole, type PeerRole } from './pairing.js';
import { isWithinSizeCap } from './message-size.js';
import { mintUnusedCode } from './session-code.js';
import { StorageUsedTokenStore } from './used-token-store.js';
import { RateLimiter } from './rate-limit.js';
import { hashPin, PIN_HASH_KEY, PIN_ATTEMPTS_KEY, PIN_MAX_ATTEMPTS } from './pin-store.js';

const USED_PREFIX = 'used:';

// Storage keys — survive DO hibernation (in-memory state does NOT).
const PIN_VERIFIED_KEY = 'pin-verified';
const PENDING_COUNT_KEY = 'pending-count';
const PENDING_PREFIX = 'pending:';

/**
 * How long an unverified viewer may occupy the sole viewer slot before the DO
 * evicts it (closes the socket, freeing the slot for a new connection
 * attempt). Generous enough for a human to read a shared code and type it;
 * bounded so a link-only attacker cannot squat the slot forever.
 */
export const VIEWER_VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

/** Deploy-time policy knobs (wrangler.jsonc vars); defaults preserved. */
export interface SessionPolicyEnv {
  /** Mint requests allowed per IP per minute (default 30). */
  MINT_MAX_PER_MINUTE?: string;
  /** PIN attempts before lockout (default 3). */
  PIN_MAX_ATTEMPTS?: string;
}

function policyInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class SessionDurableObject {
  private readonly mintLimiter: RateLimiter;
  private readonly pinMaxAttempts: number;
  /**
   * Serializes PIN-verify attempts so a read-then-write of PIN_ATTEMPTS_KEY
   * can never interleave across two nearly-simultaneous guesses (SECURITY_AUDIT_20-08.md
   * finding #5). A Durable Object instance is single-threaded but NOT
   * single-request-at-a-time: two webSocketMessage invocations for two
   * guesses submitted back-to-back can both read the same attempts value
   * before either writes it back, because the async gaps in between (the
   * SHA-256 digest, the storage read/write) are yield points where the
   * runtime can interleave a second in-flight handler. Chaining every
   * attempt behind an in-memory promise — scoped to this instance, which is
   * exactly where the race lives — makes the whole read-check-write
   * sequence atomic relative to other attempts on the SAME instance, with no
   * new storage API needed.
   */
  private pinVerifyQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    env: SessionPolicyEnv = {},
  ) {
    this.mintLimiter = new RateLimiter({
      maxPerWindow: policyInt(env.MINT_MAX_PER_MINUTE, 30),
      windowMs: 60_000,
    });
    this.pinMaxAttempts = policyInt(env.PIN_MAX_ATTEMPTS, PIN_MAX_ATTEMPTS);
  }

  fetch(request: Request): Response | Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.acceptPeer();
    }
    return this.mint(request);
  }

  private async mint(request: Request): Promise<Response> {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!this.mintLimiter.check(ip, Date.now())) {
      return new Response('rate limited', { status: 429 });
    }
    const known = await this.loadUsedCodes();
    const store = new StorageUsedTokenStore(known, {
      put: (code) => {
        void this.state.storage.put(`${USED_PREFIX}${code}`, true);
      },
    });
    const code = mintUnusedCode(store);
    if (code === null) {
      return new Response('mint exhausted', { status: 503 });
    }
    return Response.json({ code });
  }

  private acceptPeer(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const assignment = assignRole(this.currentRoles());
    if (!assignment.ok) {
      this.state.acceptWebSocket(server);
      server.close(1013, assignment.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server, [assignment.role]);
    if (assignment.role === 'viewer') {
      // Bound how long an unverified viewer can hold the slot (see class doc).
      // Overwrites any prior alarm — fine, there is at most one viewer at a time.
      void this.state.storage.setAlarm(Date.now() + VIEWER_VERIFY_TIMEOUT_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Evict an unverified viewer so a link-only attacker cannot squat the sole
   * viewer slot forever. No-op if the viewer already verified (or left) —
   * pinVerified is checked fresh, not assumed from scheduling time.
   */
  async alarm(): Promise<void> {
    const pinVerified = (await this.state.storage.get<boolean>(PIN_VERIFIED_KEY)) === true;
    if (pinVerified) {
      return;
    }
    for (const ws of this.state.getWebSockets('viewer')) {
      try { ws.close(4001, 'verification-timeout'); } catch { /* already closed */ }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (!isWithinSizeCap(size)) {
      ws.close(1009, 'message-too-large');
      return;
    }
    const senderRole = this.roleOf(ws);
    if (senderRole === null) {
      return;
    }

    // Intercept control messages (use `type` field, distinct from SDP/ICE `kind`).
    if (typeof message === 'string') {
      const control = tryParseControl(message);
      if (control !== null) {
        await this.handleControl(ws, senderRole, control);
        return;
      }
    }

    // Opaque relay: viewer must be PIN-verified before host messages are forwarded.
    await this.relayMessage(senderRole, message);
  }

  /**
   * Either peer's socket is gone (clean close, error, or the hibernation API
   * evicting it — including this DO's OWN alarm() calling ws.close() on an
   * unverified viewer, which the real hibernation API routes back through
   * this same handler). Safe to call more than once (a close AND an error
   * can both fire for the same socket) and safe if the socket was never
   * tagged at all (e.g. a connection rejected as session-full before any
   * role was assigned). See onPeerGone for why the two roles are NOT
   * treated symmetrically — an early version of this fix was.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onPeerGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onPeerGone(ws);
  }

  /**
   * Tears down the live pairing when a peer disconnects — but ONLY as much
   * as the host-role-hijack fix (class doc) actually requires, which is
   * role-asymmetric:
   *
   *   - HOST gone: unconditionally reset ALL PIN state and close any
   *     viewer. The host owns/registers the PIN hash, so whoever reconnects
   *     to 'host' next — legitimate or not — must have a reconnecting
   *     viewer re-earn verification against a hash THEY explicitly
   *     register. This must hold even if no viewer had verified yet: a
   *     stale, unchanged hash would otherwise still let an attacker
   *     squatting the vacated host role benefit for free the moment a
   *     genuine viewer later retries the SAME real PIN against it.
   *
   *   - VIEWER gone, but never verified: a no-op past freeing the slot.
   *     This is T1b's squatter-eviction path (a link-only attacker with no
   *     PIN, occupying the sole viewer slot, evicted by the alarm below OR
   *     simply giving up) — nothing was ever trusted with this viewer, so
   *     there is nothing to tear down, and the host must be left completely
   *     undisturbed so it keeps waiting for the genuine viewer to retry
   *     against the SAME still-valid hash. An earlier version of this fix
   *     reset PIN state and closed the host on EVERY viewer disconnect,
   *     which broke exactly this recovery path — a fresh adversarial pass
   *     over the fix itself caught it (see SECURITY_AUDIT_20-08.md).
   *
   *   - VIEWER gone, already verified: the mirror of the host case. An
   *     attacker who reclaims the now-vacant viewer slot must not silently
   *     inherit a pairing that was verified for someone else, so this
   *     clears PIN_VERIFIED_KEY (forcing re-verification) and closes the
   *     host — but leaves PIN_HASH_KEY alone, since the still-connected
   *     host is not compromised by its viewer disconnecting and a
   *     reconnecting attacker still cannot produce a hash match without
   *     knowing the real PIN.
   */
  private async onPeerGone(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (role === null) {
      return;
    }
    if (role === 'host') {
      await this.resetPinState();
      await this.state.storage.deleteAlarm();
      this.closePeers(relayTargetRole(role));
      return;
    }
    const wasVerified = (await this.state.storage.get<boolean>(PIN_VERIFIED_KEY)) === true;
    if (!wasVerified) {
      return;
    }
    await this.state.storage.delete(PIN_VERIFIED_KEY);
    await this.state.storage.deleteAlarm();
    this.closePeers(relayTargetRole(role));
  }

  private closePeers(role: PeerRole): void {
    for (const peer of this.state.getWebSockets(role)) {
      try { peer.close(4002, 'peer-disconnected'); } catch { /* already closed */ }
    }
  }

  /** Drop every trace of the current PIN pairing: the hash, the attempt
   *  counter, and any SDP/ICE buffered for a viewer that has not (or no
   *  longer) proven PIN knowledge. Whoever reconnects — to either role —
   *  must re-establish the pairing from scratch. */
  private async resetPinState(): Promise<void> {
    const pendingCount = (await this.state.storage.get<number>(PENDING_COUNT_KEY)) ?? 0;
    const pendingKeys = Array.from({ length: pendingCount }, (_, i) => `${PENDING_PREFIX}${String(i)}`);
    await Promise.all([
      this.state.storage.delete(PIN_HASH_KEY),
      this.state.storage.delete(PIN_VERIFIED_KEY),
      this.state.storage.delete(PIN_ATTEMPTS_KEY),
      this.state.storage.delete(PENDING_COUNT_KEY),
      ...(pendingKeys.length > 0 ? [this.state.storage.delete(pendingKeys)] : []),
    ]);
  }

  private async relayMessage(senderRole: PeerRole, message: string | ArrayBuffer): Promise<void> {
    const pinVerified = (await this.state.storage.get<boolean>(PIN_VERIFIED_KEY)) === true;

    if (!pinVerified) {
      // Host's pre-verification offer/ICE is buffered for flush after pin-ok
      // (below). A viewer's pre-verification messages are never legitimate —
      // the real viewer's page does not send anything but the PIN control
      // message until it has received pin-ok — so they are dropped outright
      // rather than relayed. Relaying them was the hole: an attacker holding
      // only the link (no PIN) could inject SDP/ICE at the host before ever
      // proving they know the PIN.
      if (senderRole === 'host' && typeof message === 'string') {
        // Persist to storage — in-memory state does not survive DO hibernation.
        const count = (await this.state.storage.get<number>(PENDING_COUNT_KEY)) ?? 0;
        await this.state.storage.put(`${PENDING_PREFIX}${count}`, message);
        await this.state.storage.put(PENDING_COUNT_KEY, count + 1);
      }
      return;
    }
    const targets = this.state.getWebSockets(relayTargetRole(senderRole));
    for (const peer of targets) {
      try { peer.send(message); } catch { /* target WS already closed — drop silently */ }
    }
  }

  private async handleControl(
    ws: WebSocket,
    senderRole: PeerRole,
    control: Record<string, unknown>,
  ): Promise<void> {
    const type = control['type'];
    if (type === 'pin-register' && senderRole === 'host') {
      const hash = control['hash'];
      if (typeof hash === 'string' && hash.length === 64) {
        await this.handlePinRegister(hash);
      }
    } else if (type === 'pin' && senderRole === 'viewer') {
      const value = control['value'];
      if (typeof value === 'string') {
        await this.handlePinVerify(ws, value);
      }
    }
  }

  private async handlePinRegister(hash: string): Promise<void> {
    await this.state.storage.put(PIN_HASH_KEY, hash);
    await this.state.storage.put(PIN_ATTEMPTS_KEY, this.pinMaxAttempts);
  }

  /**
   * Entry point for a PIN guess — serializes onto pinVerifyQueue (see that
   * field's doc) before doing any real work, so the read-check-write of
   * PIN_ATTEMPTS_KEY in doHandlePinVerify below can never race against a
   * second guess submitted moments later.
   */
  private handlePinVerify(ws: WebSocket, rawPin: string): Promise<void> {
    const attempt = this.pinVerifyQueue.then(() => this.doHandlePinVerify(ws, rawPin));
    // Swallow here so one failed attempt never poisons the queue for the
    // next one; doHandlePinVerify itself is total (never throws) regardless.
    this.pinVerifyQueue = attempt.catch(() => undefined);
    return attempt;
  }

  private async doHandlePinVerify(ws: WebSocket, rawPin: string): Promise<void> {
    const storedHash = await this.state.storage.get<string>(PIN_HASH_KEY);
    if (!storedHash) {
      ws.close(1008, 'pin-locked');
      return;
    }

    const attempts = (await this.state.storage.get<number>(PIN_ATTEMPTS_KEY)) ?? 0;
    if (attempts <= 0) {
      ws.close(1008, 'pin-locked');
      return;
    }

    const sessionCode = this.state.id.name ?? '';
    const computed = await hashPin(rawPin, sessionCode);

    if (computed !== storedHash) {
      const remaining = attempts - 1;
      await this.state.storage.put(PIN_ATTEMPTS_KEY, remaining);
      if (remaining <= 0) {
        ws.send(JSON.stringify({ type: 'pin-locked' }));
        ws.close(1008, 'pin-locked');
      } else {
        ws.send(JSON.stringify({ type: 'pin-failed', attemptsLeft: remaining }));
      }
      return;
    }

    // PIN correct — mark verified in persistent storage, then flush buffered SDP/ICE.
    await this.state.storage.put(PIN_VERIFIED_KEY, true);
    await this.state.storage.deleteAlarm(); // cancel the unverified-viewer eviction timer
    ws.send(JSON.stringify({ type: 'pin-ok' }));
    await this.flushPendingToViewer();
  }

  private async flushPendingToViewer(): Promise<void> {
    const viewers = this.state.getWebSockets('viewer');
    if (viewers.length === 0) return;

    const count = (await this.state.storage.get<number>(PENDING_COUNT_KEY)) ?? 0;
    if (count === 0) return;

    // Load in insertion order (keys are 'pending:0', 'pending:1', ...).
    const entries = await this.state.storage.list<string>({ prefix: PENDING_PREFIX });
    const sortedKeys = [...entries.keys()].sort((a, b) => {
      return parseInt(a.slice(PENDING_PREFIX.length)) - parseInt(b.slice(PENDING_PREFIX.length));
    });

    for (const key of sortedKeys) {
      const msg = entries.get(key);
      if (msg !== undefined) {
        for (const viewer of viewers) {
          try { viewer.send(msg); } catch { /* viewer WS already closed */ }
        }
      }
    }

    // Clean up storage after flush.
    await this.state.storage.delete(PENDING_COUNT_KEY);
    await Promise.all(sortedKeys.map((k) => this.state.storage.delete(k)));
  }

  private currentRoles(): PeerRole[] {
    const roles: PeerRole[] = [];
    for (const ws of this.state.getWebSockets()) {
      const role = this.roleOf(ws);
      if (role !== null) {
        roles.push(role);
      }
    }
    return roles;
  }

  private roleOf(ws: WebSocket): PeerRole | null {
    const tags = this.state.getTags(ws);
    if (tags.includes('host')) {
      return 'host';
    }
    if (tags.includes('viewer')) {
      return 'viewer';
    }
    return null;
  }

  private async loadUsedCodes(): Promise<Set<string>> {
    const stored = await this.state.storage.list({ prefix: USED_PREFIX });
    const codes = new Set<string>();
    for (const key of stored.keys()) {
      codes.add(key.slice(USED_PREFIX.length));
    }
    return codes;
  }
}

/** Try to parse a JSON string as a control message (has `type` field, not `kind`). */
function tryParseControl(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed && !('kind' in parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}
