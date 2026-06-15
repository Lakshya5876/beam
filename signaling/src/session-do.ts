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
 * Runtime-bound; the live pairing/relay/hibernation path is verified at S18.
 */

import { assignRole, relayTargetRole, type PeerRole } from './pairing.js';
import { isWithinSizeCap } from './message-size.js';
import { mintUnusedCode } from './session-code.js';
import { StorageUsedTokenStore } from './used-token-store.js';
import { RateLimiter } from './rate-limit.js';

const USED_PREFIX = 'used:';

export class SessionDurableObject {
  // Per-IP mint rate limit; in-memory on the registry instance (blunts spam
  // per design §A.2.4). Resets if the registry hibernates — acceptable for
  // spam-blunting; the CSPRNG + used-token guard remain authoritative.
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
    // Role tag survives hibernation; the relay derives pairing from tags.
    this.state.acceptWebSocket(server, [assignment.role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (!isWithinSizeCap(size)) {
      ws.close(1009, 'message-too-large');
      return;
    }
    const senderRole = this.roleOf(ws);
    if (senderRole === null) {
      return;
    }
    const targetRole = relayTargetRole(senderRole);
    for (const peer of this.state.getWebSockets(targetRole)) {
      // OPAQUE relay: the message is forwarded verbatim. It is never parsed,
      // inspected, decoded, or stored — there is no payload code path.
      peer.send(message);
    }
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
