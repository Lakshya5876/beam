import { describe, expect, it } from 'vitest';
import { parseTelemetryPayload, toDataPoint, type TelemetryPayload } from '../src/telemetry.js';

function payload(overrides: Partial<TelemetryPayload> = {}): TelemetryPayload {
  return {
    outcome: 'direct',
    failureStage: 'none',
    turnAvailable: false,
    durationMs: 0,
    bytesSent: 0,
    bytesReceived: 0,
    ...overrides,
  };
}

describe('parseTelemetryPayload', () => {
  it('accepts a well-formed direct payload with usage', () => {
    expect(
      parseTelemetryPayload({
        outcome: 'direct',
        failureStage: 'none',
        turnAvailable: false,
        durationMs: 45_000,
        bytesSent: 12_000,
        bytesReceived: 340_000,
      }),
    ).toEqual({
      outcome: 'direct',
      failureStage: 'none',
      turnAvailable: false,
      durationMs: 45_000,
      bytesSent: 12_000,
      bytesReceived: 340_000,
    });
  });

  it('accepts a well-formed relay payload with usage', () => {
    expect(
      parseTelemetryPayload({
        outcome: 'relay',
        turnAvailable: true,
        durationMs: 90_000,
        bytesSent: 5_000_000,
        bytesReceived: 8_000_000,
      }),
    ).toEqual({
      outcome: 'relay',
      failureStage: 'none',
      turnAvailable: true,
      durationMs: 90_000,
      bytesSent: 5_000_000,
      bytesReceived: 8_000_000,
    });
  });

  it('accepts a well-formed failed payload carrying the failure stage and whatever usage accumulated', () => {
    expect(
      parseTelemetryPayload({ outcome: 'failed', failureStage: 'ice-gathering', durationMs: 12_000 }),
    ).toEqual({
      outcome: 'failed',
      failureStage: 'ice-gathering',
      turnAvailable: false,
      durationMs: 12_000,
      bytesSent: 0,
      bytesReceived: 0,
    });
  });

  it('defaults failureStage to "none" when absent', () => {
    expect(parseTelemetryPayload({ outcome: 'direct' })?.failureStage).toBe('none');
  });

  it('defaults failureStage to "none" when it is not a recognized stage', () => {
    expect(parseTelemetryPayload({ outcome: 'failed', failureStage: 'not-a-real-stage' })?.failureStage).toBe('none');
  });

  it('defaults turnAvailable to false when absent or not literally true', () => {
    expect(parseTelemetryPayload({ outcome: 'direct' })?.turnAvailable).toBe(false);
    expect(parseTelemetryPayload({ outcome: 'direct', turnAvailable: 'true' })?.turnAvailable).toBe(false);
    expect(parseTelemetryPayload({ outcome: 'direct', turnAvailable: 1 })?.turnAvailable).toBe(false);
  });

  describe('usage fields (durationMs, bytesSent, bytesReceived) — bounded and total', () => {
    it('default to 0 when absent', () => {
      const result = parseTelemetryPayload({ outcome: 'direct' });
      expect(result).toMatchObject({ durationMs: 0, bytesSent: 0, bytesReceived: 0 });
    });

    it('degrade a non-numeric value to 0 rather than rejecting the payload', () => {
      const result = parseTelemetryPayload({ outcome: 'direct', durationMs: 'a while', bytesSent: null, bytesReceived: [] });
      expect(result).toMatchObject({ durationMs: 0, bytesSent: 0, bytesReceived: 0 });
    });

    it('degrade a negative value to 0', () => {
      const result = parseTelemetryPayload({ outcome: 'direct', durationMs: -5, bytesSent: -1 });
      expect(result).toMatchObject({ durationMs: 0, bytesSent: 0 });
    });

    it('degrade NaN/Infinity to 0', () => {
      const result = parseTelemetryPayload({
        outcome: 'direct',
        durationMs: Number.NaN,
        bytesSent: Number.POSITIVE_INFINITY,
      });
      expect(result).toMatchObject({ durationMs: 0, bytesSent: 0 });
    });

    it('clamp an absurdly large value rather than admitting it unbounded (a public endpoint sanity ceiling)', () => {
      const result = parseTelemetryPayload({ outcome: 'direct', bytesSent: Number.MAX_SAFE_INTEGER });
      expect(result?.bytesSent).toBe(1024 ** 4); // MAX_BYTES (1 TiB)
      expect(result?.bytesSent).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });

    it('accepts zero as a legitimate value', () => {
      const result = parseTelemetryPayload({ outcome: 'direct', durationMs: 0, bytesSent: 0, bytesReceived: 0 });
      expect(result).toMatchObject({ durationMs: 0, bytesSent: 0, bytesReceived: 0 });
    });
  });

  it('is total: rejects a body without a recognized outcome', () => {
    expect(parseTelemetryPayload(null)).toBeNull();
    expect(parseTelemetryPayload(undefined)).toBeNull();
    expect(parseTelemetryPayload('direct')).toBeNull();
    expect(parseTelemetryPayload(42)).toBeNull();
    expect(parseTelemetryPayload([])).toBeNull();
    expect(parseTelemetryPayload({})).toBeNull();
    expect(parseTelemetryPayload({ outcome: 'nope' })).toBeNull();
    expect(parseTelemetryPayload({ outcome: 123 })).toBeNull();
  });

  it('rejects an attempt to smuggle extra fields into a valid shape (only known fields are read)', () => {
    // Not a rejection test exactly — a positive assertion that unknown fields
    // (e.g. a session code someone tries to attach) are simply never read.
    const result = parseTelemetryPayload({
      outcome: 'direct',
      sessionCode: 'k7x2m9q4w8r3t6y1u5z0a2b4c7',
      pin: '123456',
    });
    expect(result).toEqual(payload());
    expect(Object.keys(result ?? {})).not.toContain('sessionCode');
  });
});

describe('toDataPoint', () => {
  it('shapes a direct outcome with usage', () => {
    expect(
      toDataPoint(payload({ outcome: 'direct', turnAvailable: true, durationMs: 1000, bytesSent: 10, bytesReceived: 20 })),
    ).toEqual({ blobs: ['direct', 'none'], doubles: [1, 1, 1000, 10, 20] });
  });

  it('shapes a relay outcome with usage', () => {
    expect(
      toDataPoint(payload({ outcome: 'relay', turnAvailable: true, durationMs: 5000, bytesSent: 5_000_000, bytesReceived: 8_000_000 })),
    ).toEqual({ blobs: ['relay', 'none'], doubles: [1, 1, 5000, 5_000_000, 8_000_000] });
  });

  it('shapes a failed outcome, carrying the stage, turnAvailable=0, and whatever usage accumulated', () => {
    expect(
      toDataPoint(payload({ outcome: 'failed', failureStage: 'ice-connect', turnAvailable: false, durationMs: 3000 })),
    ).toEqual({ blobs: ['failed', 'ice-connect'], doubles: [0, 1, 3000, 0, 0] });
  });

  it('always carries count=1 in the second double, for reliable SUM under sampling', () => {
    for (const outcome of ['direct', 'relay', 'failed'] as const) {
      const point = toDataPoint(payload({ outcome }));
      expect(point.doubles[1]).toBe(1);
    }
  });
});
