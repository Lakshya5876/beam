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

export class SessionDurableObject {
  private readonly mintLimiter = new RateLimiter({ maxPerWindow: 30, windowMs: 60_000 });

  constructor(private readonly state: DurableObjectState) {}

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
    return new Response(null, { status: 101, webSocket: client });
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

  private async relayMessage(senderRole: PeerRole, message: string | ArrayBuffer): Promise<void> {
    const targets = this.state.getWebSockets(relayTargetRole(senderRole));
    const pinVerified = (await this.state.storage.get<boolean>(PIN_VERIFIED_KEY)) === true;

    if (targets.length === 0 || (senderRole === 'host' && !pinVerified)) {
      if (senderRole === 'host' && typeof message === 'string') {
        // Persist to storage — in-memory state does not survive DO hibernation.
        const count = (await this.state.storage.get<number>(PENDING_COUNT_KEY)) ?? 0;
        await this.state.storage.put(`${PENDING_PREFIX}${count}`, message);
        await this.state.storage.put(PENDING_COUNT_KEY, count + 1);
      }
      return;
    }
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
    await this.state.storage.put(PIN_ATTEMPTS_KEY, PIN_MAX_ATTEMPTS);
  }

  private async handlePinVerify(ws: WebSocket, rawPin: string): Promise<void> {
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
