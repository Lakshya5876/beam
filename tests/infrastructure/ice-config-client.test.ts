import { describe, expect, it } from 'vitest';
import {
  HttpIceConfigClient,
  iceConfigUrlFor,
  MAX_ICE_CONFIG_BYTES,
  type FetchLike,
} from '../../src/infrastructure/ice-config-client.js';

function response(body: unknown, init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}): Awaited<ReturnType<FetchLike>> {
  const headers = init.headers ?? {};
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const VALID_BODY = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' },
  ],
};

describe('iceConfigUrlFor', () => {
  it('maps ws/wss to http/https on the same origin', () => {
    expect(iceConfigUrlFor('ws://localhost:8081')).toBe('http://localhost:8081/ice-config');
    expect(iceConfigUrlFor('wss://beam.example.com')).toBe('https://beam.example.com/ice-config');
  });

  it('drops a session-code path — the endpoint lives at the origin root', () => {
    expect(iceConfigUrlFor('wss://beam.example.com/k7x2m9q4w8r3t6y1u5z0a2b4c7')).toBe(
      'https://beam.example.com/ice-config',
    );
  });

  it('accepts an already-http signaling url', () => {
    expect(iceConfigUrlFor('https://beam.example.com')).toBe('https://beam.example.com/ice-config');
  });

  it('rejects a url that is not http(s)/ws(s)', () => {
    expect(iceConfigUrlFor('file:///etc/passwd')).toBeNull();
    expect(iceConfigUrlFor('not a url')).toBeNull();
    expect(iceConfigUrlFor('')).toBeNull();
  });
});

describe('HttpIceConfigClient', () => {
  it('returns the parsed ice servers on success', async () => {
    const client = new HttpIceConfigClient(1000, () => Promise.resolve(response(VALID_BODY)));

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' },
    ]);
  });

  it('requests /ice-config on the signaling origin', async () => {
    const seen: string[] = [];
    const client = new HttpIceConfigClient(1000, (url) => {
      seen.push(url);
      return Promise.resolve(response(VALID_BODY));
    });

    await client.fetchIceServers('ws://localhost:8081/somecode');

    expect(seen).toEqual(['http://localhost:8081/ice-config']);
  });

  it('surfaces the worker TURN diagnostic so a failure can be attributed', async () => {
    const logs: string[] = [];
    const client = new HttpIceConfigClient(
      1000,
      () => Promise.resolve(response(VALID_BODY, { headers: { 'x-beam-turn': 'provider-unreachable' } })),
      (msg) => logs.push(msg),
    );

    await client.fetchIceServers('ws://localhost:8081');

    expect(logs.some((l) => l.includes('turn=provider-unreachable'))).toBe(true);
  });

  it('fails typed on a non-ok response', async () => {
    const client = new HttpIceConfigClient(1000, () => Promise.resolve(response('nope', { ok: false, status: 502 })));

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result).toEqual({ ok: false, error: { error: 'IceConfigFetchFailed', reason: 'ice-config responded 502' } });
  });

  it('fails typed when a captive portal serves HTML instead of JSON', async () => {
    const client = new HttpIceConfigClient(1000, () => Promise.resolve(response('<html>login</html>')));

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('ice-config contained no usable servers');
  });

  it('rejects an oversized body rather than parsing it', async () => {
    const huge = 'x'.repeat(MAX_ICE_CONFIG_BYTES + 1);
    const client = new HttpIceConfigClient(1000, () => Promise.resolve(response(huge)));

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('ice-config body exceeds cap');
  });

  it('fails typed when the request throws', async () => {
    const client = new HttpIceConfigClient(1000, () => Promise.reject(new Error('ECONNREFUSED')));

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('ice-config request failed');
  });

  it('reports a timeout distinctly from other failures', async () => {
    const client = new HttpIceConfigClient(1000, () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      return Promise.reject(abort);
    });

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('ice-config timed out');
  });

  it('rejects a signaling url it cannot derive an origin from', async () => {
    const client = new HttpIceConfigClient(1000, () => Promise.reject(new Error('should not be called')));

    const result = await client.fetchIceServers('garbage');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('signaling url is not http(s)/ws(s)');
  });

  it('aborts the in-flight request when the timeout elapses', async () => {
    let observed: AbortSignal | undefined;
    const client = new HttpIceConfigClient(5, (_url, init) => {
      observed = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abort = new Error('aborted');
          abort.name = 'AbortError';
          reject(abort);
        });
      });
    });

    const result = await client.fetchIceServers('ws://localhost:8081');

    expect(observed?.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });
});
