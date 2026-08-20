/**
 * The POST /telemetry handler, shared by both deployments that serve it: the
 * standalone signaling Worker (worker.ts) and the merged Pages worker
 * (viewer/_worker-src/entry.ts) — same pattern as ice-config-route.ts, so the
 * two entries cannot drift.
 *
 * Records ONLY what telemetry.ts's schema defines and documents in full
 * (outcome, failure stage, TURN availability, session duration, and
 * transport-layer bytes sent/received — see that file for exactly what the
 * byte fields do and do not measure). This handler never reads any other
 * field from the request body (parseTelemetryPayload only recognizes the
 * known ones, everything else is silently ignored), never reads request
 * headers beyond what's needed to parse JSON, and never logs the body.
 *
 * Best-effort by design, matching the viewer's own fire-and-forget beacon:
 * a malformed body is rejected (400) without writing anything; a write
 * failure (missing binding, Analytics Engine outage) is caught and
 * swallowed — this endpoint must never surface an error the client would
 * need to handle, since the client never inspects the response anyway.
 *
 * Rate limiting (SECURITY_AUDIT_20-08.md finding #6): this is a public,
 * unauthenticated POST endpoint like /new, but — unlike /new — it used to
 * carry no rate limit of its own, letting anyone sustain writes cheaply
 * enough to materially pollute the beam_connection_outcomes aggregates (or,
 * on a metered Analytics Engine plan, run up write costs) with garbage data
 * points. Reuses the exact same per-IP RateLimiter class /new's mint
 * endpoint already uses (rate-limit.ts), scoped per-Worker-isolate the same
 * way ice-config-route.ts's TURN provider cache is — best-effort, resets on
 * isolate recycle, same accepted limitation already documented for the mint
 * limiter (LIMITATIONS.md "Per-IP mint rate limiter resets on hibernation").
 */

import { parseTelemetryPayload, toDataPoint } from './telemetry.js';
import { RateLimiter } from './rate-limit.js';

/**
 * Structural subset of Cloudflare's ambient AnalyticsEngineDataset/
 * AnalyticsEngineDataPoint — declared locally (same pattern as
 * turn-provider.ts's FetchLike) rather than depending on the Workers-only
 * ambient globals from worker-configuration.d.ts. Those globals are absent
 * under this package's Node-typed tsconfig (the one that checks test/), and
 * this module's own tests need to construct data points too. The real
 * Cloudflare binding satisfies this shape structurally.
 */
export interface AnalyticsDataPointLike {
  readonly blobs?: readonly string[];
  readonly doubles?: readonly number[];
  readonly indexes?: readonly string[];
}

export interface AnalyticsDatasetLike {
  writeDataPoint(point: AnalyticsDataPointLike): void;
}

export interface TelemetryEnv {
  ANALYTICS?: AnalyticsDatasetLike;
  /** Telemetry beacons allowed per IP per minute (default 60 — generous:
   *  a real session sends at most one). Deploy-time policy knob, same
   *  convention as SessionPolicyEnv.MINT_MAX_PER_MINUTE. */
  TELEMETRY_MAX_PER_MINUTE?: string;
}

/** Generous for a 3-field JSON object; guards a public endpoint against
 *  being used to smuggle or exhaust resources on an oversized body. */
const MAX_BODY_BYTES = 4096;

const NO_CONTENT = (): Response => new Response(null, { status: 204 });
const BAD_REQUEST = (): Response => new Response(null, { status: 400 });
const RATE_LIMITED = (): Response => new Response(null, { status: 429 });

function policyInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Per-isolate limiter state — rebuilt only if the configured window size
// changes (never happens in production; matters only across tests, which
// construct differently-configured envs). resetTelemetryRateLimiter() below
// is the test seam, mirroring ice-config-route.ts's resetProviderCache().
let limiter: RateLimiter | null = null;
let limiterMaxPerWindow: number | null = null;

function limiterFor(env: TelemetryEnv): RateLimiter {
  const maxPerWindow = policyInt(env.TELEMETRY_MAX_PER_MINUTE, 60);
  if (!limiter || limiterMaxPerWindow !== maxPerWindow) {
    limiter = new RateLimiter({ maxPerWindow, windowMs: 60_000 });
    limiterMaxPerWindow = maxPerWindow;
  }
  return limiter;
}

/** Test seam: drop the per-isolate limiter so counts from one test don't
 *  bleed into the next (mirrors ice-config-route.ts's resetProviderCache). */
export function resetTelemetryRateLimiter(): void {
  limiter = null;
  limiterMaxPerWindow = null;
}

export async function handleTelemetry(request: Request, env: TelemetryEnv): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!limiterFor(env).check(ip, Date.now())) {
    return RATE_LIMITED();
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return BAD_REQUEST();
  }
  if (text.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return BAD_REQUEST();
  }
  const payload = parseTelemetryPayload(raw);
  if (!payload) {
    return BAD_REQUEST();
  }
  try {
    env.ANALYTICS?.writeDataPoint(toDataPoint(payload));
  } catch {
    // Never surface a write failure to the client — see file doc. A missing
    // binding, a misconfigured dataset, or an Analytics Engine outage must
    // not turn into a client-visible error for an endpoint the client
    // already never waits on.
  }
  return NO_CONTENT();
}
