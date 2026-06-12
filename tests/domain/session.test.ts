import { describe, expect, it } from 'vitest';
import {
  close,
  createSession,
  createSessionCode,
  DEFAULT_SESSION_TTL_MS,
  establish,
  fail,
  isExpired,
  isInvalidSessionCodeError,
  isInvalidTransitionError,
  isInvalidTtlError,
  type Session,
  type SessionCode,
} from '../../src/domain/session.js';

const VALID_CODE_RAW = 'k7x2m9q4w8r3t6y1u5z0a2b4c7';
const T0 = 1_750_000_000_000;

function mustCode(raw: string): SessionCode {
  const code = createSessionCode(raw);
  if (isInvalidSessionCodeError(code)) {
    throw new Error(`test setup: invalid session code ${raw}`);
  }
  return code;
}

function mustSession(ttlMs?: number): Session {
  const session = createSession(mustCode(VALID_CODE_RAW), T0, ttlMs);
  if (isInvalidTtlError(session)) {
    throw new Error('test setup: invalid ttl');
  }
  return session;
}

function mustEstablished(): Session {
  const result = establish(mustSession(), T0 + 1000);
  if (isInvalidTransitionError(result)) {
    throw new Error('test setup: establish failed');
  }
  return result.session;
}

describe('SessionCode validation', () => {
  it('accepts a 26-char lowercase alphanumeric token (>=128 bits entropy)', () => {
    expect(isInvalidSessionCodeError(createSessionCode(VALID_CODE_RAW))).toBe(false);
  });

  it('rejects an empty code', () => {
    const result = createSessionCode('');
    expect(isInvalidSessionCodeError(result)).toBe(true);
    if (isInvalidSessionCodeError(result)) {
      expect(result.reason).toBe('code is empty');
    }
  });

  it('rejects a code below the entropy length floor', () => {
    expect(isInvalidSessionCodeError(createSessionCode('abc123'))).toBe(true);
  });

  it('rejects uppercase and invalid charset', () => {
    expect(isInvalidSessionCodeError(createSessionCode(VALID_CODE_RAW.toUpperCase()))).toBe(true);
    expect(isInvalidSessionCodeError(createSessionCode('k7x2m9q4w8r3t6y1u5z0a2b4c-'))).toBe(true);
  });
});

describe('createSession TTL rules', () => {
  it('defaults TTL to 4 hours', () => {
    expect(mustSession().ttlMs).toBe(4 * 60 * 60 * 1000);
    expect(DEFAULT_SESSION_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('accepts a TTL below the default (configurable down)', () => {
    expect(mustSession(60_000).ttlMs).toBe(60_000);
  });

  it('rejects a TTL above the default (never up)', () => {
    const result = createSession(mustCode(VALID_CODE_RAW), T0, DEFAULT_SESSION_TTL_MS + 1);
    expect(isInvalidTtlError(result)).toBe(true);
    if (isInvalidTtlError(result)) {
      expect(result.maxTtlMs).toBe(DEFAULT_SESSION_TTL_MS);
    }
  });

  it('rejects zero, negative, and non-integer TTLs', () => {
    expect(isInvalidTtlError(createSession(mustCode(VALID_CODE_RAW), T0, 0))).toBe(true);
    expect(isInvalidTtlError(createSession(mustCode(VALID_CODE_RAW), T0, -1))).toBe(true);
    expect(isInvalidTtlError(createSession(mustCode(VALID_CODE_RAW), T0, 0.5))).toBe(true);
  });

  it('starts in pending state', () => {
    expect(mustSession().state).toBe('pending');
  });
});

describe('lifecycle transitions and domain events', () => {
  it('establish on pending succeeds and emits SessionEstablished', () => {
    const result = establish(mustSession(), T0 + 1500);
    expect(isInvalidTransitionError(result)).toBe(false);
    if (!isInvalidTransitionError(result)) {
      expect(result.session.state).toBe('established');
      expect(result.event).toEqual({ event: 'SessionEstablished', code: VALID_CODE_RAW, atMs: T0 + 1500 });
    }
  });

  it('close on established emits SessionClosed with the reason', () => {
    const result = close(mustEstablished(), T0 + 9000, 'host interrupted (Ctrl-C)');
    expect(isInvalidTransitionError(result)).toBe(false);
    if (!isInvalidTransitionError(result)) {
      expect(result.session.state).toBe('closed');
      expect(result.event).toEqual({
        event: 'SessionClosed',
        code: VALID_CODE_RAW,
        atMs: T0 + 9000,
        reason: 'host interrupted (Ctrl-C)',
      });
    }
  });

  it('close on pending is ALLOWED — host Ctrl-C before any viewer connects', () => {
    const result = close(mustSession(), T0 + 200, 'host interrupted before viewer joined');
    expect(isInvalidTransitionError(result)).toBe(false);
    if (!isInvalidTransitionError(result)) {
      expect(result.session.state).toBe('closed');
      expect(result.event.event).toBe('SessionClosed');
    }
  });

  it('fail on pending emits SessionFailed with the reason', () => {
    const result = fail(mustSession(), T0 + 15_000, 'ICE found no viable candidate pair');
    expect(isInvalidTransitionError(result)).toBe(false);
    if (!isInvalidTransitionError(result)) {
      expect(result.session.state).toBe('failed');
      expect(result.event).toEqual({
        event: 'SessionFailed',
        code: VALID_CODE_RAW,
        atMs: T0 + 15_000,
        reason: 'ICE found no viable candidate pair',
      });
    }
  });

  it('rejects establish on established', () => {
    const result = establish(mustEstablished(), T0 + 2000);
    expect(isInvalidTransitionError(result)).toBe(true);
    if (isInvalidTransitionError(result)) {
      expect(result.from).toBe('established');
      expect(result.attempted).toBe('establish');
    }
  });

  it('rejects establish and close on terminal states (closed, failed)', () => {
    const closed = close(mustEstablished(), T0 + 3000, 'done');
    const failed = fail(mustSession(), T0 + 3000, 'no path');
    if (isInvalidTransitionError(closed) || isInvalidTransitionError(failed)) {
      throw new Error('test setup: terminal transitions failed');
    }
    expect(isInvalidTransitionError(establish(closed.session, T0 + 4000))).toBe(true);
    expect(isInvalidTransitionError(close(closed.session, T0 + 4000, 'again'))).toBe(true);
    expect(isInvalidTransitionError(close(failed.session, T0 + 4000, 'after fail'))).toBe(true);
    expect(isInvalidTransitionError(establish(failed.session, T0 + 4000))).toBe(true);
  });

  it('rejects fail on established (failure is a setup-phase outcome)', () => {
    const result = fail(mustEstablished(), T0 + 5000, 'too late to fail');
    expect(isInvalidTransitionError(result)).toBe(true);
    if (isInvalidTransitionError(result)) {
      expect(result.from).toBe('established');
    }
  });

  it('transitions return a NEW session and never mutate the input', () => {
    const original = mustSession();
    const result = establish(original, T0 + 1000);
    expect(isInvalidTransitionError(result)).toBe(false);
    if (!isInvalidTransitionError(result)) {
      expect(original.state).toBe('pending');
      expect(result.session).not.toBe(original);
      expect(Object.isFrozen(result.session)).toBe(true);
      expect(Object.isFrozen(original)).toBe(true);
    }
  });
});

describe('isExpired — injected time, >= boundary', () => {
  it('is not expired strictly before the boundary', () => {
    const session = mustSession(60_000);
    expect(isExpired(session, T0 + 59_999)).toBe(false);
  });

  it('is expired exactly AT the boundary (>=, not >)', () => {
    const session = mustSession(60_000);
    expect(isExpired(session, T0 + 60_000)).toBe(true);
  });

  it('is expired after the boundary', () => {
    const session = mustSession(60_000);
    expect(isExpired(session, T0 + 60_001)).toBe(true);
  });
});
