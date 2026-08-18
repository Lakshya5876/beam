import { describe, expect, it } from 'vitest';
import {
  buildTelemetryPayload,
  outcomeForSelectedPath,
  telemetryUrlFor,
  OutcomeReporter,
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
  it('carries turnAvailable through for a direct outcome, with no failure stage', () => {
    expect(buildTelemetryPayload('direct', facts({ turnAvailable: true, reachedStage: 'relay-ready' }))).toEqual({
      outcome: 'direct',
      failureStage: 'none',
      turnAvailable: true,
    });
  });

  it('carries turnAvailable through for a relay outcome, with no failure stage', () => {
    expect(buildTelemetryPayload('relay', facts({ turnAvailable: true, reachedStage: 'relay-ready' }))).toEqual({
      outcome: 'relay',
      failureStage: 'none',
      turnAvailable: true,
    });
  });

  it('includes the reached stage for a failed outcome', () => {
    expect(buildTelemetryPayload('failed', facts({ reachedStage: 'ice-gathering', turnAvailable: false }))).toEqual({
      outcome: 'failed',
      failureStage: 'ice-gathering',
      turnAvailable: false,
    });
  });

  it('reports failureStage "none" for a failed outcome that never reached any stage', () => {
    expect(buildTelemetryPayload('failed', facts({ reachedStage: null }))).toEqual({
      outcome: 'failed',
      failureStage: 'none',
      turnAvailable: false,
    });
  });

  it('never includes anything beyond outcome/failureStage/turnAvailable', () => {
    const payload = buildTelemetryPayload('failed', facts({ reachedStage: 'pin-verify', relayOnlyRequested: true }));
    expect(Object.keys(payload).sort()).toEqual(['failureStage', 'outcome', 'turnAvailable']);
  });
});

describe('OutcomeReporter — duplicate suppression', () => {
  it('sends on the first call', () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    const result = reporter.reportOnce('direct', facts({ turnAvailable: true }));

    expect(result).toBe(true);
    expect(sent).toEqual([{ outcome: 'direct', failureStage: 'none', turnAvailable: true }]);
    expect(reporter.hasSent()).toBe(true);
  });

  it('is a no-op on every subsequent call, regardless of what outcome is passed', () => {
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    reporter.reportOnce('direct', facts());
    const second = reporter.reportOnce('failed', facts({ reachedStage: 'ice-connect' }));
    const third = reporter.reportOnce('relay', facts());

    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.outcome).toBe('direct');
  });

  it('suppresses duplicates across the same real-world race this guards: onconnectionstate firing AND the connect-timeout firing for the same session', () => {
    // Simulates bootstrap.ts's two independent failure call sites both firing
    // for the same session (e.g. state flips to 'failed' right as the
    // timeout also elapses) — only one beacon must go out.
    const sent: TelemetryPayload[] = [];
    const reporter = new OutcomeReporter((p) => sent.push(p));

    reporter.reportOnce('failed', facts({ reachedStage: 'ice-connect' })); // onconnectionstate('failed')
    reporter.reportOnce('failed', facts({ reachedStage: 'ice-connect' })); // connect-timeout callback

    expect(sent).toHaveLength(1);
  });

  it('each OutcomeReporter instance tracks its own dedup state independently', () => {
    const sentA: TelemetryPayload[] = [];
    const sentB: TelemetryPayload[] = [];
    const a = new OutcomeReporter((p) => sentA.push(p));
    const b = new OutcomeReporter((p) => sentB.push(p));

    a.reportOnce('direct', facts());
    b.reportOnce('relay', facts());

    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);
  });
});

describe('OutcomeReporter — never throws on the caller, regardless of what send does', () => {
  it('propagates a send failure only if send itself throws (the real wiring never lets that happen)', () => {
    // This documents the contract: OutcomeReporter itself does not swallow
    // exceptions from `send` — bootstrap.ts's real `send` is responsible for
    // never throwing (fetch(...).catch(() => {})). This test proves the
    // CONTRACT boundary, not that OutcomeReporter is itself defensive.
    const reporter = new OutcomeReporter(() => {
      throw new Error('a misbehaving send implementation');
    });
    expect(() => reporter.reportOnce('direct', facts())).toThrow('a misbehaving send implementation');
  });
});

describe('outcome type coverage', () => {
  it('the three outcomes all shape correctly end to end', () => {
    for (const outcome of ['direct', 'relay', 'failed'] as const satisfies readonly TelemetryOutcome[]) {
      const sent: TelemetryPayload[] = [];
      new OutcomeReporter((p) => sent.push(p)).reportOnce(outcome, facts({ reachedStage: 'sdp-exchange' }));
      expect(sent[0]?.outcome).toBe(outcome);
    }
  });
});
