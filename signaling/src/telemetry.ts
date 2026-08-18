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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is TelemetryOutcome {
  return typeof value === 'string' && (TELEMETRY_OUTCOMES as readonly string[]).includes(value);
}

function isFailureStage(value: unknown): value is FailureStage {
  return typeof value === 'string' && (FAILURE_STAGES as readonly string[]).includes(value);
}

/**
 * Total: any input that isn't a well-formed telemetry payload yields null,
 * never a throw — this is untrusted, public-endpoint input. `failureStage`
 * and `turnAvailable` are optional on the wire and default to 'none'/false
 * when absent or malformed, rather than rejecting the whole payload — only
 * `outcome` is load-bearing.
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
  return { outcome, failureStage, turnAvailable };
}

export interface TelemetryDataPoint {
  readonly blobs: readonly string[];
  readonly doubles: readonly number[];
}

/** Pure shaping — see the schema doc at the top of this file. */
export function toDataPoint(payload: TelemetryPayload): TelemetryDataPoint {
  return {
    blobs: [payload.outcome, payload.failureStage],
    doubles: [payload.turnAvailable ? 1 : 0, 1],
  };
}
