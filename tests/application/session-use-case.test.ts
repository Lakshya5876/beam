import { describe, expect, it } from 'vitest';
import {
  err,
  ok,
  type Result,
  type SignalingClient,
  type SignalingConnectError,
  type SignalingNotConnectedError,
  type Unsubscribe,
} from '../../src/domain/interfaces.js';
import type { SessionCode } from '../../src/domain/session.js';
import type { SessionEvent } from '../../src/domain/session.js';
import { ExecuteSessionUseCase } from '../../src/application/session-use-case.js';

const VALID_CODE = 'k7x2m9q4w8r3t6y1u5z0a2b4c7';

// Reuses the S3 FakeSignalingClient pattern (tests/domain/interfaces.test.ts):
// a class implementing SignalingClient, here with a configurable connect
// result and recorded disconnect calls.
class FakeSignalingClient implements SignalingClient {
  public connectedWith: SessionCode | null = null;
  public disconnectCalls = 0;
  constructor(private readonly connectResult: Result<undefined, SignalingConnectError> = ok()) {}

  connect(code: SessionCode): Promise<Result<undefined, SignalingConnectError>> {
    if (this.connectResult.ok) {
      this.connectedWith = code;
    }
    return Promise.resolve(this.connectResult);
  }
  sendMessage(): Promise<Result<undefined, SignalingNotConnectedError>> {
    return Promise.resolve(ok());
  }
  onMessage(): Unsubscribe {
    return () => undefined;
  }
  disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    return Promise.resolve();
  }
}

function fixedClock(value = 1_000_000): () => number {
  return () => value;
}

async function startedSession(
  signaling: FakeSignalingClient = new FakeSignalingClient(),
  now: () => number = fixedClock(),
): Promise<{ useCase: ExecuteSessionUseCase; events: SessionEvent[]; signaling: FakeSignalingClient }> {
  const useCase = new ExecuteSessionUseCase(signaling, now);
  const events: SessionEvent[] = [];
  useCase.onEvent((e) => events.push(e));
  const result = await useCase.startSession(VALID_CODE);
  if (!result.ok) {
    throw new Error('test setup: startSession failed');
  }
  return { useCase, events, signaling };
}

describe('ExecuteSessionUseCase — startSession', () => {
  it('validates the code, creates a pending session, and connects signaling with that code', async () => {
    const signaling = new FakeSignalingClient();
    const useCase = new ExecuteSessionUseCase(signaling, fixedClock());
    const result = await useCase.startSession(VALID_CODE);
    expect(result.ok).toBe(true);
    expect(useCase.state()).toBe('pending');
    expect(signaling.connectedWith).toBe(VALID_CODE);
  });

  it('rejects an invalid session code (signaling never connected)', async () => {
    const signaling = new FakeSignalingClient();
    const useCase = new ExecuteSessionUseCase(signaling, fixedClock());
    const result = await useCase.startSession('too-short');
    expect(result.ok).toBe(false);
    expect(useCase.state()).toBe('none');
    expect(signaling.connectedWith).toBeNull();
  });

  it('rejects an invalid ttl', async () => {
    const useCase = new ExecuteSessionUseCase(new FakeSignalingClient(), fixedClock());
    const result = await useCase.startSession(VALID_CODE, -1);
    expect(result.ok).toBe(false);
  });

  it('surfaces a signaling connect failure as a typed error and stays sessionless', async () => {
    const signaling = new FakeSignalingClient(err({ error: 'SignalingConnectFailed', reason: 'dead' }));
    const useCase = new ExecuteSessionUseCase(signaling, fixedClock());
    const result = await useCase.startSession(VALID_CODE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('SignalingConnectFailed');
    }
    expect(useCase.state()).toBe('none');
  });
});

describe('ExecuteSessionUseCase — lifecycle transitions', () => {
  it('markEstablished moves pending -> established and emits SessionEstablished', async () => {
    const { useCase, events } = await startedSession(new FakeSignalingClient(), fixedClock(5_000));
    const result = useCase.markEstablished();
    expect(result.ok).toBe(true);
    expect(useCase.state()).toBe('established');
    expect(events).toEqual([{ event: 'SessionEstablished', code: VALID_CODE, atMs: 5_000 }]);
  });

  it('markFailed moves pending -> failed, emits SessionFailed, and disconnects signaling', async () => {
    const { useCase, events, signaling } = await startedSession(new FakeSignalingClient(), fixedClock(7_000));
    const result = await useCase.markFailed('no viable candidate');
    expect(result.ok).toBe(true);
    expect(useCase.state()).toBe('failed');
    expect(events).toEqual([{ event: 'SessionFailed', code: VALID_CODE, atMs: 7_000, reason: 'no viable candidate' }]);
    expect(signaling.disconnectCalls).toBe(1);
  });

  it('closeSession from established emits SessionClosed and disconnects', async () => {
    const { useCase, events, signaling } = await startedSession(new FakeSignalingClient(), fixedClock(9_000));
    useCase.markEstablished();
    const result = await useCase.closeSession('host interrupted');
    expect(result.ok).toBe(true);
    expect(useCase.state()).toBe('closed');
    expect(events.at(-1)).toEqual({ event: 'SessionClosed', code: VALID_CODE, atMs: 9_000, reason: 'host interrupted' });
    expect(signaling.disconnectCalls).toBe(1);
  });

  it('closeSession from pending is allowed (Ctrl-C before a viewer connects)', async () => {
    const { useCase } = await startedSession();
    const result = await useCase.closeSession('ctrl-c');
    expect(result.ok).toBe(true);
    expect(useCase.state()).toBe('closed');
  });

  it('an invalid transition returns a typed error and emits no event', async () => {
    const { useCase, events } = await startedSession();
    await useCase.closeSession('done');
    const eventsAfterClose = events.length;
    const result = useCase.markEstablished();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error === 'InvalidTransition' || result.error.error === 'NoActiveSession').toBe(true);
    }
    expect(events.length).toBe(eventsAfterClose);
  });

  it('transition methods return NoActiveSession before any session starts', () => {
    const useCase = new ExecuteSessionUseCase(new FakeSignalingClient(), fixedClock());
    const result = useCase.markEstablished();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('NoActiveSession');
    }
  });

  it('isExpired reflects the entity TTL with injected now', async () => {
    const { useCase } = await startedSession(new FakeSignalingClient(), fixedClock(1_000));
    // default TTL is 4h = 14_400_000ms from createdAt 1_000
    expect(useCase.isExpired(1_000 + 14_400_000 - 1)).toBe(false);
    expect(useCase.isExpired(1_000 + 14_400_000)).toBe(true);
  });
});
