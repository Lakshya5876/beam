import { beforeEach, describe, expect, it } from 'vitest';
import { handleTelemetry, resetTelemetryRateLimiter, type AnalyticsDataPointLike, type TelemetryEnv } from '../src/telemetry-route.js';

beforeEach(() => {
  // The per-IP rate limiter is per-isolate module state (SECURITY_AUDIT_20-08.md
  // finding #6) — reset it between tests so one test's call count never
  // bleeds into the next's, and so the rate-limit tests below can drive it
  // to its cap deterministically.
  resetTelemetryRateLimiter();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://example.com/telemetry', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Captures every write so tests can assert on the exact data point shape. */
function capturingAnalytics(): { env: TelemetryEnv; writes: AnalyticsDataPointLike[] } {
  const writes: AnalyticsDataPointLike[] = [];
  return {
    env: { ANALYTICS: { writeDataPoint: (point) => { writes.push(point); } } },
    writes,
  };
}

function throwingAnalytics(): TelemetryEnv {
  return {
    ANALYTICS: {
      writeDataPoint: () => {
        throw new Error('Analytics Engine unavailable');
      },
    },
  };
}

describe('handleTelemetry — direct outcome', () => {
  it('writes a data point including duration and bytes, and responds 204', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(
      post({ outcome: 'direct', turnAvailable: true, durationMs: 45_000, bytesSent: 12_000, bytesReceived: 340_000 }),
      env,
    );

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['direct', 'none'], doubles: [1, 1, 45_000, 12_000, 340_000] }]);
  });
});

describe('handleTelemetry — relay outcome', () => {
  it('writes a data point including duration and bytes, and responds 204', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(
      post({
        outcome: 'relay',
        turnAvailable: true,
        durationMs: 90_000,
        bytesSent: 5_000_000,
        bytesReceived: 8_000_000,
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['relay', 'none'], doubles: [1, 1, 90_000, 5_000_000, 8_000_000] }]);
  });
});

describe('handleTelemetry — failed outcome', () => {
  it('writes the failure stage, turnAvailable=0, and whatever usage accumulated before failing', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(
      post({ outcome: 'failed', failureStage: 'ice-gathering', turnAvailable: false, durationMs: 12_000 }),
      env,
    );

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['failed', 'ice-gathering'], doubles: [0, 1, 12_000, 0, 0] }]);
  });

  it('degrades an unrecognized failure stage to "none" rather than rejecting the request', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'failed', failureStage: 'made-up-stage' }), env);

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['failed', 'none'], doubles: [0, 1, 0, 0, 0] }]);
  });
});

describe('handleTelemetry — duration and byte-count collection', () => {
  it('defaults duration/bytes to 0 when the client omits them', async () => {
    const { env, writes } = capturingAnalytics();
    await handleTelemetry(post({ outcome: 'direct' }), env);

    expect(writes).toEqual([{ blobs: ['direct', 'none'], doubles: [0, 1, 0, 0, 0] }]);
  });

  it('accepts zero as a legitimate value (a session that opened but transferred nothing yet)', async () => {
    const { env, writes } = capturingAnalytics();
    await handleTelemetry(post({ outcome: 'direct', durationMs: 0, bytesSent: 0, bytesReceived: 0 }), env);

    expect(writes).toEqual([{ blobs: ['direct', 'none'], doubles: [0, 1, 0, 0, 0] }]);
  });

  it('degrades a non-numeric duration/bytes to 0 rather than rejecting the request (malformed/unexpected client stats)', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(
      post({ outcome: 'relay', durationMs: 'a while', bytesSent: null, bytesReceived: ['not', 'a', 'number'] }),
      env,
    );

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['relay', 'none'], doubles: [0, 1, 0, 0, 0] }]);
  });

  it('degrades a negative duration/bytes to 0', async () => {
    const { env, writes } = capturingAnalytics();
    await handleTelemetry(post({ outcome: 'direct', durationMs: -1, bytesSent: -500 }), env);

    expect(writes).toEqual([{ blobs: ['direct', 'none'], doubles: [0, 1, 0, 0, 0] }]);
  });

  it('clamps an absurdly large byte count rather than admitting it unbounded (a public endpoint sanity ceiling)', async () => {
    const { env, writes } = capturingAnalytics();
    await handleTelemetry(post({ outcome: 'relay', bytesSent: Number.MAX_SAFE_INTEGER }), env);

    const point = writes[0];
    expect(point?.doubles?.[3]).toBe(1024 ** 4); // MAX_BYTES (1 TiB) — see telemetry.ts
    expect(point?.doubles?.[3]).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('handleTelemetry — malformed input', () => {
  it('rejects a body that is not valid JSON, without writing anything', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post('not json{'), env);

    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('rejects a body missing a recognized outcome, without writing anything', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ turnAvailable: true }), env);

    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('rejects an outcome value outside the known set', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'something-else' }), env);

    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('rejects a JSON array (not the expected object shape)', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post(['direct']), env);

    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('rejects an oversized body without parsing it', async () => {
    const { env, writes } = capturingAnalytics();
    const huge = JSON.stringify({ outcome: 'direct', padding: 'x'.repeat(10_000) });
    const response = await handleTelemetry(post(huge), env);

    expect(response.status).toBe(413);
    expect(writes).toEqual([]);
  });

  it('never reads or stores fields outside the known schema (e.g. a smuggled session code)', async () => {
    const { env, writes } = capturingAnalytics();
    await handleTelemetry(
      post({ outcome: 'direct', sessionCode: 'k7x2m9q4w8r3t6y1u5z0a2b4c7', pin: '123456', url: 'http://victim/api' }),
      env,
    );

    const written = JSON.stringify(writes);
    expect(written).not.toContain('k7x2m9q4w8r3t6y1u5z0a2b4c7');
    expect(written).not.toContain('123456');
    expect(written).not.toContain('victim');
  });
});

describe('handleTelemetry — write failure never reaches the client', () => {
  it('still responds 204 when writeDataPoint throws', async () => {
    const response = await handleTelemetry(post({ outcome: 'direct' }), throwingAnalytics());
    expect(response.status).toBe(204);
  });

  it('still responds 204 when writeDataPoint throws even with a full usage payload', async () => {
    const response = await handleTelemetry(
      post({ outcome: 'relay', durationMs: 90_000, bytesSent: 5_000_000, bytesReceived: 8_000_000 }),
      throwingAnalytics(),
    );
    expect(response.status).toBe(204);
  });

  it('still responds 204 when the ANALYTICS binding is entirely missing', async () => {
    const response = await handleTelemetry(post({ outcome: 'direct' }), {});
    expect(response.status).toBe(204);
  });

  it('never leaks an exception message or stack trace in the response body', async () => {
    const response = await handleTelemetry(post({ outcome: 'direct' }), throwingAnalytics());
    const body = await response.text();
    expect(body).not.toContain('Analytics Engine unavailable');
  });
});

describe('handleTelemetry — per-IP rate limiting (SECURITY_AUDIT_20-08.md finding #6, Low)', () => {
  it('rejects with 429 once an IP exceeds TELEMETRY_MAX_PER_MINUTE, without writing the over-limit request', async () => {
    const { env, writes } = capturingAnalytics();
    const limitedEnv: TelemetryEnv = { ...env, TELEMETRY_MAX_PER_MINUTE: '3' };
    const headers = { 'cf-connecting-ip': '203.0.113.5' };

    for (let i = 0; i < 3; i += 1) {
      const response = await handleTelemetry(post({ outcome: 'direct' }, headers), limitedEnv);
      expect(response.status).toBe(204);
    }
    const blocked = await handleTelemetry(post({ outcome: 'direct' }, headers), limitedEnv);

    expect(blocked.status).toBe(429);
    expect(writes).toHaveLength(3);
  });

  it('tracks each IP independently — one IP being rate-limited does not affect another', async () => {
    const { env, writes } = capturingAnalytics();
    const limitedEnv: TelemetryEnv = { ...env, TELEMETRY_MAX_PER_MINUTE: '1' };

    const first = await handleTelemetry(post({ outcome: 'direct' }, { 'cf-connecting-ip': '203.0.113.5' }), limitedEnv);
    const second = await handleTelemetry(post({ outcome: 'direct' }, { 'cf-connecting-ip': '203.0.113.5' }), limitedEnv);
    const other = await handleTelemetry(post({ outcome: 'direct' }, { 'cf-connecting-ip': '198.51.100.9' }), limitedEnv);

    expect(first.status).toBe(204);
    expect(second.status).toBe(429);
    expect(other.status).toBe(204);
    expect(writes).toHaveLength(2);
  });

  it('defaults to a generous limit (60/min) when unconfigured, so normal single-beacon sessions are never affected', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'direct' }, { 'cf-connecting-ip': '203.0.113.5' }), env);
    expect(response.status).toBe(204);
    expect(writes).toHaveLength(1);
  });

  it('a rejected (429) request never reaches JSON parsing or the ANALYTICS binding', async () => {
    const limitedEnv: TelemetryEnv = { TELEMETRY_MAX_PER_MINUTE: '1' };
    const headers = { 'cf-connecting-ip': '203.0.113.5' };
    await handleTelemetry(post({ outcome: 'direct' }, headers), limitedEnv);
    // Second request is malformed JSON — if rate limiting ran AFTER parsing,
    // this would 400; if it runs first (as it must), it 429s without ever
    // looking at the body.
    const response = await handleTelemetry(post('not json{', headers), limitedEnv);
    expect(response.status).toBe(429);
  });
});
