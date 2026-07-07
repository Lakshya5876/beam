import { describe, expect, it } from 'vitest';
import {
  candidateType,
  createTimestampedLogger,
  describeSessionEvent,
  explainConnectFailure,
} from '../../src/presentation/debug-log.js';
import type { SessionEvent } from '../../src/domain/session.js';
import type { SessionCode } from '../../src/domain/session.js';

const CODE = 'abcdefghijklmnopqrstuvwxyz' as SessionCode;

describe('createTimestampedLogger — connection timeline', () => {
  it('prefixes elapsed seconds since logger creation', () => {
    const lines: string[] = [];
    let clock = 1000;
    const log = createTimestampedLogger((line) => lines.push(line), () => clock);

    log('[HOST-PC] start');
    clock += 1234;
    log('[HOST-PC] DataChannel OPEN');

    expect(lines[0]).toBe('[+0.000s] [HOST-PC] start');
    expect(lines[1]).toBe('[+1.234s] [HOST-PC] DataChannel OPEN');
  });
});

describe('candidateType — ICE candidate classification', () => {
  it('classifies host, srflx, prflx, and relay candidates', () => {
    expect(candidateType('candidate:1 1 UDP 2122317823 192.168.1.5 54400 typ host')).toBe('host');
    expect(candidateType('candidate:2 1 UDP 1686052607 203.0.113.9 54400 typ srflx raddr 0.0.0.0')).toBe('srflx');
    expect(candidateType('candidate:3 1 UDP 1685790463 203.0.113.9 61000 typ prflx')).toBe('prflx');
    expect(candidateType('candidate:4 1 UDP 41885439 198.51.100.4 3478 typ relay raddr')).toBe('relay');
  });

  it('returns null for a string without a typ field', () => {
    expect(candidateType('not a candidate')).toBeNull();
  });
});

describe('explainConnectFailure — human-readable reasons', () => {
  it('explains no-viable-candidate with NAT/STUN causes', () => {
    const text = explainConnectFailure('no-viable-candidate');
    expect(text).toContain('ICE failed');
    expect(text).toContain('symmetric NAT');
    expect(text).toContain('BEAM_ICE_SERVERS');
  });

  it('explains connect-timeout with viewer/PIN causes', () => {
    const text = explainConnectFailure('connect-timeout');
    expect(text).toContain('handshake');
    expect(text).toContain('PIN');
  });

  it('explains closed-before-open', () => {
    expect(explainConnectFailure('closed-before-open')).toContain('closed before');
  });

  it('passes through unknown reasons verbatim', () => {
    expect(explainConnectFailure('weird-new-reason')).toContain('weird-new-reason');
  });
});

describe('describeSessionEvent — CLI status lines', () => {
  it('renders SessionEstablished as a connected line', () => {
    const event: SessionEvent = { event: 'SessionEstablished', code: CODE, atMs: 0 };
    expect(describeSessionEvent(event)).toContain('Peer connected');
  });

  it('renders SessionFailed with the failure explanation', () => {
    const event: SessionEvent = { event: 'SessionFailed', code: CODE, atMs: 0, reason: 'no-viable-candidate' };
    const line = describeSessionEvent(event);
    expect(line).toContain('Connection failed');
    expect(line).toContain('symmetric NAT');
  });

  it('renders SessionClosed with the reason', () => {
    const event: SessionEvent = { event: 'SessionClosed', code: CODE, atMs: 0, reason: 'host interrupted (SIGINT)' };
    expect(describeSessionEvent(event)).toContain('host interrupted (SIGINT)');
  });
});
