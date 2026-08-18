/**
 * Best-effort connection-outcome reporting: at most one beacon per session,
 * fire-and-forget, never affects the Beam connection or user experience.
 *
 * Reports ONLY: which terminal outcome the session reached (direct/relay/
 * failed), the failure stage when outcome==='failed' (see connection-
 * report.ts's ConnectionStage — the minimum needed to distinguish "never
 * reached signaling" from "WebRTC connected but the relay pipeline broke"),
 * and whether TURN was available for this session. Never the session code,
 * PIN, TURN credentials, request paths, or anything the tunneled app sent —
 * none of that is in scope here at all, by construction: ConnectionFacts
 * (see connection-report.ts) carries none of it either, so there is nothing
 * to accidentally include.
 *
 * Pure logic (URL derivation, payload shape, dedup) is separated from the
 * one real I/O call (the POST itself) so the former is unit-testable
 * without a network stack — bootstrap.ts wires the real fetch.
 */

import type { ConnectionFacts, SelectedPath } from './connection-report.js';

export type TelemetryOutcome = 'direct' | 'relay' | 'failed';

export interface TelemetryPayload {
  readonly outcome: TelemetryOutcome;
  readonly failureStage: string;
  readonly turnAvailable: boolean;
}

/** Same-origin /telemetry URL, derived the same way bootstrap.ts's
 *  fetchIceServers derives /ice-config's — signaling and the beacon target
 *  are always the same host. */
export function telemetryUrlFor(signalingBaseUrl: string): string {
  const httpBase = signalingBaseUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
  return new URL('/telemetry', httpBase).href;
}

/**
 * Map a resolved ICE path to a reportable outcome. 'unknown' is deliberately
 * NOT reportable — getStats() failing to identify a candidate pair is rare
 * and better omitted than recorded as a guess that would skew the
 * direct/relay ratio.
 */
export function outcomeForSelectedPath(path: SelectedPath): TelemetryOutcome | null {
  return path === 'direct' || path === 'relay' ? path : null;
}

export function buildTelemetryPayload(outcome: TelemetryOutcome, facts: ConnectionFacts): TelemetryPayload {
  return {
    outcome,
    failureStage: outcome === 'failed' ? (facts.reachedStage ?? 'none') : 'none',
    turnAvailable: facts.turnAvailable,
  };
}

/**
 * Sends at most once per instance — every call after the first is a no-op.
 * `send` is expected to never throw (bootstrap.ts's real implementation
 * wraps the fetch in .catch(() => {})); this class does not itself add a
 * try/catch, so that contract belongs to whoever constructs it.
 */
export class OutcomeReporter {
  private sent = false;

  constructor(private readonly send: (payload: TelemetryPayload) => void) {}

  /** Returns true if this call actually sent a beacon (false if a beacon was
   *  already sent for this instance, or the outcome has nothing reportable —
   *  see outcomeForSelectedPath). */
  reportOnce(outcome: TelemetryOutcome, facts: ConnectionFacts): boolean {
    if (this.sent) {
      return false;
    }
    this.sent = true;
    this.send(buildTelemetryPayload(outcome, facts));
    return true;
  }

  /** For tests/diagnostics only — never gates production behavior. */
  hasSent(): boolean {
    return this.sent;
  }
}
