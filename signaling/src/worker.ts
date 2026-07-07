/**
 * Signaling Worker entry (design §10 S14). Thin adapter: it makes the pure
 * routing decision (router.ts) and forwards to the Durable Object — mint
 * requests to the single registry instance, WS upgrades to the per-code
 * session instance. All stateful work (mint + used-token guard, pairing,
 * opaque relay, size cap, rate limit) lives in the DO (session-do.ts).
 *
 * Runtime-bound; verified end-to-end at S18 on a real Worker.
 */

import { routeRequest } from './router.js';
import { iceConfigBody } from './ice-config.js';
import type { SessionPolicyEnv } from './session-do.js';

// The DO class must be exported from the Worker entrypoint (Cloudflare binds
// it by class name from wrangler.jsonc).
export { SessionDurableObject } from './session-do.js';

export interface Env extends SessionPolicyEnv {
  SESSIONS: DurableObjectNamespace;
  /** Optional JSON array of RTCIceServer objects (see ice-config.ts). */
  ICE_SERVERS?: string;
}

// The single registry instance that mints codes and holds the used-token set.
const REGISTRY_NAME = 'registry';

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const decision = routeRequest(request.method, request.url, isUpgrade);
    if (decision.kind === 'reject') {
      return new Response(decision.reason, { status: decision.status });
    }
    if (decision.kind === 'ice-config') {
      // Public, non-sensitive by policy (ice-config.ts); CORS-open so the
      // Pages-origin viewer can fetch it.
      return new Response(iceConfigBody(env.ICE_SERVERS), {
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    }
    const name = decision.kind === 'mint' ? REGISTRY_NAME : decision.code;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(name));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
