/**
 * Connection-outcome telemetry: pure payload validation and Analytics Engine
 * data-point shaping. No I/O, no Worker types — telemetry-route.ts is the
 * thin adapter that does the actual write.
 *
 * Schema (see signaling/wrangler.jsonc analytics_engine_datasets, dataset
 * `beam_connection_outcomes`, shared by both deployments so their writes
 * aggregate together):
 *   blob1:   outcome       — 'direct' | 'relay' | 'failed'
 *   blob2:   failureStage  — a ConnectionStage name, only meaningful when
 *                            outcome === 'failed'; 'none' otherwise. This is
 *                            the minimum diagnostic needed to distinguish
 *                            "never reached signaling" from "WebRTC
 *                            connected but the relay pipeline broke" (the
 *                            real bug class found by live testing earlier in
 *                            this project) without recording anything about
 *                            who the user was or what they were doing.
 *   double1: turnAvailable — 1 if a TURN relay was available for this
 *                            session, else 0. Answers "were failures mostly
 *                            no-TURN-configured, or TURN-available-anyway?"
 *   double2: count         — always 1; standard Analytics Engine convention
 *                            so SUM(double2) is a reliable request count
 *                            even under high-volume sampling.
 *   double3: durationMs    — wall-clock time from the viewer starting its
 *                            connection attempt to this session's terminal
 *                            point (success-then-close, or failure).
 *   double4: bytesSent     — see BYTE SEMANTICS below. 0 for a session that
 *                            never carried any traffic.
 *   double5: bytesReceived — see BYTE SEMANTICS below.
 *
 * BYTE SEMANTICS — read before querying double4/double5. The viewer sources
 * these from RTCIceCandidatePairStats (the WebRTC standard stats object for
 * the ICE pair that actually carried the session), NOT from counting HTTP
 * payload bytes at the Beam protocol layer. This is TRANSPORT-layer: it
 * includes DTLS record framing, SCTP framing, and ICE consent/keepalive
 * traffic, measured by the VIEWER at its own end of the connection. For a
 * 'relay' session this is what the viewer's browser sent/received to/from
 * the TURN server — one leg of the relay, from one peer's viewpoint. It does
 * NOT equal what a TURN provider bills: providers commonly meter BOTH relay
 * legs (client<->server and server<->peer), and the TURN protocol's own
 * framing (ChannelData headers, permission/allocation overhead) adds bytes
 * at the relay server that never appear in either endpoint's own
 * candidate-pair stats. Treat double4+double5 on relay sessions as a
 * same-order-of-magnitude, DIRECTIONAL estimate of provider-billed usage,
 * not a predicted bill — calibrate against the provider's own dashboard
 * once real data accumulates. See viewer/src/telemetry.ts's file doc for
 * the full reasoning, and LIMITATIONS.md for the accounting relationship.
 *
 * Deliberately absent, by construction — never parsed, never in the wire
 * shape at all: session codes, PINs, TURN credentials, request paths/URLs,
 * IP addresses, user agents, or any tunneled application content.
 */

/** Mirrors viewer/src/connection-report.ts's ConnectionStage set. Duplicated
 *  deliberately: independent packages, no cross-package imports (see
 *  CLAUDE.md) — this is the same convention already used for IceServerEntry
 *  and friends elsewhere in this codebase. */
export const FAILURE_STAGES = [
  'none',
  'signaling-connect',
  'pin-verify',
  'ice-config',
  'sdp-exchange',
  'ice-gathering',
  'ice-connect',
  'datachannel-open',
  'relay-ready',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const TELEMETRY_OUTCOMES = ['direct', 'relay', 'failed'] as const;
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];

export interface TelemetryPayload {
  readonly outcome: TelemetryOutcome;
  readonly failureStage: FailureStage;
  readonly turnAvailable: boolean;
  readonly durationMs: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

/** Sanity ceilings for a PUBLIC, unauthenticated endpoint — bound how much a
 *  single malformed or hostile data point can skew SUM()/AVG() aggregates.
 *  Generous relative to any real Beam session, not a real usage limit. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_BYTES = 1024 ** 4; // 1 TiB

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is TelemetryOutcome {
  return typeof value === 'string' && (TELEMETRY_OUTCOMES as readonly string[]).includes(value);
}

function isFailureStage(value: unknown): value is FailureStage {
  return typeof value === 'string' && (FAILURE_STAGES as readonly string[]).includes(value);
}

/** Clamps to [0, max]; anything else (missing, non-numeric, negative,
 *  NaN/Infinity, absurdly large) degrades to 0 rather than rejecting the
 *  payload — only `outcome` is load-bearing (see parseTelemetryPayload). */
function boundedNonNegative(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, max);
}

/**
 * Total: any input that isn't a well-formed telemetry payload yields null,
 * never a throw — this is untrusted, public-endpoint input. Every field
 * except `outcome` is optional on the wire and degrades to a safe default
 * when absent or malformed, rather than rejecting the whole payload.
 */
export function parseTelemetryPayload(raw: unknown): TelemetryPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  const outcome = raw['outcome'];
  if (!isOutcome(outcome)) {
    return null;
  }
  const rawStage = raw['failureStage'];
  const failureStage = isFailureStage(rawStage) ? rawStage : 'none';
  const turnAvailable = raw['turnAvailable'] === true;
  const durationMs = boundedNonNegative(raw['durationMs'], MAX_DURATION_MS);
  const bytesSent = boundedNonNegative(raw['bytesSent'], MAX_BYTES);
  const bytesReceived = boundedNonNegative(raw['bytesReceived'], MAX_BYTES);
  return { outcome, failureStage, turnAvailable, durationMs, bytesSent, bytesReceived };
}

export interface TelemetryDataPoint {
  readonly blobs: readonly string[];
  readonly doubles: readonly number[];
}

/** Pure shaping — see the schema doc at the top of this file. */
export function toDataPoint(payload: TelemetryPayload): TelemetryDataPoint {
  return {
    blobs: [payload.outcome, payload.failureStage],
    doubles: [payload.turnAvailable ? 1 : 0, 1, payload.durationMs, payload.bytesSent, payload.bytesReceived],
  };
}
