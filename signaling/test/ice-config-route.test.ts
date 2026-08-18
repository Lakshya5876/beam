import { beforeEach, describe, expect, it } from 'vitest';
import { handleIceConfig, resetProviderCache, type TurnEnv } from '../src/ice-config-route.js';
import type { FetchLike } from '../src/turn-provider.js';

const SECRET = 'provider-secret-do-not-leak';

const CONFIGURED: TurnEnv = { METERED_APP_NAME: 'beam-app', METERED_SECRET_KEY: SECRET };

/** Fake provider endpoint covering Metered's two-call flow. */
function workingFetch(): { impl: FetchLike; count: () => number } {
  let calls = 0;
  const impl: FetchLike = (url) => {
    calls += 1;
    if (url.includes('/credential?')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ apiKey: 'example-handle', expiryInSeconds: 3600 }) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' }]),
    });
  };
  return { impl, count: () => calls };
}

const failingFetch: FetchLike = () => Promise.reject(new Error('provider down'));

async function servers(response: Response): Promise<Array<{ urls: string }>> {
  const body = (await response.json()) as { iceServers: Array<{ urls: string }> };
  return body.iceServers;
}

describe('handleIceConfig', () => {
  beforeEach(() => {
    resetProviderCache();
  });

  it('serves STUN with not-configured when no TURN provider is set', async () => {
    const response = await handleIceConfig({}, failingFetch, 0);

    expect(response.headers.get('x-beam-turn')).toBe('not-configured');
    expect(await servers(response)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('serves STUN + TURN and reports availability when configured', async () => {
    const { impl } = workingFetch();
    const response = await handleIceConfig(CONFIGURED, impl, 0);

    expect(response.headers.get('x-beam-turn')).toBe('available');
    const list = await servers(response);
    expect(list.map((s) => s.urls)).toEqual(['stun:stun.l.google.com:19302', 'turn:relay.example.com:80']);
  });

  it('never exposes the provider secret in the response', async () => {
    const { impl } = workingFetch();
    const response = await handleIceConfig(CONFIGURED, impl, 0);
    const text = await response.text();

    expect(text).not.toContain(SECRET);
    expect(JSON.stringify([...response.headers])).not.toContain(SECRET);
  });

  it('still serves STUN when the provider is unreachable, tagging the failure', async () => {
    const response = await handleIceConfig(CONFIGURED, failingFetch, 0);

    expect(response.headers.get('x-beam-turn')).toBe('provider-unreachable');
    expect(await servers(response)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('is never cached downstream — credentials expire', async () => {
    const response = await handleIceConfig({}, failingFetch, 0);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is CORS-open so a cross-origin viewer can read it', async () => {
    const response = await handleIceConfig({}, failingFetch, 0);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('exposes the TURN diagnostic header cross-origin', async () => {
    // Cross-origin JS cannot read a non-safelisted response header unless it
    // is explicitly exposed, so without this the viewer sees turn=null when
    // signaling lives on a separate origin from the page.
    const response = await handleIceConfig({}, failingFetch, 0);
    expect(response.headers.get('access-control-expose-headers')).toBe('x-beam-turn');
  });

  it('mints once across repeated requests within the credential lifetime', async () => {
    const { impl, count } = workingFetch();

    await handleIceConfig(CONFIGURED, impl, 0);
    await handleIceConfig(CONFIGURED, impl, 1_000);
    await handleIceConfig(CONFIGURED, impl, 2_000);

    // Two upstream calls for ONE mint (credential + credentials), not six.
    expect(count()).toBe(2);
  });

  it('rebuilds the provider when the configuration changes', async () => {
    const { impl, count } = workingFetch();

    await handleIceConfig(CONFIGURED, impl, 0);
    await handleIceConfig({ ...CONFIGURED, METERED_APP_NAME: 'other-app' }, impl, 0);

    expect(count()).toBe(4);
  });
});
