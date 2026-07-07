import { describe, expect, it } from 'vitest';
import { DEFAULT_ICE_SERVERS, iceConfigBody, parseIceServersEnv } from '../src/ice-config.js';

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
