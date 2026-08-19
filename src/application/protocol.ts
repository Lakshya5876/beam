/**
 * Stream multiplexer (design doc §4, §A.2.1, S4) — the crown jewel.
 *
 * Coordinates many concurrent HTTP request/response streams over ONE
 * PeerTransport. Application-layer coordination: it holds mutable per-stream
 * state and orchestrates a transport, depending ONLY on domain types and the
 * PeerTransport interface — never on WebRTC or any concrete channel.
 *
 * Security scope (the part deferred from S1, frame.ts is wire format only):
 *   - stream-id hygiene: known / unknown / closed handled explicitly
 *   - concurrency cap: bounded live streams, both locally- and remotely-opened
 *   - buffer caps: per-stream AND total, hard caps — never unbounded growth
 *   - backpressure: high/low-water hysteresis over transport.bufferedAmount()
 *   - totality: no inbound frame, however hostile, throws out of dispatch
 */

import {
  FrameType,
  createFramePayload,
  createStreamId,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
  type StreamId,
} from '../domain/frame.js';
import {
  err,
  ok,
  type PeerTransport,
  type Result,
  type TransportClosedError,
  type Unsubscribe,
} from '../domain/interfaces.js';

export const MAX_CONCURRENT_STREAMS = 256;
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
export const MAX_TOTAL_BUFFER_BYTES = 16 * 1024 * 1024;
export const HIGH_WATER_MARK = 1024 * 1024;
export const LOW_WATER_MARK = 256 * 1024;

export interface MultiplexerLimits {
  readonly maxConcurrentStreams: number;
  readonly maxStreamBufferBytes: number;
  readonly maxTotalBufferBytes: number;
  readonly highWaterMark: number;
  readonly lowWaterMark: number;
}

export const DEFAULT_MULTIPLEXER_LIMITS: MultiplexerLimits = {
  maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
  maxStreamBufferBytes: MAX_STREAM_BUFFER_BYTES,
  maxTotalBufferBytes: MAX_TOTAL_BUFFER_BYTES,
  highWaterMark: HIGH_WATER_MARK,
  lowWaterMark: LOW_WATER_MARK,
};

export type StreamRejectionReason =
  | 'closed'
  | 'not-open'
  | 'concurrency-cap'
  | 'stream-buffer-cap'
  | 'total-buffer-cap';

export interface StreamRejectedError {
  readonly error: 'StreamRejected';
  readonly streamId: number;
  readonly reason: StreamRejectionReason;
}

export interface StreamLimitError {
  readonly error: 'StreamLimitReached';
  readonly limit: number;
  readonly reason: 'concurrency-cap' | 'id-space-exhausted' | 'invalid-id';
}

export function isStreamRejectedError(value: unknown): value is StreamRejectedError {
  return typeof value === 'object' && value !== null && (value as StreamRejectedError).error === 'StreamRejected';
}

export function isStreamLimitError(value: unknown): value is StreamLimitError {
  return typeof value === 'object' && value !== null && (value as StreamLimitError).error === 'StreamLimitReached';
}

/**
 * Half-close model: a stream has two independently-closeable halves so a
 * request and its response can share one stream id. An end frame RECEIVED
 * closes the inbound half (and releases its buffered bytes); an end frame SENT
 * closes the outbound half. The stream is LIVE while either half is open and
 * fully retired only when both are closed.
 */
interface StreamState {
  inboundOpen: boolean;
  outboundOpen: boolean;
  bufferedBytes: number;
}

/** Closes a half outright: no more frames expected on it (HTTP) / the WS connection is done. */
function isEndFrame(type: FrameType): boolean {
  return type === FrameType.REQUEST_END || type === FrameType.RESPONSE_END || type === FrameType.WS_CLOSE;
}

/**
 * Releases this stream's buffered-byte accounting WITHOUT closing the half —
 * a WS connection stays open across many messages, so "buffered bytes"
 * must be scoped to the CURRENT message (bounding any single message's size)
 * rather than accumulating for the connection's whole lifetime, or a
 * long-lived, healthy WS connection would eventually trip the stream/total
 * buffer caps on cumulative traffic alone.
 */
function releasesBufferOnly(type: FrameType): boolean {
  return type === FrameType.WS_MESSAGE_END;
}

export class StreamMultiplexer {
  private readonly streams = new Map<number, StreamState>();
  private readonly inboundHandlers: Array<(frame: Frame) => void> = [];
  private readonly pauseHandlers: Array<() => void> = [];
  private readonly resumeHandlers: Array<() => void> = [];
  private readonly unsubscribeTransport: Unsubscribe;
  private nextId = 1;
  private totalBuffered = 0;
  private paused = false;

  constructor(
    private readonly transport: PeerTransport,
    private readonly limits: MultiplexerLimits = DEFAULT_MULTIPLEXER_LIMITS,
  ) {
    this.unsubscribeTransport = transport.onFrame((frame) => {
      this.acceptInbound(frame);
    });
  }

  /** Allocate a fresh locally-opened stream. Monotonic id, never reused. */
  openStream(): Result<StreamId, StreamLimitError> {
    if (this.openCount() >= this.limits.maxConcurrentStreams) {
      return err({ error: 'StreamLimitReached', limit: this.limits.maxConcurrentStreams, reason: 'concurrency-cap' });
    }
    const id = createStreamId(this.nextId);
    if (isInvalidStreamIdError(id)) {
      return err({ error: 'StreamLimitReached', limit: this.nextId, reason: 'id-space-exhausted' });
    }
    this.nextId += 1;
    this.streams.set(id, { inboundOpen: true, outboundOpen: true, bufferedBytes: 0 });
    return ok(id);
  }

  /**
   * Adopt an EXTERNALLY-assigned stream id for outbound use. The viewer's
   * service worker allocates its own ids per intercepted fetch, so the page
   * bridge must register them here before writeFrame — writeFrame on an
   * unknown id is rejected 'not-open' (silently dropping the request was the
   * first bug the local e2e harness caught). Idempotent for live streams;
   * keeps openStream()'s monotonic counter ahead of adopted ids.
   */
  adoptStream(rawId: number): Result<StreamId, StreamLimitError> {
    const id = createStreamId(rawId);
    if (isInvalidStreamIdError(id)) {
      return err({ error: 'StreamLimitReached', limit: this.limits.maxConcurrentStreams, reason: 'invalid-id' });
    }
    if (this.streams.has(rawId)) {
      return ok(id);
    }
    if (this.openCount() >= this.limits.maxConcurrentStreams) {
      return err({ error: 'StreamLimitReached', limit: this.limits.maxConcurrentStreams, reason: 'concurrency-cap' });
    }
    this.streams.set(id, { inboundOpen: true, outboundOpen: true, bufferedBytes: 0 });
    if (rawId >= this.nextId) {
      this.nextId = rawId + 1;
    }
    return ok(id);
  }

  /**
   * Write an outbound frame; succeeds while the OUTBOUND half is open —
   * including after the inbound half closed (a response on the same stream id
   * after REQUEST_END). Sending an end frame closes the outbound half.
   */
  writeFrame(frame: Frame): Result<undefined, StreamRejectedError | TransportClosedError> {
    const stream = this.streams.get(frame.streamId);
    if (!stream || !stream.outboundOpen) {
      return err({ error: 'StreamRejected', streamId: frame.streamId, reason: 'not-open' });
    }
    const sent = this.transport.send(frame);
    if (!sent.ok) {
      return sent;
    }
    if (isEndFrame(frame.type)) {
      stream.outboundOpen = false;
    }
    this.updateBackpressure();
    return ok();
  }

  /**
   * Inbound entry — total: every frame yields ok or a typed rejection, never
   * throws. Wired to transport.onFrame in the constructor.
   *
   * Buffered bytes accumulate until an end frame OR until the consumer calls
   * releaseInbound — see that method for why the choice belongs to the
   * consumer rather than being automatic here.
   */
  acceptInbound(frame: Frame): Result<undefined, StreamRejectedError> {
    const routed = this.routeInbound(frame);
    if (routed.ok) {
      this.deliver(frame);
    }
    return routed;
  }

  /**
   * Give back the accounting for a frame the consumer has finished with.
   *
   * The caps exist to stop a peer from making THIS side hold unbounded data,
   * so they must count what is actually still held — which only the consumer
   * knows. The two consumers differ:
   *
   *   - The host accumulates REQUEST_* frames until REQUEST_END before it can
   *     assemble them, so it genuinely holds every byte. It does NOT release,
   *     and the caps bound how much a viewer can make it buffer. Unchanged.
   *   - The viewer forwards each RESPONSE_* frame straight to the service
   *     worker and keeps nothing, so counting those bytes measured cumulative
   *     TRANSFER, not buffering. That silently capped any single HTTP response
   *     at maxStreamBufferBytes (1 MiB): a larger response tripped the cap
   *     mid-body and was killed, so an ordinary JS bundle or image could not
   *     traverse the tunnel at all. It releases as it forwards.
   *
   * Clamped, so a stream already released by an end frame cannot go negative,
   * and releasing an unknown/retired stream is a no-op.
   */
  releaseInbound(frame: Frame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      return;
    }
    const release = Math.min(frame.payload.byteLength, stream.bufferedBytes);
    stream.bufferedBytes -= release;
    this.totalBuffered -= release;
  }

  onInbound(handler: (frame: Frame) => void): Unsubscribe {
    return this.register(this.inboundHandlers, handler);
  }

  onPause(handler: () => void): Unsubscribe {
    return this.register(this.pauseHandlers, handler);
  }

  onResume(handler: () => void): Unsubscribe {
    return this.register(this.resumeHandlers, handler);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Count of LIVE streams — either half open. Fully-retired ids excluded. */
  openCount(): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (stream.inboundOpen || stream.outboundOpen) {
        count += 1;
      }
    }
    return count;
  }

  close(): void {
    this.unsubscribeTransport();
  }

  private routeInbound(frame: Frame): Result<undefined, StreamRejectedError> {
    const id = frame.streamId;
    const existing = this.streams.get(id);
    // The INBOUND half being closed rejects further inbound frames; an
    // outbound-closed (but inbound-open) stream still accepts inbound.
    if (existing && !existing.inboundOpen) {
      return err({ error: 'StreamRejected', streamId: id, reason: 'closed' });
    }
    if (!existing) {
      const opened = this.openInboundStream(id);
      if (!opened.ok) {
        return opened;
      }
    }
    return this.accountInbound(id, frame);
  }

  private openInboundStream(id: StreamId): Result<undefined, StreamRejectedError> {
    if (this.openCount() >= this.limits.maxConcurrentStreams) {
      this.emitError(id, 'concurrency-cap');
      return err({ error: 'StreamRejected', streamId: id, reason: 'concurrency-cap' });
    }
    this.streams.set(id, { inboundOpen: true, outboundOpen: true, bufferedBytes: 0 });
    return ok();
  }

  private accountInbound(id: StreamId, frame: Frame): Result<undefined, StreamRejectedError> {
    const stream = this.streams.get(id);
    if (!stream) {
      return err({ error: 'StreamRejected', streamId: id, reason: 'not-open' });
    }
    const size = frame.payload.byteLength;
    if (stream.bufferedBytes + size > this.limits.maxStreamBufferBytes) {
      return this.terminate(id, 'stream-buffer-cap');
    }
    if (this.totalBuffered + size > this.limits.maxTotalBufferBytes) {
      return this.terminate(id, 'total-buffer-cap');
    }
    stream.bufferedBytes += size;
    this.totalBuffered += size;
    if (isEndFrame(frame.type)) {
      this.closeInbound(id);
    } else if (releasesBufferOnly(frame.type)) {
      this.totalBuffered -= stream.bufferedBytes;
      stream.bufferedBytes = 0;
    }
    return ok();
  }

  /**
   * Kill a stream that breached a cap. The ERROR frame goes to the PEER, but
   * the local side must be told too: whoever is awaiting this stream (the
   * service worker's pending fetch, the host's relay loop) would otherwise
   * wait for a response that can no longer arrive and only give up on its own
   * timeout — a 30-second hang instead of an immediate, explained failure.
   */
  private terminate(id: StreamId, reason: StreamRejectionReason): Result<undefined, StreamRejectedError> {
    this.emitError(id, reason);
    this.forceClose(id);
    this.deliverLocalError(id, reason);
    return err({ error: 'StreamRejected', streamId: id, reason });
  }

  /** Synthesize the ERROR frame locally so inbound handlers see the failure. */
  private deliverLocalError(streamId: StreamId, reason: StreamRejectionReason): void {
    const payload = createFramePayload(new TextEncoder().encode(reason));
    if (isPayloadTooLargeError(payload)) {
      return;
    }
    this.deliver({ type: FrameType.ERROR, streamId, payload });
  }

  /** Close the inbound half: release its buffered bytes exactly once. */
  private closeInbound(id: StreamId): void {
    const stream = this.streams.get(id);
    if (!stream) {
      return;
    }
    this.totalBuffered -= stream.bufferedBytes;
    stream.bufferedBytes = 0;
    stream.inboundOpen = false;
  }

  /** Fully retire a stream (cap breach / teardown): both halves closed. */
  private forceClose(id: StreamId): void {
    const stream = this.streams.get(id);
    if (!stream) {
      return;
    }
    this.totalBuffered -= stream.bufferedBytes;
    stream.bufferedBytes = 0;
    stream.inboundOpen = false;
    stream.outboundOpen = false;
  }

  private emitError(streamId: StreamId, reason: string): void {
    const payload = createFramePayload(new TextEncoder().encode(reason));
    if (isPayloadTooLargeError(payload)) {
      return;
    }
    this.transport.send({ type: FrameType.ERROR, streamId, payload });
  }

  private deliver(frame: Frame): void {
    for (const handler of this.inboundHandlers) {
      handler(frame);
    }
  }

  private updateBackpressure(): void {
    const buffered = this.transport.bufferedAmount();
    if (this.shouldPause(buffered)) {
      this.paused = true;
      for (const handler of this.pauseHandlers) {
        handler();
      }
    } else if (this.shouldResume(buffered)) {
      this.paused = false;
      for (const handler of this.resumeHandlers) {
        handler();
      }
    }
  }

  private shouldPause(buffered: number): boolean {
    return !this.paused && buffered >= this.limits.highWaterMark;
  }

  private shouldResume(buffered: number): boolean {
    return this.paused && buffered <= this.limits.lowWaterMark;
  }

  private register<T>(list: T[], handler: T): Unsubscribe {
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }
}
