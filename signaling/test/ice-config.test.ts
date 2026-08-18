import { describe, expect, it } from 'vitest';
import { DEFAULT_ICE_SERVERS, iceConfigBody, parseIceServersEnv, resolveIceConfig } from '../src/ice-config.js';
import { mintFailed, mintOk, type TurnMintResult, type TurnProvider } from '../src/turn-provider.js';

function providerReturning(result: TurnMintResult): TurnProvider {
  return { mint: () => Promise.resolve(result) };
}

function bodyServers(body: string): Array<{ urls: string; username?: string }> {
  return (JSON.parse(body) as { iceServers: Array<{ urls: string; username?: string }> }).iceServers;
}

describe('parseIceServersEnv — total parsing with STUN fallback', () => {
  it('returns the default when unset or blank', () => {
    expect(parseIceServersEnv(undefined)).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('')).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('   ')).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('returns the default on malformed JSON (never throws)', () => {
    expect(parseIceServersEnv('not json')).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('{"urls":')).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('returns the default when the array is empty or entries lack urls', () => {
    expect(parseIceServersEnv('[]')).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('[{"username":"u"}]')).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('[{"urls":""}]')).toEqual(DEFAULT_ICE_SERVERS);
    expect(parseIceServersEnv('[{"urls":[]}]')).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('accepts a valid array with string and array urls plus TURN credentials', () => {
    const raw = JSON.stringify([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:turn.example.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
    const parsed = parseIceServersEnv(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.urls).toBe('stun:stun.example.com:3478');
    expect(parsed[1]?.username).toBe('u');
  });

  it('rejects the whole value if ANY entry is invalid (no partial config)', () => {
    const raw = JSON.stringify([{ urls: 'stun:ok.example.com' }, { urls: 42 }]);
    expect(parseIceServersEnv(raw)).toEqual(DEFAULT_ICE_SERVERS);
  });
});

describe('iceConfigBody', () => {
  it('serializes an RTCPeerConnection-consumable shape', () => {
    const body = JSON.parse(iceConfigBody(undefined)) as { iceServers: Array<{ urls: string }> };
    expect(Array.isArray(body.iceServers)).toBe(true);
    expect(body.iceServers[0]?.urls).toBe('stun:stun.l.google.com:19302');
  });
});

describe('resolveIceConfig — STUN always, TURN as an appended fallback', () => {
  const minted = mintOk({
    iceServers: [{ urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' }],
    expiresAtMs: 1_000_000,
  });

  it('serves STUN only when no provider is configured', async () => {
    const result = await resolveIceConfig(undefined, null, 0);
    expect(result.hasTurn).toBe(false);
    expect(result.turnFailure).toBeUndefined();
    expect(bodyServers(result.body)).toEqual([...DEFAULT_ICE_SERVERS]);
  });

  it('appends TURN AFTER STUN so ICE still prefers a direct pair', async () => {
    const result = await resolveIceConfig(undefined, providerReturning(minted), 0);
    const servers = bodyServers(result.body);
    expect(result.hasTurn).toBe(true);
    expect(servers[0]?.urls).toBe('stun:stun.l.google.com:19302');
    expect(servers[servers.length - 1]?.urls).toBe('turn:relay.example.com:80');
  });

  it('keeps deploy-time ICE_SERVERS and adds TURN to them', async () => {
    const raw = JSON.stringify([{ urls: 'stun:self-hosted.example.com:3478' }]);
    const servers = bodyServers((await resolveIceConfig(raw, providerReturning(minted), 0)).body);
    expect(servers.map((s) => s.urls)).toEqual([
      'stun:self-hosted.example.com:3478',
      'turn:relay.example.com:80',
    ]);
  });

  it('degrades to STUN-only when minting fails, reporting the typed reason', async () => {
    const result = await resolveIceConfig(undefined, providerReturning(mintFailed('provider-unreachable')), 0);
    expect(result.hasTurn).toBe(false);
    expect(result.turnFailure).toBe('provider-unreachable');
    // The session must still be able to connect directly.
    expect(bodyServers(result.body)).toEqual([...DEFAULT_ICE_SERVERS]);
  });

  it('reports no TURN when the provider returns an empty server list', async () => {
    const empty = mintOk({ iceServers: [], expiresAtMs: 1_000 });
    const result = await resolveIceConfig(undefined, providerReturning(empty), 0);
    expect(result.hasTurn).toBe(false);
  });
});
