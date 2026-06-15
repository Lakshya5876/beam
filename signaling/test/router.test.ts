import { describe, expect, it } from 'vitest';
import { routeRequest } from '../src/router.js';

const CODE = 'k7x2m9q4w8r3t6y1u5z0a2b4c7';
const BASE = 'https://signal.beam.workers.dev';

describe('routeRequest', () => {
  it('routes POST /new to mint', () => {
    expect(routeRequest('POST', `${BASE}/new`, false)).toEqual({ kind: 'mint' });
  });

  it('rejects a non-POST mint with 405', () => {
    expect(routeRequest('GET', `${BASE}/new`, false)).toEqual({ kind: 'reject', status: 405, reason: 'mint-requires-post' });
  });

  it('routes a WS upgrade to a valid code as pair', () => {
    expect(routeRequest('GET', `${BASE}/${CODE}`, true)).toEqual({ kind: 'pair', code: CODE });
  });

  it('rejects a pair path without a WS upgrade (426)', () => {
    expect(routeRequest('GET', `${BASE}/${CODE}`, false)).toEqual({ kind: 'reject', status: 426, reason: 'expected-websocket-upgrade' });
  });

  it('rejects an upgrade to an invalid code (404)', () => {
    expect(routeRequest('GET', `${BASE}/tooshort`, true)).toEqual({ kind: 'reject', status: 404, reason: 'invalid-session-code' });
  });

  it('rejects a malformed URL (400) without throwing', () => {
    expect(routeRequest('GET', 'not a url', true)).toEqual({ kind: 'reject', status: 400, reason: 'bad-url' });
  });
});
