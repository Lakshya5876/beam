import { describe, expect, it } from 'vitest';
import {
  FrameType,
  MAX_PAYLOAD_SIZE,
  createFramePayload,
  createStreamId,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
  type StreamId,
} from '../../src/domain/frame.js';
import {
  err,
  ok,
  type PeerTransport,
  type Result,
  type TransportClosedError,
  type Unsubscribe,
} from '../../src/domain/interfaces.js';
// Result is used by FakeTransport.send's return annotation.
import {
  DEFAULT_MULTIPLEXER_LIMITS,
  StreamMultiplexer,
  isStreamLimitError,
  isStreamRejectedError,
  type MultiplexerLimits,
} from '../../src/application/protocol.js';

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: invalid stream id');
  }
  return id;
}

function frame(type: FrameType, streamId: number, byteLength = 3): Frame {
  const payload = createFramePayload(new Uint8Array(byteLength));
  if (isPayloadTooLargeError(payload)) {
    throw new Error('test setup: payload too large');
  }
  return { type, streamId: sid(streamId), payload };
}

class FakeTransport implements PeerTransport {
  public readonly sent: Frame[] = [];
  private frameHandler: ((frame: Frame) => void) | null = null;
  private buffered = 0;
  private open = true;

  send(f: Frame): Result<undefined, TransportClosedError> {
    if (!this.open) {
      return err({ error: 'TransportClosed' });
    }
    this.sent.push(f);
    return ok();
  }

  onFrame(handler: (frame: Frame) => void): Unsubscribe {
    this.frameHandler = handler;
    return () => {
      this.frameHandler = null;
    };
  }

  onClose(): Unsubscribe {
    return () => undefined;
  }

  close(): void {
    this.open = false;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  // Test affordances.
  setBuffered(n: number): void {
    this.buffered = n;
  }

  emit(f: Frame): void {
    this.frameHandler?.(f);
  }

  errorFrames(): Frame[] {
    return this.sent.filter((s) => s.type === FrameType.ERROR);
  }
}

function tinyLimits(overrides: Partial<MultiplexerLimits>): MultiplexerLimits {
  return { ...DEFAULT_MULTIPLEXER_LIMITS, ...overrides };
}

describe('outbound multiplexing', () => {
  it('openStream allocates monotonic ids and never reuses a live id', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    const a = mux.openStream();
    const b = mux.openStream();
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value).toBe(a.value + 1);
      expect(a.value).not.toBe(b.value);
    }
  });

  it('interleaves two streams\' frames on the one transport in send order', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const a = mux.openStream();
    const b = mux.openStream();
    if (!a.ok || !b.ok) {
      throw new Error('setup: openStream failed');
    }
    mux.writeFrame(frame(FrameType.REQUEST_HEAD, a.value));
    mux.writeFrame(frame(FrameType.REQUEST_HEAD, b.value));
    mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, a.value));
    expect(transport.sent.map((f) => f.streamId)).toEqual([a.value, b.value, a.value]);
  });

  it('writeFrame on a non-open stream is a typed rejection', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    const result = mux.writeFrame(frame(FrameType.REQUEST_HEAD, 999));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isStreamRejectedError(result.error)).toBe(true);
      if (isStreamRejectedError(result.error)) {
        expect(result.error.reason).toBe('not-open');
      }
    }
  });

  it('writeFrame propagates TransportClosed', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const a = mux.openStream();
    if (!a.ok) {
      throw new Error('setup');
    }
    transport.close();
    const result = mux.writeFrame(frame(FrameType.REQUEST_HEAD, a.value));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'TransportClosed' });
    }
  });
});

describe('inbound demultiplexing and stream-id hygiene', () => {
  it('dispatches an inbound frame to the registered handler by streamId', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const received: Frame[] = [];
    mux.onInbound((f) => received.push(f));
    transport.emit(frame(FrameType.REQUEST_HEAD, 8));
    expect(received).toHaveLength(1);
    expect(received[0]?.streamId).toBe(8);
  });

  it('onInbound unsubscribe stops further delivery', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const received: Frame[] = [];
    const unsubscribe = mux.onInbound((f) => received.push(f));
    transport.emit(frame(FrameType.REQUEST_HEAD, 4));
    unsubscribe();
    transport.emit(frame(FrameType.REQUEST_BODY_CHUNK, 4));
    expect(received).toHaveLength(1);
  });

  it('an unknown inbound id UNDER the cap opens a new inbound stream', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    const result = mux.acceptInbound(frame(FrameType.REQUEST_HEAD, 50));
    expect(result.ok).toBe(true);
    expect(mux.openCount()).toBe(1);
  });

  it('an unknown inbound id AT the cap is rejected and ERROR-framed (no allocation)', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ maxConcurrentStreams: 1 }));
    expect(mux.acceptInbound(frame(FrameType.REQUEST_HEAD, 1)).ok).toBe(true);
    const rejected = mux.acceptInbound(frame(FrameType.REQUEST_HEAD, 2));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.reason).toBe('concurrency-cap');
    }
    expect(mux.openCount()).toBe(1);
    expect(transport.errorFrames().map((f) => f.streamId)).toEqual([2]);
  });

  it('REQUEST_END closes only the inbound half — later inbound is rejected, the stream stays live', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    expect(mux.acceptInbound(frame(FrameType.REQUEST_HEAD, 7)).ok).toBe(true);
    expect(mux.acceptInbound(frame(FrameType.REQUEST_END, 7)).ok).toBe(true);
    // A later INBOUND frame is rejected — the inbound half is closed.
    const afterEnd = mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 7));
    expect(afterEnd.ok).toBe(false);
    if (!afterEnd.ok) {
      expect(afterEnd.error.reason).toBe('closed');
    }
    // Half-close: the stream is still LIVE (outbound half open), so openCount
    // is 1 (was 0 under the old full-close-on-END semantics) and the response
    // can still be written on the same id.
    expect(mux.openCount()).toBe(1);
    expect(mux.writeFrame(frame(FrameType.RESPONSE_HEAD, 7)).ok).toBe(true);
  });
});

describe('half-close lifecycle', () => {
  it('writes a full response on the same stream id after REQUEST_END, then RESPONSE_END retires it', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    expect(mux.acceptInbound(frame(FrameType.REQUEST_HEAD, 7)).ok).toBe(true);
    expect(mux.acceptInbound(frame(FrameType.REQUEST_END, 7)).ok).toBe(true);
    expect(mux.writeFrame(frame(FrameType.RESPONSE_HEAD, 7)).ok).toBe(true);
    expect(mux.writeFrame(frame(FrameType.RESPONSE_BODY_CHUNK, 7)).ok).toBe(true);
    // Outbound half still open after non-end frames → still live.
    expect(mux.openCount()).toBe(1);
    // RESPONSE_END closes the outbound half → both halves closed → retired.
    expect(mux.writeFrame(frame(FrameType.RESPONSE_END, 7)).ok).toBe(true);
    expect(mux.openCount()).toBe(0);
    // A further write on the retired id is rejected not-open.
    const afterRetire = mux.writeFrame(frame(FrameType.RESPONSE_BODY_CHUNK, 7));
    expect(afterRetire.ok).toBe(false);
    if (!afterRetire.ok && isStreamRejectedError(afterRetire.error)) {
      expect(afterRetire.error.reason).toBe('not-open');
    }
    expect(transport.sent.map((f) => f.type)).toEqual([
      FrameType.RESPONSE_HEAD,
      FrameType.RESPONSE_BODY_CHUNK,
      FrameType.RESPONSE_END,
    ]);
  });

  it('symmetric: a locally-opened stream that sends REQUEST_END still accepts inbound responses until RESPONSE_END', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    const opened = mux.openStream();
    if (!opened.ok) {
      throw new Error('setup: openStream');
    }
    const id = opened.value;
    expect(mux.writeFrame(frame(FrameType.REQUEST_HEAD, id)).ok).toBe(true);
    expect(mux.writeFrame(frame(FrameType.REQUEST_END, id)).ok).toBe(true);
    // Outbound half closed: a further outbound write is rejected not-open.
    expect(mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, id)).ok).toBe(false);
    // Inbound half still open: responses are still accepted, stream still live.
    expect(mux.openCount()).toBe(1);
    expect(mux.acceptInbound(frame(FrameType.RESPONSE_HEAD, id)).ok).toBe(true);
    expect(mux.acceptInbound(frame(FrameType.RESPONSE_END, id)).ok).toBe(true);
    // Both halves closed → retired; a new inbound frame is rejected 'closed'.
    expect(mux.openCount()).toBe(0);
    const afterRetire = mux.acceptInbound(frame(FrameType.RESPONSE_BODY_CHUNK, id));
    expect(afterRetire.ok).toBe(false);
    if (!afterRetire.ok) {
      expect(afterRetire.error.reason).toBe('closed');
    }
  });
});

describe('concurrency cap', () => {
  it('openStream at MAX_CONCURRENT_STREAMS returns a typed StreamLimitError', () => {
    const mux = new StreamMultiplexer(new FakeTransport(), tinyLimits({ maxConcurrentStreams: 2 }));
    expect(mux.openStream().ok).toBe(true);
    expect(mux.openStream().ok).toBe(true);
    const third = mux.openStream();
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(isStreamLimitError(third.error)).toBe(true);
      expect(third.error.reason).toBe('concurrency-cap');
    }
  });
});

describe('buffer caps', () => {
  it('a stream exceeding MAX_STREAM_BUFFER_BYTES is terminated with ERROR + close', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ maxStreamBufferBytes: 10 }));
    expect(mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 3, 6)).ok).toBe(true);
    const overflow = mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 3, 6));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.reason).toBe('stream-buffer-cap');
    }
    expect(mux.openCount()).toBe(0);
    expect(transport.errorFrames().map((f) => f.streamId)).toEqual([3]);
  });

  it('total buffered exceeding MAX_TOTAL_BUFFER_BYTES terminates the offending stream', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(
      transport,
      tinyLimits({ maxStreamBufferBytes: 100, maxTotalBufferBytes: 10 }),
    );
    expect(mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 1, 6)).ok).toBe(true);
    const overflow = mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 2, 6));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.reason).toBe('total-buffer-cap');
    }
    expect(transport.errorFrames().map((f) => f.streamId)).toEqual([2]);
  });
});

describe('WS_MESSAGE_END releases buffer without closing the stream (a long-lived WS connection)', () => {
  it('many small messages over time never trip the per-stream buffer cap, unlike one big HTTP body would', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ maxStreamBufferBytes: 10, maxTotalBufferBytes: 10 }));
    // Each message is under the cap; WS_MESSAGE_END must release its bytes so
    // the NEXT message starts from zero — otherwise a healthy, long-lived WS
    // connection would eventually trip the cap on cumulative traffic alone.
    for (let i = 0; i < 50; i += 1) {
      const head = mux.acceptInbound(frame(FrameType.WS_MESSAGE_HEAD, 9, 1));
      expect(head.ok).toBe(true);
      const chunk = mux.acceptInbound(frame(FrameType.WS_MESSAGE_CHUNK, 9, 6));
      expect(chunk.ok).toBe(true);
      const end = mux.acceptInbound(frame(FrameType.WS_MESSAGE_END, 9, 0));
      expect(end.ok).toBe(true);
    }
    expect(mux.openCount()).toBe(1); // still open — WS_MESSAGE_END is not a half-close
    expect(transport.errorFrames()).toHaveLength(0);
  });

  it('a SINGLE message exceeding the per-stream cap is still rejected (the cap bounds one message, not the connection)', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ maxStreamBufferBytes: 10 }));
    expect(mux.acceptInbound(frame(FrameType.WS_MESSAGE_HEAD, 9, 1)).ok).toBe(true);
    expect(mux.acceptInbound(frame(FrameType.WS_MESSAGE_CHUNK, 9, 6)).ok).toBe(true);
    const overflow = mux.acceptInbound(frame(FrameType.WS_MESSAGE_CHUNK, 9, 6));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.reason).toBe('stream-buffer-cap');
    }
  });

  it('WS_CLOSE closes its half like REQUEST_END/RESPONSE_END — both directions closing fully retires the stream', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    expect(mux.acceptInbound(frame(FrameType.WS_CONNECT, 9, 4)).ok).toBe(true);
    expect(mux.openCount()).toBe(1);
    // Inbound WS_CLOSE alone only closes the INBOUND half — same half-close
    // model as REQUEST_END/RESPONSE_END: the stream stays "open" until the
    // OTHER half closes too (here, this side sending its own WS_CLOSE).
    expect(mux.acceptInbound(frame(FrameType.WS_CLOSE, 9, 4)).ok).toBe(true);
    expect(mux.openCount()).toBe(1);
    expect(mux.writeFrame(frame(FrameType.WS_CLOSE, 9, 4)).ok).toBe(true);
    expect(mux.openCount()).toBe(0);
  });
});

describe('backpressure hysteresis (high/low-water gap)', () => {
  it('over-high pauses, drained-to-between STAYS paused, below-low resumes', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ highWaterMark: 1000, lowWaterMark: 200 }));
    const events: string[] = [];
    mux.onPause(() => events.push('pause'));
    mux.onResume(() => events.push('resume'));
    const a = mux.openStream();
    if (!a.ok) {
      throw new Error('setup');
    }

    // Below high: no pause.
    transport.setBuffered(500);
    mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, a.value));
    expect(mux.isPaused()).toBe(false);

    // At/over high: pause fires.
    transport.setBuffered(1000);
    mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, a.value));
    expect(mux.isPaused()).toBe(true);

    // Drained into the hysteresis gap (between low and high): STAYS paused.
    transport.setBuffered(500);
    mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, a.value));
    expect(mux.isPaused()).toBe(true);

    // Below low: resume fires.
    transport.setBuffered(200);
    mux.writeFrame(frame(FrameType.REQUEST_BODY_CHUNK, a.value));
    expect(mux.isPaused()).toBe(false);

    expect(events).toEqual(['pause', 'resume']);
  });
});

describe('totality under an adversarial frame flood', () => {
  it('never throws and returns a typed rejection for every hostile frame', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport, tinyLimits({ maxConcurrentStreams: 4, maxStreamBufferBytes: 8 }));

    const hostile: Frame[] = [];
    // Close stream 9, then keep hammering it (post-END resurrection attempts).
    hostile.push(frame(FrameType.REQUEST_HEAD, 9));
    hostile.push(frame(FrameType.REQUEST_END, 9));
    for (let i = 0; i < 20; i += 1) {
      hostile.push(frame(FrameType.REQUEST_BODY_CHUNK, 9));
    }
    // Oversized bodies on a fresh stream beyond its buffer cap. This stream
    // self-terminates (freeing its slot) BEFORE the concurrency flood below,
    // so the buffer-cap path is genuinely exercised, not masked by the cap.
    for (let i = 0; i < 10; i += 1) {
      hostile.push(frame(FrameType.RESPONSE_BODY_CHUNK, 200, 6));
    }
    // Flood of unknown ids beyond the concurrency cap.
    for (let i = 100; i < 130; i += 1) {
      hostile.push(frame(FrameType.REQUEST_HEAD, i));
    }

    const rejections: string[] = [];
    expect(() => {
      for (const f of hostile) {
        const result = mux.acceptInbound(f);
        if (!result.ok) {
          rejections.push(result.error.reason);
        }
      }
    }).not.toThrow();

    // The 20 post-END frames on stream 9 are all rejected as closed; stream
    // 200's frames after its termination are closed too — so at least 20.
    expect(rejections.filter((r) => r === 'closed').length).toBeGreaterThanOrEqual(20);
    // The buffer cap terminates the offending stream exactly once (the
    // boundary frame); every later frame on it is then 'closed', not re-capped.
    expect(rejections.filter((r) => r === 'stream-buffer-cap')).toHaveLength(1);
    // Concurrency cap held: no more than the cap of streams open at any time.
    expect(mux.openCount()).toBeLessThanOrEqual(4);
    // Unknown-id frames hit the concurrency cap once it filled.
    expect(rejections).toContain('concurrency-cap');
  });
});

describe('adoptStream — externally-assigned ids (SW-allocated on the viewer)', () => {
  it('adopts an id so writeFrame succeeds where it was rejected before', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    expect(mux.writeFrame(frame(FrameType.REQUEST_HEAD, 7)).ok).toBe(false);
    const adopted = mux.adoptStream(7);
    expect(adopted.ok).toBe(true);
    expect(mux.writeFrame(frame(FrameType.REQUEST_HEAD, 7)).ok).toBe(true);
    expect(transport.sent.map((f) => f.streamId)).toEqual([7]);
  });

  it('is idempotent for a live stream', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    expect(mux.adoptStream(3).ok).toBe(true);
    expect(mux.adoptStream(3).ok).toBe(true);
    expect(mux.openCount()).toBe(1);
  });

  it('keeps openStream monotonic past adopted ids (no reuse)', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    mux.adoptStream(5);
    const next = mux.openStream();
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.value).toBe(6);
    }
  });

  it('rejects an invalid id with a typed error', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    const zero = mux.adoptStream(0);
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error.reason).toBe('invalid-id');
    }
  });

  it('enforces the concurrency cap', () => {
    const mux = new StreamMultiplexer(new FakeTransport(), { ...DEFAULT_MULTIPLEXER_LIMITS, maxConcurrentStreams: 2 });
    expect(mux.adoptStream(1).ok).toBe(true);
    expect(mux.adoptStream(2).ok).toBe(true);
    const third = mux.adoptStream(3);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.reason).toBe('concurrency-cap');
    }
  });

  it('inbound responses route on an adopted stream', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    mux.adoptStream(9);
    const seen: number[] = [];
    mux.onInbound((f) => seen.push(f.streamId));
    transport.emit(frame(FrameType.RESPONSE_HEAD, 9));
    expect(seen).toEqual([9]);
  });
});

describe('releaseInbound — consumer-owned buffer accounting', () => {
  const CHUNK = MAX_PAYLOAD_SIZE;
  const PER_STREAM_CAP = 1024 * 1024;

  it('lets a stream carry far more than the per-stream cap when the consumer releases', () => {
    // The viewer forwards each response frame to the service worker and keeps
    // nothing. Before releaseInbound existed the cap counted a response's
    // cumulative size, so anything over 1 MiB was killed mid-body.
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const forwarded: Frame[] = [];
    mux.onInbound((f) => {
      forwarded.push(f);
      mux.releaseInbound(f);
    });

    let accepted = 0;
    for (let sent = 0; sent < 3 * PER_STREAM_CAP; sent += CHUNK) {
      if (mux.acceptInbound(frame(FrameType.RESPONSE_BODY_CHUNK, 1, CHUNK)).ok) accepted += 1;
    }

    expect(forwarded).toHaveLength(accepted);
    expect(accepted).toBeGreaterThan(Math.ceil(PER_STREAM_CAP / CHUNK));
    expect(transport.sent.filter((f) => f.type === FrameType.ERROR)).toHaveLength(0);
  });

  it('still enforces the cap for a consumer that does NOT release (the host)', () => {
    // The host accumulates REQUEST_* frames until REQUEST_END, so it really
    // does hold every byte — that protection must be untouched.
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    mux.onInbound(() => { /* holds the frame, releases nothing */ });

    let rejected = 0;
    for (let sent = 0; sent < 2 * PER_STREAM_CAP; sent += CHUNK) {
      if (!mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 1, CHUNK)).ok) rejected += 1;
    }

    expect(rejected).toBeGreaterThan(0);
  });

  it('is clamped: over-releasing never drives accounting negative', () => {
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const f = frame(FrameType.RESPONSE_BODY_CHUNK, 1, 1000);
    mux.acceptInbound(f);

    mux.releaseInbound(f);
    mux.releaseInbound(f);
    mux.releaseInbound(f);

    // Accounting intact: a fresh full-size stream is still accepted.
    expect(mux.acceptInbound(frame(FrameType.RESPONSE_BODY_CHUNK, 2, CHUNK)).ok).toBe(true);
  });

  it('releasing an unknown stream is a no-op', () => {
    const mux = new StreamMultiplexer(new FakeTransport());
    expect(() => { mux.releaseInbound(frame(FrameType.RESPONSE_BODY_CHUNK, 99, 10)); }).not.toThrow();
  });
});

describe('a tripped cap fails the local request instead of hanging it', () => {
  it('delivers an ERROR frame to LOCAL handlers, not only to the peer', () => {
    // Only the peer used to be told, so the pending fetch on this side waited
    // for a response that could never arrive until its own 30s timeout.
    const transport = new FakeTransport();
    const mux = new StreamMultiplexer(transport);
    const local: Frame[] = [];
    mux.onInbound((f) => local.push(f));

    for (let sent = 0; sent <= 1024 * 1024; sent += MAX_PAYLOAD_SIZE) {
      mux.acceptInbound(frame(FrameType.REQUEST_BODY_CHUNK, 1, MAX_PAYLOAD_SIZE));
    }

    const localErrors = local.filter((f) => f.type === FrameType.ERROR);
    expect(localErrors).toHaveLength(1);
    expect(new TextDecoder().decode(localErrors[0]!.payload)).toBe('stream-buffer-cap');
    // The peer is still told too, as before.
    expect(transport.sent.filter((f) => f.type === FrameType.ERROR)).toHaveLength(1);
  });
});
