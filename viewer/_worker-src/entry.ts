/**
 * Merged Pages Advanced-Mode worker: serves the static viewer bundle AND the
 * signaling logic (mint / ice-config / DO pairing) from the SAME origin —
 * built to sidestep a network path that allows plain HTTPS to *.pages.dev
 * but appears to interfere with the WebSocket upgrade to a separate
 * *.workers.dev origin. Reuses signaling/src/* unchanged (imported directly,
 * not duplicated) — this file is only the routing glue + the Pages ASSETS
 * fallback that a standalone Worker doesn't need.
 */
import { routeRequest } from '../../signaling/src/router.js';
import { handleIceConfig, type TurnEnv } from '../../signaling/src/ice-config-route.js';
import { handleTelemetry, type TelemetryEnv } from '../../signaling/src/telemetry-route.js';
import type { SessionPolicyEnv } from '../../signaling/src/session-do.js';

export { SessionDurableObject } from '../../signaling/src/session-do.js';

interface Env extends SessionPolicyEnv, TurnEnv, TelemetryEnv {
  SESSIONS: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const REGISTRY_NAME = 'registry';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const decision = routeRequest(request.method, request.url, isUpgrade);
    if (decision.kind === 'reject') {
      // Not a signaling-shaped request (mint/ice-config/WS-upgrade path) —
      // fall through to the static viewer bundle instead of erroring.
      return env.ASSETS.fetch(request);
    }
    if (decision.kind === 'ice-config') {
      // Same handler the standalone signaling Worker uses — both peers must
      // receive identical ICE configuration (ice-config-route.ts).
      return handleIceConfig(env, fetch, Date.now());
    }
    if (decision.kind === 'telemetry') {
      return handleTelemetry(request, env);
    }
    const name = decision.kind === 'mint' ? REGISTRY_NAME : decision.code;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(name));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
