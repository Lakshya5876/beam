/**
 * The GET /ice-config handler, shared by both deployments that serve it: the
 * standalone signaling Worker (worker.ts) and the merged Pages worker
 * (viewer/_worker-src/entry.ts). Written once here so the two entries cannot
 * drift — a peer must get the same ICE configuration whichever origin it
 * reaches.
 *
 * The provider is built once per isolate and wrapped in the TTL cache, so a
 * burst of /ice-config requests costs at most one upstream mint.
 */

import { resolveIceConfig } from './ice-config.js';
import { createMeteredProvider } from './metered-turn.js';
import { CachingTurnProvider, type FetchLike, type TurnProvider } from './turn-provider.js';

export interface TurnEnv {
  ICE_SERVERS?: string;
  METERED_APP_NAME?: string;
  METERED_SECRET_KEY?: string;
  TURN_TTL_SECONDS?: string;
}

let cachedProvider: TurnProvider | null = null;
let cachedFor: string | null = null;

/**
 * Provider per isolate, rebuilt only if the configuration identity changes.
 * The identity deliberately excludes the secret's value — only whether one is
 * present — so the secret is never used as a map key or otherwise retained
 * beyond the provider that needs it.
 */
function providerFor(env: TurnEnv, fetchImpl: FetchLike): TurnProvider | null {
  const identity = `${env.METERED_APP_NAME ?? ''}|${env.METERED_SECRET_KEY ? 'set' : 'unset'}|${env.TURN_TTL_SECONDS ?? ''}`;
  if (cachedFor !== identity) {
    const created = createMeteredProvider(env, fetchImpl);
    cachedProvider = created ? new CachingTurnProvider(created) : null;
    cachedFor = identity;
  }
  return cachedProvider;
}

/**
 * Build the /ice-config Response.
 *
 * CORS is open because the viewer is served from a different origin than the
 * standalone signaling Worker, and the body is public by design (see
 * ice-config.ts). `no-store` matters: the credentials expire, so a cached
 * copy would eventually hand a peer dead TURN servers.
 *
 * `x-beam-turn` is a diagnostic the host and viewer surface when a connection
 * fails, so "TURN was never configured" is distinguishable from "TURN was
 * configured but the provider was down" without reading Worker logs. It
 * reports only Beam's own typed failure tag, never provider detail.
 */
export async function handleIceConfig(env: TurnEnv, fetchImpl: FetchLike, nowMs: number): Promise<Response> {
  const result = await resolveIceConfig(env.ICE_SERVERS, providerFor(env, fetchImpl), nowMs);
  return new Response(result.body, {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      // Without this the viewer cannot READ x-beam-turn when signaling is on
      // a different origin than the page: cross-origin JS only sees the
      // CORS-safelisted response headers unless they are explicitly exposed.
      // (The merged single-origin deployment is unaffected; the standalone
      // signaling Worker is still a supported topology.)
      'access-control-expose-headers': 'x-beam-turn',
      'cache-control': 'no-store',
      'x-beam-turn': result.turnFailure ?? (result.hasTurn ? 'available' : 'not-configured'),
    },
  });
}

/** Test seam: drop the per-isolate provider cache. */
export function resetProviderCache(): void {
  cachedProvider = null;
  cachedFor = null;
}
