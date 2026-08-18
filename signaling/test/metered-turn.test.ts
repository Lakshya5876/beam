import { describe, expect, it, vi } from 'vitest';
import {
  createMeteredProvider,
  MeteredTurnProvider,
  parseCredentialResponse,
  parseIceServersResponse,
  readMeteredConfig,
} from '../src/metered-turn.js';
import type { FetchLike } from '../src/turn-provider.js';

const SECRET = 'test-secret-value';

function jsonResponse(body: unknown, ok = true, status = 200): Awaited<ReturnType<FetchLike>> {
  return { ok, status, json: () => Promise.resolve(body) };
}

/**
 * Fake provider endpoint. Records every request so tests can assert on the
 * secret's exposure, not just on the happy path.
 */
function fakeFetch(handlers: {
  credential?: () => Awaited<ReturnType<FetchLike>> | Promise<never>;
  credentials?: () => Awaited<ReturnType<FetchLike>> | Promise<never>;
}): { impl: FetchLike; calls: Array<{ url: string; init?: unknown }> } {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, ...(init !== undefined && { init }) });
    if (url.includes('/credential?')) {
      return Promise.resolve(
        handlers.credential?.() ?? jsonResponse({ apiKey: 'example-handle', expiryInSeconds: 3600 }),
      ) as Promise<Awaited<ReturnType<FetchLike>>>;
    }
    return Promise.resolve(
      handlers.credentials?.() ??
        jsonResponse([
          { urls: 'stun:standard.relay.metered.ca:80' },
          { urls: 'turn:standard.relay.metered.ca:80', username: 'u1', credential: 'c1' },
          { urls: 'turn:standard.relay.metered.ca:443?transport=tcp', username: 'u1', credential: 'c1' },
        ]),
    ) as Promise<Awaited<ReturnType<FetchLike>>>;
  };
  return { impl, calls };
}

describe('readMeteredConfig', () => {
  it('returns null when TURN is not configured (a supported deployment)', () => {
    expect(readMeteredConfig({})).toBeNull();
    expect(readMeteredConfig({ METERED_APP_NAME: 'app' })).toBeNull();
    expect(readMeteredConfig({ METERED_SECRET_KEY: SECRET })).toBeNull();
  });

  it('rejects an app name that could redirect the outbound secret elsewhere', () => {
    for (const appName of ['evil.com/x', 'a b', 'app/../other', 'app:8080', '-lead', 'trail-']) {
      expect(readMeteredConfig({ METERED_APP_NAME: appName, METERED_SECRET_KEY: SECRET })).toBeNull();
    }
  });

  it('accepts a valid config and an optional ttl override', () => {
    expect(readMeteredConfig({ METERED_APP_NAME: 'my-app', METERED_SECRET_KEY: SECRET })).toEqual({
      appName: 'my-app',
      secretKey: SECRET,
    });
    expect(
      readMeteredConfig({ METERED_APP_NAME: 'my-app', METERED_SECRET_KEY: SECRET, TURN_TTL_SECONDS: '600' })?.ttlSeconds,
    ).toBe(600);
  });

  it('ignores a non-positive or non-integer ttl rather than minting a broken credential', () => {
    for (const ttl of ['0', '-5', 'abc', '1.5']) {
      expect(
        readMeteredConfig({ METERED_APP_NAME: 'a', METERED_SECRET_KEY: SECRET, TURN_TTL_SECONDS: ttl })?.ttlSeconds,
      ).toBeUndefined();
    }
  });
});

describe('parseCredentialResponse', () => {
  it('parses apiKey and expiry', () => {
    expect(parseCredentialResponse({ apiKey: 'example-k', expiryInSeconds: 60 }, 999)).toEqual({
      handle: 'example-k',
      expiryInSeconds: 60,
    });
  });

  it('falls back to the requested ttl when the provider omits or corrupts expiry', () => {
    expect(parseCredentialResponse({ apiKey: 'example-k' }, 999)?.expiryInSeconds).toBe(999);
    expect(parseCredentialResponse({ apiKey: 'example-k', expiryInSeconds: -1 }, 999)?.expiryInSeconds).toBe(999);
  });

  it('is total: rejects a body without a usable apiKey', () => {
    expect(parseCredentialResponse(null, 60)).toBeNull();
    expect(parseCredentialResponse({}, 60)).toBeNull();
    expect(parseCredentialResponse({ apiKey: '' }, 60)).toBeNull(); // example: empty handle
    expect(parseCredentialResponse([{ apiKey: 'example-k' }], 60)).toBeNull();
  });
});

describe('parseIceServersResponse', () => {
  it('keeps only entries with a usable urls field', () => {
    expect(
      parseIceServersResponse([
        { urls: 'turn:a:80', username: 'u', credential: 'c' },
        { urls: '' },
        { username: 'u' },
        null,
        'nope',
      ]),
    ).toEqual([{ urls: 'turn:a:80', username: 'u', credential: 'c' }]);
  });

  it('is total: a non-array yields an empty list', () => {
    expect(parseIceServersResponse(null)).toEqual([]);
    expect(parseIceServersResponse({ iceServers: [] })).toEqual([]);
  });
});

describe('MeteredTurnProvider.mint', () => {
  it('mints an expiring credential and resolves it to ice servers', async () => {
    const { impl, calls } = fakeFetch({});
    const provider = new MeteredTurnProvider({ appName: 'my-app', secretKey: SECRET }, impl);

    const result = await provider.mint(1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iceServers).toHaveLength(3);
    expect(result.value.expiresAtMs).toBe(1_000 + 3600 * 1000);
    // Step 1 POSTs the requested expiry; step 2 uses the returned handle.
    expect(calls[0]?.url).toContain('/api/v1/turn/credential?secretKey=');
    expect(calls[0]?.init).toMatchObject({ method: 'POST' });
    expect(calls[1]?.url).toContain('/api/v1/turn/credentials?apiKey=example-handle');
  });

  it('never puts the provider secret in what the peers receive', async () => {
    const { impl } = fakeFetch({});
    const provider = new MeteredTurnProvider({ appName: 'my-app', secretKey: SECRET }, impl);

    const result = await provider.mint(0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain(SECRET);
    // The step-1 handle is an internal detail too — only ICE servers go out.
    expect(JSON.stringify(result.value)).not.toContain('example-handle');
  });

  it('reports provider-rejected on a non-ok mint (bad secret, quota)', async () => {
    const { impl } = fakeFetch({ credential: () => jsonResponse({ error: 'nope' }, false, 401) });
    const provider = new MeteredTurnProvider({ appName: 'a', secretKey: SECRET }, impl);
    await expect(provider.mint(0)).resolves.toEqual({ ok: false, failure: 'provider-rejected' });
  });

  it('reports provider-unreachable when the network throws, without leaking the url', async () => {
    const impl: FetchLike = () => Promise.reject(new Error(`connect failed to ${SECRET}`));
    const provider = new MeteredTurnProvider({ appName: 'a', secretKey: SECRET }, impl);
    const result = await provider.mint(0);
    expect(result).toEqual({ ok: false, failure: 'provider-unreachable' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports malformed-response when the mint body has no apiKey', async () => {
    const { impl } = fakeFetch({ credential: () => jsonResponse({ unexpected: true }) });
    const provider = new MeteredTurnProvider({ appName: 'a', secretKey: SECRET }, impl);
    await expect(provider.mint(0)).resolves.toEqual({ ok: false, failure: 'malformed-response' });
  });

  it('reports malformed-response when the ice server list comes back empty', async () => {
    const { impl } = fakeFetch({ credentials: () => jsonResponse([]) });
    const provider = new MeteredTurnProvider({ appName: 'a', secretKey: SECRET }, impl);
    await expect(provider.mint(0)).resolves.toEqual({ ok: false, failure: 'malformed-response' });
  });

  it('survives a body that is not JSON at all', async () => {
    const { impl } = fakeFetch({
      credential: () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('not json')) }),
    });
    const provider = new MeteredTurnProvider({ appName: 'a', secretKey: SECRET }, impl);
    await expect(provider.mint(0)).resolves.toEqual({ ok: false, failure: 'malformed-response' });
  });
});

describe('createMeteredProvider', () => {
  it('returns null when unconfigured, so the deployment stays STUN-only', () => {
    expect(createMeteredProvider({}, vi.fn() as unknown as FetchLike)).toBeNull();
  });

  it('returns a provider when configured', () => {
    const provider = createMeteredProvider(
      { METERED_APP_NAME: 'a', METERED_SECRET_KEY: SECRET },
      vi.fn() as unknown as FetchLike,
    );
    expect(provider).not.toBeNull();
  });
});
