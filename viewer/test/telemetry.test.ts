import { describe, expect, it } from 'vitest';
import {
  buildTelemetryPayload,
  extractTransportUsage,
  outcomeForSelectedPath,
  telemetryUrlFor,
  OutcomeReporter,
  type CandidatePairStatsLike,
  type SessionUsage,
  type TelemetryOutcome,
  type TelemetryPayload,
} from '../src/telemetry.js';
import type { ConnectionFacts } from '../src/connection-report.js';

function facts(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    reachedStage: null,
    turnAvailable: false,
    turnDiagnostic: null,
    selectedPath: 'unknown',
    relayOnlyRequested: false,
    ...overrides,
  };
}

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return { durationMs: 0, bytesSent: 0, bytesReceived: 0, ...overrides };
}

/** Mirrors bootstrap.ts's real call pattern (claim() synchronously, then
 *  report() only if claimed) — see OutcomeReporter's class doc for why the
 *  two are split instead of one reportOnce()-style method. */
function reportIfClaimed(
  reporter: OutcomeReporter,
  outcome: TelemetryOutcome,
  f: ConnectionFacts,
  u: SessionUsage,
): boolean {
  if (!reporter.claim()) {
    return false;
  }
  reporter.report(outcome, f, u);
  return true;
}

describe('telemetryUrlFor', () => {
  it('maps ws/wss to http/https on the same origin', () => {
    expect(telemetryUrlFor('ws://localhost:8081')).toBe('http://localhost:8081/telemetry');
    expect(telemetryUrlFor('wss://beam-viewer.pages.dev')).toBe('https://beam-viewer.pages.dev/telemetry');
  });

  it('drops a session-code path — the endpoint lives at the origin root', () => {
    expect(telemetryUrlFor('wss://beam-viewer.pages.dev/k7x2m9q4w8r3t6y1u5z0a2b4c7')).toBe(
      'https://beam-viewer.pages.dev/telemetry',
    );
  });
});

describe('outcomeForSelectedPath', () => {
  it('reports direct and relay as-is', () => {
    expect(outcomeForSelectedPath('direct')).toBe('direct');
    expect(outcomeForSelectedPath('relay')).toBe('relay');
  });

  it('is deliberately not reportable for an unknown path', () => {
    expect(outcomeForSelectedPath('unknown')).toBeNull();
  });
});

describe('buildTelemetryPayload', () => {
  it('carries usage through for a direct outcome, with no failure stage', () => {
    expect(
      buildTelemetryPayload(
        'direct',
        facts({ turnAvailable: true, reachedStage: 'relay-ready' }),
        usage({ durationMs: 45_000, bytesSent: 12_000, bytesReceived: 340_000 }),
      ),
    ).toEqual({
      outcome: 'direct',
      failureStage: 'none',
      turnAvailable: true,
      durationMs: 45_000,
      bytesSent: 12_000,
      bytesReceived: 340_000,
    });
  });

  it('carries usage through for a relay outcome, with no failure stage', () => {
    expect(
      buildTelemetryPayload(
        'relay',
        facts({ turnAvailable: true, reachedStage: 'relay-ready' }),
        usage({ durationMs: 90_000, bytesSent: 5_000_000, bytesReceived: 8_000_000 }),
      ),
    ).toEqual({
      outcome: 'relay',
      failureStage: 'none',
      turnAvailable: true,
      durationMs: 90_000,
      bytesSent: 5_000_000,
      bytesReceived: 8_000_000,
    });
  });

  it('includes the reached stage for a failed outcome, and whatever usage accumulated before failing', () => {
    expect(
      buildTelemetryPayload(
        'failed',
        facts({ reachedStage: 'ice-gathering', turnAvailable: false }),
        usage({ durationMs: 12_000 }),
      ),
    ).toEqual({
      outcome: 'failed',
      failureStage: 'ice-gathering',
      turnAvailable: false,
      durationMs: 12_000,
      bytesSent: 0,
      bytesReceived: 0,
    });
  });

  it('reports failureStage "none" for a failed outcome that never reached any stage', () => {
    expect(buildTelemetryPayload('failed', facts({ reachedStage: null }), usage())).toMatchObject({
      outcome: 'failed',
      failureStage: 'none',
    });
  });

  it('never includes anything beyond the six known fields', () => {
    const payload = buildTelemetryPayload(
      'failed',
      facts({ reachedStage: 'pin-verify', relayOnlyRequested: true }),
      usage({ durationMs: 500 }),
    );
    expect(Object.keys(payload).sort()).toEqual(
      ['bytesReceived', 'bytesSent', 'durationMs', 'failureStage', 'outcome', 'turnAvailable'].sort(),
    );
  });
});

describe('extractTransportUsage — byte-count collection', () => {
  it('reads bytesSent/bytesReceived from the succeeded candidate pair', () => {
    const entries: CandidatePairStatsLike[] = [
      { type: 'candidate-pair', state: 'failed', bytesSent: 999, bytesReceived: 999 },
      { type: 'candidate-pair', state: 'succeeded', bytesSent: 12_345, bytesReceived: 67_890 },
      { type: 'local-candidate' },
    ];
    expect(extractTransportUsage(entries)).toEqual({ bytesSent: 12_345, bytesReceived: 67_890 });
  });

  it('picks the FIRST succeeded pair when more than one is present', () => {
    const entries: CandidatePairStatsLike[] = [
      { type: 'candidate-pair', state: 'succeeded', bytesSent: 1, bytesReceived: 2 },
      { type: 'candidate-pair', state: 'succeeded', bytesSent: 999, bytesReceived: 999 },
    ];
    expect(extractTransportUsage(entries)).toEqual({ bytesSent: 1, bytesReceived: 2 });
  });
});

describe('extractTransportUsage — unavailable / malformed / unexpected stats', () => {
  it('degrades to zero when there is no succeeded candidate pair at all', () => {
    expect(extractTransportUsage([])).toEqual({ bytesSent: 0, bytesReceived: 0 });
    expect(extractTransportUsage([{ type: 'candidate-pair', state: 'failed', bytesSent: 5 }])).toEqual({
      bytesSent: 0,
      bytesReceived: 0,
    });
  });

  it('degrades a missing bytesSent/bytesReceived field to 0 rather than throwing', () => {
    expect(extractTransportUsage([{ type: 'candidate-pair', state: 'succeeded' }])).toEqual({
      bytesSent: 0,
      bytesReceived: 0,
    });
  });

  it('degrades a non-numeric bytesSent/bytesReceived to 0 (a browser reporting stats differently than expected)', () => {
    expect(
      extractTransportUsage([
        { type: 'candidate-pair', state: 'succeeded', bytesSent: 'a lot', bytesReceived: null },
      ]),
    ).toEqual({ bytesSent: 0, bytesReceived: 0 });
  });

  it('degrades NaN/Infinity to 0', () => {
    expect(
      extractTransportUsage([
        { type: 'candidate-pair', state: 'succeeded', bytesSent: Number.NaN, bytesReceived: Number.POSITIVE_INFINITY },
      ]),
    ).toEqual({ bytesSent: 0, bytesReceived: 0 });
  });

  it('degrades a negative value to 0 (a malformed/hostile stats object should not report negative usage)', () => {
    expect(
      extractTransportUsage([{ type: 'candidate-pair', state: 'succeeded', bytesSent: -500, bytesReceived: 10 }]),
    ).toEqual({ bytesSent: 0, bytesReceived: 10 });
  });

  it('accepts zero as a legitimate value (a session that opened but transferred nothing yet)', () => {
    expect(
      extractTransportUsage([{ type: 'candidate-pair', state: 'succeeded', bytesSent: 0, bytesReceived: 0 }]),
    ).toEqual({ bytesSent: 0, bytesReceived: 0 });
  });
});

describe('OutcomeReporter — duplicate suppression', () => {
  it('sends on the first call', () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    const result = reportIfClaimed(reporter, 'direct', facts({ turnAvailable: true }), usage({ durationMs: 1000 }));

    expect(result).toBe(true);
    expect(sent).toEqual([
      { outcome: 'direct', failureStage: 'none', turnAvailable: true, durationMs: 1000, bytesSent: 0, bytesReceived: 0 },
    ]);
    expect(reporter.hasSent()).toBe(true);
  });

  it('is a no-op on every subsequent call, regardless of what outcome or usage is passed', () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    reportIfClaimed(reporter, 'direct', facts(), usage());
    const second = reportIfClaimed(reporter, 'failed', facts({ reachedStage: 'ice-connect' }), usage({ durationMs: 99 }));
    const third = reportIfClaimed(reporter, 'relay', facts(), usage({ bytesSent: 1_000_000 }));

    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.outcome).toBe('direct');
  });

  it('suppresses duplicates across the two independent session-end signals: onconnectionstate(\'failed\') firing after a successful connection, and the transport\'s own onclose', () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    reportIfClaimed(reporter, 'relay', facts({ reachedStage: 'relay-ready' }), usage({ durationMs: 5000, bytesSent: 100 }));
    reportIfClaimed(reporter, 'relay', facts({ reachedStage: 'relay-ready' }), usage({ durationMs: 5010, bytesSent: 120 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.bytesSent).toBe(100); // the FIRST snapshot wins, not the more "final" one
  });

  it('each OutcomeReporter instance tracks its own dedup state independently', () => {
    const sentA: TelemetryPayload[] = [];
    const sentB: TelemetryPayload[] = [];
    const a = new OutcomeReporter((p) => sentA.push(p));
    const b = new OutcomeReporter((p) => sentB.push(p));

    reportIfClaimed(a, 'direct', facts(), usage());
    reportIfClaimed(b, 'relay', facts(), usage());

    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);
  });

  it('claim() is synchronous, so two concurrent async finalizers cannot both pass it — the exact race that produced two beacons for one session before claim()/report() were split', async () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    // Mirrors bootstrap.ts's finalizeOutcome: claim() happens BEFORE the
    // async getStats() read. Two "concurrent" finalizers both start their
    // async work, but only the one that calls claim() first (synchronously,
    // in call order) may proceed to report().
    async function finalize(outcome: TelemetryOutcome, delayMs: number): Promise<void> {
      if (!reporter.claim()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      reporter.report(outcome, facts(), usage({ bytesSent: delayMs }));
    }

    // The second call's claim() happens synchronously right after the
    // first's, well before either's async delay resolves — simulating
    // onTerminalFailure and onclose firing moments apart.
    const first = finalize('relay', 20);
    const second = finalize('failed', 5);
    await Promise.all([first, second]);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.outcome).toBe('relay'); // the first claimant, not whichever resolves first
  });
});

describe('OutcomeReporter — send contract', () => {
  it('propagates a send failure only if send itself throws (the real wiring never lets that happen)', () => {
    // Documents the contract boundary: OutcomeReporter does not itself
    // swallow exceptions from `send` — bootstrap.ts's real `send` is
    // responsible for never throwing (fetch(...).catch(() => {})).
    const reporter = new OutcomeReporter(() => {
      throw new Error('a misbehaving send implementation');
    });
    expect(() => reportIfClaimed(reporter, 'direct', facts(), usage())).toThrow('a misbehaving send implementation');
  });
});

describe('outcome type coverage', () => {
  it('the three outcomes all shape correctly end to end, including usage', () => {
    for (const outcome of ['direct', 'relay', 'failed'] as const satisfies readonly TelemetryOutcome[]) {
      const sent: TelemetryPayload[] = [];
      reportIfClaimed(
        new OutcomeReporter((p) => sent.push(p)),
        outcome,
        facts({ reachedStage: 'sdp-exchange' }),
        usage({ durationMs: 250, bytesSent: 10, bytesReceived: 20 }),
      );
      expect(sent[0]?.outcome).toBe(outcome);
      expect(sent[0]?.durationMs).toBe(250);
    }
  });
});
