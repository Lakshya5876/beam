/**
 * Best-effort connection-outcome reporting: at most one beacon per session,
 * fire-and-forget, never affects the Beam connection or user experience.
 *
 * Reports ONLY: which terminal outcome the session reached (direct/relay/
 * failed), the failure stage when outcome==='failed' (see connection-
 * report.ts's ConnectionStage — the minimum needed to distinguish "never
 * reached signaling" from "WebRTC connected but the relay pipeline broke"),
 * whether TURN was available, session duration, and total bytes sent/
 * received. Never the session code, PIN, TURN credentials, request paths, or
 * anything the tunneled app sent — none of that is in scope here at all, by
 * construction: neither ConnectionFacts (connection-report.ts) nor
 * SessionUsage (below) carries any of it, so there is nothing to
 * accidentally include.
 *
 * BYTE SEMANTICS — read before interpreting the numbers this produces:
 * bytesSent/bytesReceived come from RTCIceCandidatePairStats (the WebRTC
 * standard stats object for the ICE pair actually carrying traffic), NOT
 * from counting HTTP payload bytes at the Beam protocol layer. This is
 * TRANSPORT-layer: it includes DTLS record framing, SCTP framing, and ICE
 * consent/keepalive traffic on that pair, and is measured LOCALLY by this
 * browser at ITS OWN end of the connection. For a 'relay' session this is
 * what THIS browser sent/received to/from the TURN server — one leg of the
 * relay, from one peer's viewpoint. It does NOT equal what a TURN provider
 * bills: providers commonly meter both relay legs (client<->server AND
 * server<->peer) and the TURN protocol's own framing (ChannelData headers,
 * permission/allocation overhead) adds bytes at the relay server that never
 * appear in either endpoint's own candidate-pair stats. Treat this as a
 * same-order-of-magnitude, DIRECTIONAL estimate for relay sessions, not a
 * predicted bill — calibrate against the provider's own dashboard once
 * real data accumulates, and see LIMITATIONS.md for the fuller accounting.
 *
 * Pure logic (URL derivation, payload shape, dedup, stats extraction) is
 * separated from the two real I/O calls (getStats(), the POST itself) so
 * the former is unit-testable without a browser runtime — bootstrap.ts
 * wires both.
 */

import type { ConnectionFacts, SelectedPath } from './connection-report.js';

export type TelemetryOutcome = 'direct' | 'relay' | 'failed';

/** Measured once, at session end — see class/file doc for why timing matters
 *  (duration/bytes are ~0 if measured at connect time instead). */
export interface SessionUsage {
  readonly durationMs: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface TelemetryPayload {
  readonly outcome: TelemetryOutcome;
  readonly failureStage: string;
  readonly turnAvailable: boolean;
  readonly durationMs: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
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

export function buildTelemetryPayload(
  outcome: TelemetryOutcome,
  facts: ConnectionFacts,
  usage: SessionUsage,
): TelemetryPayload {
  return {
    outcome,
    failureStage: outcome === 'failed' ? (facts.reachedStage ?? 'none') : 'none',
    turnAvailable: facts.turnAvailable,
    durationMs: usage.durationMs,
    bytesSent: usage.bytesSent,
    bytesReceived: usage.bytesReceived,
  };
}

/**
 * Sends at most once per instance. claim()/report() are deliberately split
 * in two: bootstrap.ts's finalizer does async work (getStats()) between
 * deciding to report and actually sending, and more than one terminal event
 * (onTerminalFailure, onclose) can each independently decide to finalize.
 * If the dedup check lived only at send time (as a single reportOnce()
 * would), two concurrent finalizers could both pass the check during their
 * respective async gaps and both send — confirmed live: this exact race
 * produced two beacons for one session before this split existed. claim()
 * is synchronous, so only the first caller (in call order, before any
 * `await`) ever gets true.
 */
export class OutcomeReporter {
  private sent = false;

  constructor(private readonly send: (payload: TelemetryPayload) => void) {}

  /** Synchronously claims the one-shot report slot. Call this BEFORE any
   *  async work — a caller that gets false must not proceed to send. */
  claim(): boolean {
    if (this.sent) {
      return false;
    }
    this.sent = true;
    return true;
  }

  /** Sends the beacon. Callers must have already received true from claim();
   *  this method does not itself guard against duplicate sends. */
  report(outcome: TelemetryOutcome, facts: ConnectionFacts, usage: SessionUsage): void {
    this.send(buildTelemetryPayload(outcome, facts, usage));
  }

  /** For tests/diagnostics only — never gates production behavior. */
  hasSent(): boolean {
    return this.sent;
  }
}

/** The subset of RTCStats (candidate-pair variant) this module reads —
 *  declared structurally so the extraction logic is testable without a real
 *  RTCStatsReport, matching bootstrap.ts's existing readSelectedPath. */
export interface CandidatePairStatsLike {
  readonly type?: string;
  readonly state?: string;
  readonly bytesSent?: unknown;
  readonly bytesReceived?: unknown;
}

function nonNegativeFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Pure: given an RTCStatsReport's entries (as a plain iterable — bootstrap.ts
 * adapts the real report's .forEach into this shape), find the succeeded
 * candidate pair and extract its byte counts. Total — no succeeded pair, a
 * non-numeric/negative/missing field, or an empty report all degrade to
 * {bytesSent: 0, bytesReceived: 0} rather than throwing. Diagnostics (and
 * now telemetry) must never break a working connection over a stats read.
 */
export function extractTransportUsage(
  entries: Iterable<CandidatePairStatsLike>,
): { bytesSent: number; bytesReceived: number } {
  for (const entry of entries) {
    if (entry.type !== 'candidate-pair' || entry.state !== 'succeeded') {
      continue;
    }
    return {
      bytesSent: nonNegativeFiniteNumber(entry.bytesSent),
      bytesReceived: nonNegativeFiniteNumber(entry.bytesReceived),
    };
  }
  return { bytesSent: 0, bytesReceived: 0 };
}
