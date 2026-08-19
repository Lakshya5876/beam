import { describe, expect, it } from 'vitest';
import {
  classifySelectedPath,
  ConnectionReport,
  describeFailure,
  isRelayOnlyRequested,
  type ConnectionFacts,
} from '../src/connection-report.js';

function facts(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    reachedStage: null,
    turnAvailable: false,
    turnDiagnostic: null,
    selectedPath: 'unknown',
    relayOnlyRequested: false,
    ...overrides,
  };
}

describe('ConnectionReport', () => {
  it('records the furthest stage reached', () => {
    const report = new ConnectionReport();
    report.reach('signaling-connect');
    report.reach('pin-verify');
    expect(report.facts().reachedStage).toBe('pin-verify');
  });

  it('never moves backwards on an out-of-order or repeated event', () => {
    const report = new ConnectionReport();
    report.reach('datachannel-open');
    report.reach('ice-connect');
    report.reach('signaling-connect');
    expect(report.facts().reachedStage).toBe('datachannel-open');
  });

  it('separates a transport failure from an application failure', () => {
    const report = new ConnectionReport();
    expect(report.transportEstablished()).toBe(false);
    report.reach('ice-connect');
    expect(report.transportEstablished()).toBe(false);
    report.reach('datachannel-open');
    expect(report.transportEstablished()).toBe(true);
  });

  it('captures the turn diagnostic and whether a relay server was present', () => {
    const report = new ConnectionReport();
    report.noteTurnState('provider-unreachable', false);
    expect(report.facts()).toMatchObject({ turnDiagnostic: 'provider-unreachable', turnAvailable: false });
  });

  it('captures the selected path and relay-only request', () => {
    const report = new ConnectionReport();
    report.noteSelectedPath('relay');
    report.noteRelayOnlyRequested();
    expect(report.facts()).toMatchObject({ selectedPath: 'relay', relayOnlyRequested: true });
  });
});

describe('describeFailure', () => {
  it('names the signaling server when nothing was reached', () => {
    expect(describeFailure(facts())).toContain('signaling server');
  });

  it('distinguishes a post-connect relay failure from a transport failure', () => {
    const transport = describeFailure(facts({ reachedStage: 'ice-connect' }));
    const application = describeFailure(facts({ reachedStage: 'datachannel-open' }));
    expect(transport).not.toEqual(application);
    expect(application).toContain('through the tunnel');
  });

  it('says plainly when no relay fallback was configured', () => {
    const message = describeFailure(facts({ reachedStage: 'ice-connect', turnDiagnostic: 'not-configured' }));
    expect(message).toContain('no relay server is configured');
  });

  it('surfaces a provider failure as the reason no relay was available', () => {
    const message = describeFailure(facts({ reachedStage: 'ice-connect', turnDiagnostic: 'provider-unreachable' }));
    expect(message).toContain('provider-unreachable');
  });

  it('reports both paths exhausted when a relay WAS available', () => {
    const message = describeFailure(
      facts({ reachedStage: 'ice-connect', turnAvailable: true, turnDiagnostic: 'available' }),
    );
    expect(message).toContain('directly or through the relay');
  });

  it('attributes a relay-only failure to the requested mode', () => {
    const message = describeFailure(
      facts({ reachedStage: 'ice-connect', turnAvailable: true, relayOnlyRequested: true }),
    );
    expect(message).toContain('relay-only mode');
  });

  it('tags every message with the stage for support', () => {
    for (const stage of ['signaling-connect', 'pin-verify', 'ice-connect', 'datachannel-open', 'relay-ready'] as const) {
      expect(describeFailure(facts({ reachedStage: stage }))).toContain(`[stage: ${stage}]`);
    }
  });
});

describe('isRelayOnlyRequested', () => {
  it('is true only for an explicit relay=1', () => {
    expect(isRelayOnlyRequested('?relay=1')).toBe(true);
    expect(isRelayOnlyRequested('?session=abc&relay=1')).toBe(true);
    expect(isRelayOnlyRequested('?relay=0')).toBe(false);
    expect(isRelayOnlyRequested('?relay=true')).toBe(false);
    expect(isRelayOnlyRequested('')).toBe(false);
  });
});

describe('classifySelectedPath', () => {
  it('treats a relay candidate on either end as a relayed path', () => {
    expect(classifySelectedPath('relay', 'host')).toBe('relay');
    expect(classifySelectedPath('host', 'relay')).toBe('relay');
  });

  it('treats host/srflx/prflx pairs as direct', () => {
    expect(classifySelectedPath('host', 'host')).toBe('direct');
    expect(classifySelectedPath('srflx', 'prflx')).toBe('direct');
  });

  it('is unknown when the browser exposes neither end', () => {
    expect(classifySelectedPath(undefined, undefined)).toBe('unknown');
  });
});
