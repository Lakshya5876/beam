/**
 * Session entity and lifecycle (design doc §10 S2, §5).
 * Pure domain: no clock (time is injected per call), no randomness, no I/O.
 * SessionCode is VALIDATED here, never generated — generation is an
 * Infrastructure concern (signaling server, S14).
 *
 * State machine:
 *   pending -> established -> closed
 *   pending -> failed
 *   pending -> closed   (host may Ctrl-C before a viewer ever connects)
 * closed and failed are terminal.
 */

/**
 * Lowercase alphanumeric, minimum 26 chars: log2(36^26) ≈ 134 bits — meets
 * the ≥128-bit entropy floor (design §5) for a code drawn from a CSPRNG.
 */
const SESSION_CODE_PATTERN = /^[a-z0-9]{26,}$/;

export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

declare const sessionCodeBrand: unique symbol;
export type SessionCode = string & { readonly [sessionCodeBrand]: true };

export interface InvalidSessionCodeError {
  readonly error: 'InvalidSessionCode';
  readonly reason: string;
}

export function createSessionCode(raw: string): SessionCode | InvalidSessionCodeError {
  if (raw.length === 0) {
    return { error: 'InvalidSessionCode', reason: 'code is empty' };
  }
  if (!SESSION_CODE_PATTERN.test(raw)) {
    return {
      error: 'InvalidSessionCode',
      reason: 'code must be lowercase alphanumeric with at least 26 characters (>=128 bits of entropy)',
    };
  }
  return raw as SessionCode;
}

export function isInvalidSessionCodeError(value: unknown): value is InvalidSessionCodeError {
  return typeof value === 'object' && value !== null && (value as InvalidSessionCodeError).error === 'InvalidSessionCode';
}

export type SessionState = 'pending' | 'established' | 'closed' | 'failed';

export interface Session {
  readonly code: SessionCode;
  readonly state: SessionState;
  readonly createdAtMs: number;
  readonly ttlMs: number;
}

export interface InvalidTtlError {
  readonly error: 'InvalidTtl';
  readonly ttlMs: number;
  readonly maxTtlMs: number;
  readonly reason: string;
}

export function isInvalidTtlError(value: unknown): value is InvalidTtlError {
  return typeof value === 'object' && value !== null && (value as InvalidTtlError).error === 'InvalidTtl';
}

export function createSession(code: SessionCode, createdAtMs: number, ttlMs?: number): Session | InvalidTtlError {
  const effectiveTtl = ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(effectiveTtl) || effectiveTtl <= 0) {
    return { error: 'InvalidTtl', ttlMs: effectiveTtl, maxTtlMs: DEFAULT_SESSION_TTL_MS, reason: 'ttl must be a positive integer' };
  }
  if (effectiveTtl > DEFAULT_SESSION_TTL_MS) {
    return {
      error: 'InvalidTtl',
      ttlMs: effectiveTtl,
      maxTtlMs: DEFAULT_SESSION_TTL_MS,
      reason: 'ttl is configurable down from the default, never up',
    };
  }
  return Object.freeze({ code, state: 'pending', createdAtMs, ttlMs: effectiveTtl });
}

export interface SessionEstablished {
  readonly event: 'SessionEstablished';
  readonly code: SessionCode;
  readonly atMs: number;
}

export interface SessionClosed {
  readonly event: 'SessionClosed';
  readonly code: SessionCode;
  readonly atMs: number;
  readonly reason: string;
}

export interface SessionFailed {
  readonly event: 'SessionFailed';
  readonly code: SessionCode;
  readonly atMs: number;
  readonly reason: string;
}

export type SessionEvent = SessionEstablished | SessionClosed | SessionFailed;

export interface InvalidTransitionError {
  readonly error: 'InvalidTransition';
  readonly from: SessionState;
  readonly attempted: 'establish' | 'close' | 'fail';
}

export function isInvalidTransitionError(value: unknown): value is InvalidTransitionError {
  return typeof value === 'object' && value !== null && (value as InvalidTransitionError).error === 'InvalidTransition';
}

export interface TransitionResult<E extends SessionEvent> {
  readonly session: Session;
  readonly event: E;
}

export function establish(session: Session, atMs: number): TransitionResult<SessionEstablished> | InvalidTransitionError {
  if (session.state !== 'pending') {
    return { error: 'InvalidTransition', from: session.state, attempted: 'establish' };
  }
  return {
    session: Object.freeze({ ...session, state: 'established' as const }),
    event: { event: 'SessionEstablished', code: session.code, atMs },
  };
}

export function close(session: Session, atMs: number, reason: string): TransitionResult<SessionClosed> | InvalidTransitionError {
  if (session.state !== 'pending' && session.state !== 'established') {
    return { error: 'InvalidTransition', from: session.state, attempted: 'close' };
  }
  return {
    session: Object.freeze({ ...session, state: 'closed' as const }),
    event: { event: 'SessionClosed', code: session.code, atMs, reason },
  };
}

export function fail(session: Session, atMs: number, reason: string): TransitionResult<SessionFailed> | InvalidTransitionError {
  if (session.state !== 'pending') {
    return { error: 'InvalidTransition', from: session.state, attempted: 'fail' };
  }
  return {
    session: Object.freeze({ ...session, state: 'failed' as const }),
    event: { event: 'SessionFailed', code: session.code, atMs, reason },
  };
}

/** Expired AT the boundary: nowMs >= createdAtMs + ttlMs. */
export function isExpired(session: Session, nowMs: number): boolean {
  return nowMs >= session.createdAtMs + session.ttlMs;
}
