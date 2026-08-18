import { describe, expect, it } from 'vitest';
import {
  hasRelayServer,
  isUsableRelay,
  mergeIceServers,
  parseIceServerList,
  parseIceServerUrl,
  parseIceServersEnv,
  parseIceUrl,
  type IceServerConfig,
} from '../../src/application/ice-servers.js';

describe('parseIceUrl', () => {
  it('parses a stun url with an explicit port', () => {
    expect(parseIceUrl('stun:stun.l.google.com:19302')).toEqual({
      scheme: 'stun',
      host: 'stun.l.google.com',
      port: 19302,
      transport: 'udp',
    });
  });

  it('defaults the port per scheme when omitted', () => {
    expect(parseIceUrl('turn:relay.example.com')?.port).toBe(3478);
    expect(parseIceUrl('turns:relay.example.com')?.port).toBe(5349);
  });

  it('reads the transport query parameter', () => {
    expect(parseIceUrl('turn:relay.example.com:80?transport=tcp')?.transport).toBe('tcp');
    expect(parseIceUrl('turn:relay.example.com:80?transport=udp')?.transport).toBe('udp');
    expect(parseIceUrl('turn:relay.example.com:80')?.transport).toBe('udp');
  });

  it('keeps a bracketed IPv6 host intact and still finds the port', () => {
    expect(parseIceUrl('turn:[2001:db8::1]:3478')).toEqual({
      scheme: 'turn',
      host: '[2001:db8::1]',
      port: 3478,
      transport: 'udp',
    });
  });

  it('is total: rejects malformed input rather than throwing', () => {
    expect(parseIceUrl('')).toBeNull();
    expect(parseIceUrl('http://example.com')).toBeNull();
    expect(parseIceUrl('turn:')).toBeNull();
    expect(parseIceUrl('turn:host:notaport')).toBeNull();
    expect(parseIceUrl('turn:host:0')).toBeNull();
    expect(parseIceUrl('turn:host:70000')).toBeNull();
    expect(parseIceUrl(':3478')).toBeNull();
  });
});

describe('isUsableRelay', () => {
  it('is true only for a TURN entry that carries credentials', () => {
    expect(isUsableRelay({ urls: 'stun:x:3478' })).toBe(false);
    expect(isUsableRelay({ urls: 'turn:y:80' })).toBe(false);
    expect(isUsableRelay({ urls: 'turn:y:80', username: 'u' })).toBe(false);
    expect(isUsableRelay({ urls: 'turn:y:80', username: 'u', credential: 'c' })).toBe(true);
  });
});

describe('parseIceServerList', () => {
  it('parses an { iceServers: [...] } body', () => {
    expect(parseIceServerList({ iceServers: [{ urls: 'stun:a:3478' }] })).toEqual([{ urls: 'stun:a:3478' }]);
  });

  it('parses a bare array, the shape TURN providers return', () => {
    expect(parseIceServerList([{ urls: 'turn:a:80', username: 'u', credential: 'c' }])).toEqual([
      { urls: 'turn:a:80', username: 'u', credential: 'c' },
    ]);
  });

  it('expands a urls array into one entry per url, preserving credentials', () => {
    const parsed = parseIceServerList([
      { urls: ['turn:a:80', 'turn:a:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    expect(parsed).toEqual([
      { urls: 'turn:a:80', username: 'u', credential: 'c' },
      { urls: 'turn:a:443?transport=tcp', username: 'u', credential: 'c' },
    ]);
  });

  it('is total: junk yields an empty list rather than throwing', () => {
    expect(parseIceServerList(null)).toEqual([]);
    expect(parseIceServerList('nope')).toEqual([]);
    expect(parseIceServerList({})).toEqual([]);
    expect(parseIceServerList([1, 'x', null, {}])).toEqual([]);
    expect(parseIceServerList([{ urls: 'http://evil.example.com' }])).toEqual([]);
  });
});

describe('mergeIceServers', () => {
  it('keeps priority order and drops exact duplicates', () => {
    const a: IceServerConfig[] = [{ urls: 'stun:x:3478' }];
    const b: IceServerConfig[] = [{ urls: 'stun:x:3478' }, { urls: 'turn:y:80', username: 'u', credential: 'c' }];
    expect(mergeIceServers(a, b)).toEqual([
      { urls: 'stun:x:3478' },
      { urls: 'turn:y:80', username: 'u', credential: 'c' },
    ]);
  });

  it('keeps the same host under two different usernames', () => {
    const merged = mergeIceServers(
      [{ urls: 'turn:y:80', username: 'old', credential: 'c1' }],
      [{ urls: 'turn:y:80', username: 'new', credential: 'c2' }],
    );
    expect(merged).toHaveLength(2);
  });
});

describe('hasRelayServer', () => {
  it('is true only for a usable TURN entry', () => {
    expect(hasRelayServer([{ urls: 'stun:x:3478' }])).toBe(false);
    expect(hasRelayServer([{ urls: 'turn:y:80' }])).toBe(false); // unusable: no credentials
    expect(hasRelayServer([{ urls: 'turn:y:80', username: 'u', credential: 'c' }])).toBe(true);
    expect(hasRelayServer([{ urls: 'turns:y:443', username: 'u', credential: 'c' }])).toBe(true);
  });
});

describe('parseIceServerUrl (legacy BEAM_ICE_SERVERS form)', () => {
  it('parses a bare url', () => {
    expect(parseIceServerUrl('stun:stun.l.google.com:19302')).toEqual({ urls: 'stun:stun.l.google.com:19302' });
  });

  it('splits inline credentials out of the url', () => {
    expect(parseIceServerUrl('turn:user:pass@relay.example.com:3478')).toEqual({
      urls: 'turn:relay.example.com:3478',
      username: 'user',
      credential: 'pass',
    });
  });

  it('is total: rejects malformed entries', () => {
    expect(parseIceServerUrl('')).toBeNull();
    expect(parseIceServerUrl('   ')).toBeNull();
    expect(parseIceServerUrl('turn:nocolon@host:3478')).toBeNull();
    expect(parseIceServerUrl('notaurl')).toBeNull();
  });
});

describe('parseIceServersEnv', () => {
  it('returns an empty list when unset', () => {
    expect(parseIceServersEnv(undefined)).toEqual([]);
  });

  it('parses a comma-separated list and drops bad entries', () => {
    expect(parseIceServersEnv('stun:a:3478, turn:u:p@b:80, ,garbage')).toEqual([
      { urls: 'stun:a:3478' },
      { urls: 'turn:b:80', username: 'u', credential: 'p' },
    ]);
  });
});
