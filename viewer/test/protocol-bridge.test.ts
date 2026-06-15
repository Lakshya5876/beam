import { describe, expect, it } from 'vitest';
import {
  createFramePayload,
  createStreamId,
  FrameType,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
} from '../../src/domain/frame.js';
import { ok, type PeerTransport, type Result, type TransportClosedError, type Unsubscribe } from '../../src/domain/interfaces.js';
import { createViewerMultiplexer, decodeFrame, encodeFrame, isFrameDecodeError } from '../src/protocol-bridge.js';

function frame(streamId: number): Frame {
  const id = createStreamId(streamId);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  const payload = createFramePayload(new Uint8Array([1, 2, 3]));
  if (isPayloadTooLargeError(payload)) {
    throw new Error('test setup: payload');
  }
  return { type: FrameType.REQUEST_HEAD, streamId: id, payload };
}

class FakeTransport implements PeerTransport {
  public readonly sent: Frame[] = [];
  send(f: Frame): Result<undefined, TransportClosedError> {
    this.sent.push(f);
    return ok();
  }
  onFrame(): Unsubscribe {
    return () => undefined;
  }
  onClose(): Unsubscribe {
    return () => undefined;
  }
  close(): void {
    /* no-op */
  }
  bufferedAmount(): number {
    return 0;
  }
}

describe('protocol-bridge — uses the CORE shared protocol (parity by construction)', () => {
  it('re-exports the canonical codec: encode/decode round-trips a frame', () => {
    const f = frame(7);
    const decoded = decodeFrame(encodeFrame(f));
    expect(isFrameDecodeError(decoded)).toBe(false);
    expect(decoded).toEqual(f);
  });

  it('createViewerMultiplexer builds a real StreamMultiplexer that writes via the shared codec', () => {
    const transport = new FakeTransport();
    const mux = createViewerMultiplexer(transport);
    const opened = mux.openStream();
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const result = mux.writeFrame(frame(opened.value));
      expect(result.ok).toBe(true);
      // The frame reached the transport encoded — same framing the host decodes.
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.type).toBe(FrameType.REQUEST_HEAD);
    }
  });
});
