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
 */

import { parseTelemetryPayload, toDataPoint } from './telemetry.js';

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
}

/** Generous for a 3-field JSON object; guards a public endpoint against
 *  being used to smuggle or exhaust resources on an oversized body. */
const MAX_BODY_BYTES = 4096;

const NO_CONTENT = (): Response => new Response(null, { status: 204 });
const BAD_REQUEST = (): Response => new Response(null, { status: 400 });

export async function handleTelemetry(request: Request, env: TelemetryEnv): Promise<Response> {
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
