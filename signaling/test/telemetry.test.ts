import { describe, expect, it } from 'vitest';
import { parseTelemetryPayload, toDataPoint, type TelemetryPayload } from '../src/telemetry.js';

describe('parseTelemetryPayload', () => {
  it('accepts a well-formed direct payload', () => {
    expect(parseTelemetryPayload({ outcome: 'direct', failureStage: 'none', turnAvailable: false })).toEqual({
      outcome: 'direct',
      failureStage: 'none',
      turnAvailable: false,
    });
  });

  it('accepts a well-formed relay payload', () => {
    expect(parseTelemetryPayload({ outcome: 'relay', failureStage: 'none', turnAvailable: true })).toEqual({
      outcome: 'relay',
      failureStage: 'none',
      turnAvailable: true,
    });
  });

  it('accepts a well-formed failed payload carrying the failure stage', () => {
    expect(parseTelemetryPayload({ outcome: 'failed', failureStage: 'ice-gathering', turnAvailable: false })).toEqual(
      { outcome: 'failed', failureStage: 'ice-gathering', turnAvailable: false },
    );
  });

  it('defaults failureStage to "none" when absent', () => {
    expect(parseTelemetryPayload({ outcome: 'direct' })).toEqual({
      outcome: 'direct',
      failureStage: 'none',
      turnAvailable: false,
    });
  });

  it('defaults failureStage to "none" when it is not a recognized stage', () => {
    expect(parseTelemetryPayload({ outcome: 'failed', failureStage: 'not-a-real-stage' })?.failureStage).toBe('none');
  });

  it('defaults turnAvailable to false when absent or not literally true', () => {
    expect(parseTelemetryPayload({ outcome: 'direct' })?.turnAvailable).toBe(false);
    expect(parseTelemetryPayload({ outcome: 'direct', turnAvailable: 'true' })?.turnAvailable).toBe(false);
    expect(parseTelemetryPayload({ outcome: 'direct', turnAvailable: 1 })?.turnAvailable).toBe(false);
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
    expect(result).toEqual({ outcome: 'direct', failureStage: 'none', turnAvailable: false });
    expect(Object.keys(result ?? {})).not.toContain('sessionCode');
  });
});

describe('toDataPoint', () => {
  it('shapes a direct outcome', () => {
    const payload: TelemetryPayload = { outcome: 'direct', failureStage: 'none', turnAvailable: true };
    expect(toDataPoint(payload)).toEqual({ blobs: ['direct', 'none'], doubles: [1, 1] });
  });

  it('shapes a relay outcome', () => {
    const payload: TelemetryPayload = { outcome: 'relay', failureStage: 'none', turnAvailable: true };
    expect(toDataPoint(payload)).toEqual({ blobs: ['relay', 'none'], doubles: [1, 1] });
  });

  it('shapes a failed outcome, carrying the stage and turnAvailable=0', () => {
    const payload: TelemetryPayload = { outcome: 'failed', failureStage: 'ice-connect', turnAvailable: false };
    expect(toDataPoint(payload)).toEqual({ blobs: ['failed', 'ice-connect'], doubles: [0, 1] });
  });

  it('always carries count=1 in the second double, for reliable SUM under sampling', () => {
    for (const outcome of ['direct', 'relay', 'failed'] as const) {
      const point = toDataPoint({ outcome, failureStage: 'none', turnAvailable: false });
      expect(point.doubles[1]).toBe(1);
    }
  });
});
