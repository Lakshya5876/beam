/**
 * Session lifecycle use-case (design doc §10 S11). Orchestrates the Session
 * ENTITY (S2) over the SignalingClient seam (S3) — it never re-implements the
 * state machine; every transition goes through S2's pure functions and emits
 * the resulting domain event.
 *
 * Application layer: domain entities + infrastructure INTERFACES only; time is
 * injected (no Date.now). The concrete signaling<->peer SDP/ICE wiring lives
 * in S12/composition (it needs the concrete peer-connection methods that are
 * not on the PeerTransport interface); this use-case takes connection
 * OUTCOMES (markEstablished / markFailed) and drives the entity accordingly.
 */

import {
  close,
  createSession,
  createSessionCode,
  establish,
  fail,
  isExpired as isSessionExpired,
  isInvalidSessionCodeError,
  isInvalidTransitionError,
  isInvalidTtlError,
  type InvalidSessionCodeError,
  type InvalidTransitionError,
  type InvalidTtlError,
  type Session,
  type SessionEvent,
  type SessionState,
} from '../domain/session.js';
import {
  err,
  ok,
  type Result,
  type SignalingClient,
  type SignalingConnectError,
  type Unsubscribe,
} from '../domain/interfaces.js';

export type StartSessionError = InvalidSessionCodeError | InvalidTtlError | SignalingConnectError;

export interface NoActiveSessionError {
  readonly error: 'NoActiveSession';
}

export type SessionTransitionError = InvalidTransitionError | NoActiveSessionError;

function noActiveSession(): NoActiveSessionError {
  return { error: 'NoActiveSession' };
}

export class ExecuteSessionUseCase {
  private session: Session | null = null;
  private readonly eventHandlers: Array<(event: SessionEvent) => void> = [];

  constructor(
    private readonly signaling: SignalingClient,
    private readonly now: () => number,
  ) {}

  async startSession(rawCode: string, ttlMs?: number): Promise<Result<undefined, StartSessionError>> {
    const code = createSessionCode(rawCode);
    if (isInvalidSessionCodeError(code)) {
      return err(code);
    }
    const session = createSession(code, this.now(), ttlMs);
    if (isInvalidTtlError(session)) {
      return err(session);
    }
    const connected = await this.signaling.connect(code);
    if (!connected.ok) {
      return err(connected.error);
    }
    this.session = session;
    return ok();
  }

  markEstablished(): Result<undefined, SessionTransitionError> {
    if (!this.session) {
      return err(noActiveSession());
    }
    const result = establish(this.session, this.now());
    if (isInvalidTransitionError(result)) {
      return err(result);
    }
    this.session = result.session;
    this.emit(result.event);
    return ok();
  }

  async markFailed(reason: string): Promise<Result<undefined, SessionTransitionError>> {
    if (!this.session) {
      return err(noActiveSession());
    }
    const result = fail(this.session, this.now(), reason);
    if (isInvalidTransitionError(result)) {
      return err(result);
    }
    this.session = result.session;
    this.emit(result.event);
    await this.signaling.disconnect();
    return ok();
  }

  async closeSession(reason: string): Promise<Result<undefined, SessionTransitionError>> {
    if (!this.session) {
      return err(noActiveSession());
    }
    const result = close(this.session, this.now(), reason);
    if (isInvalidTransitionError(result)) {
      return err(result);
    }
    this.session = result.session;
    this.emit(result.event);
    await this.signaling.disconnect();
    return ok();
  }

  isExpired(nowMs: number): boolean {
    return this.session ? isSessionExpired(this.session, nowMs) : false;
  }

  state(): SessionState | 'none' {
    return this.session?.state ?? 'none';
  }

  onEvent(handler: (event: SessionEvent) => void): Unsubscribe {
    this.eventHandlers.push(handler);
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index >= 0) {
        this.eventHandlers.splice(index, 1);
      }
    };
  }

  private emit(event: SessionEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}
