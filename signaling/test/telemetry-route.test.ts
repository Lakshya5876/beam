import { describe, expect, it } from 'vitest';
import { handleTelemetry, type AnalyticsDataPointLike, type TelemetryEnv } from '../src/telemetry-route.js';

function post(body: unknown): Request {
  return new Request('http://example.com/telemetry', {
    method: 'POST',
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
  it('writes a data point and responds 204', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'direct', turnAvailable: true }), env);

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['direct', 'none'], doubles: [1, 1] }]);
  });
});

describe('handleTelemetry — relay outcome', () => {
  it('writes a data point and responds 204', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'relay', turnAvailable: true }), env);

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['relay', 'none'], doubles: [1, 1] }]);
  });
});

describe('handleTelemetry — failed outcome', () => {
  it('writes the failure stage and turnAvailable=0', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(
      post({ outcome: 'failed', failureStage: 'ice-gathering', turnAvailable: false }),
      env,
    );

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['failed', 'ice-gathering'], doubles: [0, 1] }]);
  });

  it('degrades an unrecognized failure stage to "none" rather than rejecting the request', async () => {
    const { env, writes } = capturingAnalytics();
    const response = await handleTelemetry(post({ outcome: 'failed', failureStage: 'made-up-stage' }), env);

    expect(response.status).toBe(204);
    expect(writes).toEqual([{ blobs: ['failed', 'none'], doubles: [0, 1] }]);
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
