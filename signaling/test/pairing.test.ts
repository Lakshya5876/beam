import { describe, expect, it } from 'vitest';
import { assignRole, relayTargetRole } from '../src/pairing.js';

describe('assignRole', () => {
  it('assigns host to the first peer, viewer to the second', () => {
    expect(assignRole([])).toEqual({ ok: true, role: 'host' });
    expect(assignRole(['host'])).toEqual({ ok: true, role: 'viewer' });
  });

  it('rejects a third peer as session-full', () => {
    expect(assignRole(['host', 'viewer'])).toEqual({ ok: false, reason: 'session-full' });
  });

  it('fills the missing role if a peer left (host slot free)', () => {
    expect(assignRole(['viewer'])).toEqual({ ok: true, role: 'host' });
  });
});

describe('relayTargetRole', () => {
  it('relays host -> viewer and viewer -> host', () => {
    expect(relayTargetRole('host')).toBe('viewer');
    expect(relayTargetRole('viewer')).toBe('host');
  });
});
