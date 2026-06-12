import { describe, expect, it } from 'vitest';
import { FrameType, createFramePayload, createStreamId, isInvalidStreamIdError, isPayloadTooLargeError, type Frame, type StreamId } from '../../src/domain/frame.js';
import {
  err,
  ok,
  type PeerTransport,
  type ReplayClient,
  type ReplayRequest,
  type RequestLogRepository,
  type RequestRecord,
  type Result,
  type SignalingClient,
  type SignalingConnectError,
  type SignalingMessage,
  type SignalingNotConnectedError,
  type TransportClosedError,
  type Unsubscribe,
} from '../../src/domain/interfaces.js';
import { createSessionCode, isInvalidSessionCodeError, type SessionCode } from '../../src/domain/session.js';

function mustStreamId(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: invalid stream id');
  }
  return id;
}

function mustFrame(streamId: number): Frame {
  const payload = createFramePayload(new Uint8Array([1, 2, 3]));
  if (isPayloadTooLargeError(payload)) {
    throw new Error('test setup: payload too large');
  }
  return { type: FrameType.PING, streamId: mustStreamId(streamId), payload };
}

function mustCode(): SessionCode {
  const code = createSessionCode('k7x2m9q4w8r3t6y1u5z0a2b4c7');
  if (isInvalidSessionCodeError(code)) {
    throw new Error('test setup: invalid code');
  }
  return code;
}

class FakePeerTransport implements PeerTransport {
  private frameHandlers: Array<(frame: Frame) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private closed = false;
  private buffered = 0;

  send(frame: Frame): Result<undefined, TransportClosedError> {
    if (this.closed) {
      return err({ error: 'TransportClosed' });
    }
    this.buffered += frame.payload.byteLength;
    for (const handler of this.frameHandlers) {
      handler(frame);
    }
    return ok();
  }

  onFrame(handler: (frame: Frame) => void): Unsubscribe {
    this.frameHandlers.push(handler);
    return () => {
      this.frameHandlers = this.frameHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: (reason: string) => void): Unsubscribe {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  close(): void {
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler('closed by test');
    }
  }

  bufferedAmount(): number {
    return this.buffered;
  }
}

class FakeSignalingClient implements SignalingClient {
  private handlers: Array<(message: SignalingMessage) => void> = [];
  private connected = false;
  public connectedTo: SessionCode | null = null;

  connect(code: SessionCode): Promise<Result<undefined, SignalingConnectError>> {
    this.connected = true;
    this.connectedTo = code;
    return Promise.resolve(ok());
  }

  sendMessage(message: SignalingMessage): Promise<Result<undefined, SignalingNotConnectedError>> {
    if (!this.connected) {
      return Promise.resolve(err({ error: 'SignalingNotConnected' }));
    }
    for (const handler of this.handlers) {
      handler(message);
    }
    return Promise.resolve(ok());
  }

  onMessage(handler: (message: SignalingMessage) => void): Unsubscribe {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}

const fakeReplayClient: ReplayClient = {
  replay(request: ReplayRequest) {
    return Promise.resolve(
      ok({
        status: request.path === '/missing' ? 404 : 200,
        headers: { 'content-type': 'text/plain' },
        body: new TextEncoder().encode(`${request.method} ${request.path}`),
      }),
    );
  },
};

class FakeRequestLogRepository implements RequestLogRepository {
  private records: RequestRecord[] = [];

  persistRecord(record: RequestRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  fetchRecent(limit: number): Promise<readonly RequestRecord[]> {
    return Promise.resolve([...this.records].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, limit));
  }

  findByStreamId(streamId: StreamId): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.records.filter((r) => r.streamId === streamId));
  }
}

function makeRecord(streamId: number, timestampMs: number, path: string): RequestRecord {
  return {
    timestampMs,
    method: 'GET',
    path,
    status: 200,
    latencyMs: 12,
    responseSizeBytes: 348,
    streamId: mustStreamId(streamId),
  };
}

describe('PeerTransport seam', () => {
  it('delivers a sent frame to a subscribed onFrame handler and tracks bufferedAmount', () => {
    const transport = new FakePeerTransport();
    const received: Frame[] = [];
    transport.onFrame((frame) => received.push(frame));
    const frame = mustFrame(7);
    const result = transport.send(frame);
    expect(result.ok).toBe(true);
    expect(received).toEqual([frame]);
    expect(transport.bufferedAmount()).toBe(3);
  });

  it('fires onClose on close and send returns TransportClosed afterwards', () => {
    const transport = new FakePeerTransport();
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));
    transport.close();
    expect(reasons).toEqual(['closed by test']);
    const result = transport.send(mustFrame(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'TransportClosed' });
    }
  });

  it('unsubscribe stops frame delivery', () => {
    const transport = new FakePeerTransport();
    const received: Frame[] = [];
    const unsubscribe = transport.onFrame((frame) => received.push(frame));
    unsubscribe();
    transport.send(mustFrame(2));
    expect(received).toEqual([]);
  });
});

describe('SignalingClient seam', () => {
  it('connects with a session code and round-trips an opaque message', async () => {
    const signaling = new FakeSignalingClient();
    const code = mustCode();
    const connectResult = await signaling.connect(code);
    expect(connectResult.ok).toBe(true);
    expect(signaling.connectedTo).toBe(code);

    const received: SignalingMessage[] = [];
    signaling.onMessage((message) => received.push(message));
    const message: SignalingMessage = { kind: 'offer', payload: 'v=0 opaque-sdp-blob' };
    const sendResult = await signaling.sendMessage(message);
    expect(sendResult.ok).toBe(true);
    expect(received).toEqual([message]);
  });

  it('sendMessage after disconnect returns SignalingNotConnected', async () => {
    const signaling = new FakeSignalingClient();
    await signaling.connect(mustCode());
    await signaling.disconnect();
    const result = await signaling.sendMessage({ kind: 'ice-candidate', payload: 'candidate:0 opaque' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'SignalingNotConnected' });
    }
  });
});

describe('ReplayClient seam', () => {
  it('maps a domain request to a domain response', async () => {
    const result = await fakeReplayClient.replay({
      method: 'GET',
      path: '/api/items',
      headers: { accept: 'text/plain' },
      body: new Uint8Array(0),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(new TextDecoder().decode(result.value.body)).toBe('GET /api/items');
    }
  });
});

describe('RequestLogRepository seam', () => {
  it('persistRecord then fetchRecent returns newest-first with limit respected', async () => {
    const repository = new FakeRequestLogRepository();
    await repository.persistRecord(makeRecord(1, 1000, '/a'));
    await repository.persistRecord(makeRecord(2, 3000, '/c'));
    await repository.persistRecord(makeRecord(3, 2000, '/b'));
    const recent = await repository.fetchRecent(2);
    expect(recent.map((r) => r.path)).toEqual(['/c', '/b']);
  });

  it('findByStreamId returns matching records and empty for an unknown StreamId', async () => {
    const repository = new FakeRequestLogRepository();
    await repository.persistRecord(makeRecord(5, 1000, '/x'));
    await repository.persistRecord(makeRecord(5, 2000, '/y'));
    await repository.persistRecord(makeRecord(6, 3000, '/z'));
    const matching = await repository.findByStreamId(mustStreamId(5));
    expect(matching.map((r) => r.path)).toEqual(['/x', '/y']);
    expect(await repository.findByStreamId(mustStreamId(99))).toEqual([]);
  });
});

describe('Result helpers', () => {
  it('ok() carries undefined for void successes and ok(value) carries the value', () => {
    expect(ok()).toEqual({ ok: true, value: undefined });
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err(error) carries the typed error', () => {
    expect(err({ error: 'TransportClosed' })).toEqual({ ok: false, error: { error: 'TransportClosed' } });
  });
});
