import { describe, expect, it } from 'vitest';
import {
  createFramePayload,
  createStreamId,
  decodeFrame,
  encodeFrame,
  type Frame,
  type FramePayload,
  FrameType,
  HEADER_SIZE,
  isFrameDecodeError,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  MAX_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  type StreamId,
} from '../../src/domain/frame.js';

const utf8 = new TextEncoder();

function mustStreamId(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error(`test setup: invalid stream id ${String(value)}`);
  }
  return id;
}

function mustPayload(bytes: Uint8Array): FramePayload {
  const payload = createFramePayload(bytes);
  if (isPayloadTooLargeError(payload)) {
    throw new Error('test setup: payload too large');
  }
  return payload;
}

function makeFrame(type: FrameType, streamId: number, payloadBytes: Uint8Array): Frame {
  return { type, streamId: mustStreamId(streamId), payload: mustPayload(payloadBytes) };
}

function expectRoundTripIdentity(frame: Frame): void {
  const decoded = decodeFrame(encodeFrame(frame));
  expect(isFrameDecodeError(decoded)).toBe(false);
  expect(decoded).toEqual(frame);
}

describe('frame round-trip identity — all nine variants', () => {
  it('REQUEST_HEAD round-trips a serialized HTTP request head', () => {
    const head = utf8.encode(
      JSON.stringify({ method: 'POST', path: '/api/items?page=2', headers: { 'content-type': 'application/json' } }),
    );
    expectRoundTripIdentity(makeFrame(FrameType.REQUEST_HEAD, 1, head));
  });

  it('REQUEST_BODY_CHUNK round-trips binary body bytes', () => {
    const body = new Uint8Array(1024).map((_, i) => (i * 7 + 13) % 256);
    expectRoundTripIdentity(makeFrame(FrameType.REQUEST_BODY_CHUNK, 42, body));
  });

  it('REQUEST_END round-trips with an empty payload', () => {
    expectRoundTripIdentity(makeFrame(FrameType.REQUEST_END, 42, new Uint8Array(0)));
  });

  it('RESPONSE_HEAD round-trips a serialized HTTP response head', () => {
    const head = utf8.encode(JSON.stringify({ status: 201, headers: { location: '/api/items/7' } }));
    expectRoundTripIdentity(makeFrame(FrameType.RESPONSE_HEAD, 1, head));
  });

  it('RESPONSE_BODY_CHUNK round-trips a full-cap payload', () => {
    const body = new Uint8Array(MAX_PAYLOAD_SIZE).fill(0xab);
    expectRoundTripIdentity(makeFrame(FrameType.RESPONSE_BODY_CHUNK, 7, body));
  });

  it('RESPONSE_END round-trips with an empty payload', () => {
    expectRoundTripIdentity(makeFrame(FrameType.RESPONSE_END, 7, new Uint8Array(0)));
  });

  it('ERROR round-trips a structured error payload', () => {
    const errorBody = utf8.encode(JSON.stringify({ code: 'REPLAY_FAILED', message: 'ECONNREFUSED 127.0.0.1:3000' }));
    const frame = makeFrame(FrameType.ERROR, 13, errorBody);
    expectRoundTripIdentity(frame);
    const decoded = decodeFrame(encodeFrame(frame)) as Frame;
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual({
      code: 'REPLAY_FAILED',
      message: 'ECONNREFUSED 127.0.0.1:3000',
    });
  });

  it('PING round-trips an 8-byte timestamp payload', () => {
    const ts = new Uint8Array([0, 0, 1, 0x97, 0x4e, 0x12, 0x9a, 0xff]);
    const frame = makeFrame(FrameType.PING, 99, ts);
    expectRoundTripIdentity(frame);
    const decoded = decodeFrame(encodeFrame(frame)) as Frame;
    expect(Array.from(decoded.payload)).toEqual([0, 0, 1, 0x97, 0x4e, 0x12, 0x9a, 0xff]);
  });

  it('PONG round-trips echoing the PING timestamp payload', () => {
    const ts = new Uint8Array([0, 0, 1, 0x97, 0x4e, 0x12, 0x9b, 0x03]);
    const frame = makeFrame(FrameType.PONG, 99, ts);
    expectRoundTripIdentity(frame);
    const decoded = decodeFrame(encodeFrame(frame)) as Frame;
    expect(decoded.type).toBe(FrameType.PONG);
    expect(Array.from(decoded.payload)).toEqual(Array.from(ts));
  });
});

describe('StreamId construction', () => {
  it('rejects zero', () => {
    const result = createStreamId(0);
    expect(isInvalidStreamIdError(result)).toBe(true);
  });

  it('rejects negative values', () => {
    const result = createStreamId(-5);
    expect(isInvalidStreamIdError(result)).toBe(true);
  });

  it('rejects non-integer values', () => {
    const result = createStreamId(1.5);
    expect(isInvalidStreamIdError(result)).toBe(true);
  });

  it('rejects values above uint32 range', () => {
    const result = createStreamId(0x1_0000_0000);
    expect(isInvalidStreamIdError(result)).toBe(true);
  });

  it('accepts the uint32 boundaries 1 and 2^32-1', () => {
    expect(isInvalidStreamIdError(createStreamId(1))).toBe(false);
    expect(isInvalidStreamIdError(createStreamId(0xffff_ffff))).toBe(false);
  });
});

describe('FramePayload construction', () => {
  it('rejects payloads above the size cap', () => {
    const result = createFramePayload(new Uint8Array(MAX_PAYLOAD_SIZE + 1));
    expect(isPayloadTooLargeError(result)).toBe(true);
    if (isPayloadTooLargeError(result)) {
      expect(result.maxSize).toBe(MAX_PAYLOAD_SIZE);
    }
  });

  it('accepts a payload exactly at the cap', () => {
    expect(isPayloadTooLargeError(createFramePayload(new Uint8Array(MAX_PAYLOAD_SIZE)))).toBe(false);
  });
});

describe('decodeFrame is total — typed errors, never throws', () => {
  it('returns EMPTY_INPUT for empty input', () => {
    const result = decodeFrame(new Uint8Array(0));
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('EMPTY_INPUT');
    }
  });

  it('returns TRUNCATED_HEADER for input shorter than the header', () => {
    const result = decodeFrame(new Uint8Array([FrameType.PING, 0, 0, 0]));
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('TRUNCATED_HEADER');
    }
  });

  it('returns LENGTH_MISMATCH for a truncated payload', () => {
    const encoded = encodeFrame(makeFrame(FrameType.REQUEST_BODY_CHUNK, 3, new Uint8Array(64)));
    const result = decodeFrame(encoded.subarray(0, encoded.byteLength - 10));
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('LENGTH_MISMATCH');
    }
  });

  it('returns LENGTH_MISMATCH when declared length exceeds bytes actually present', () => {
    const bytes = encodeFrame(makeFrame(FrameType.REQUEST_BODY_CHUNK, 3, new Uint8Array(8)));
    new DataView(bytes.buffer).setUint32(5, 5000);
    const result = decodeFrame(bytes);
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('LENGTH_MISMATCH');
    }
  });

  it('returns DECLARED_LENGTH_EXCEEDS_CAP before reading any payload when the length field exceeds the cap', () => {
    const bytes = encodeFrame(makeFrame(FrameType.REQUEST_BODY_CHUNK, 3, new Uint8Array(8)));
    new DataView(bytes.buffer).setUint32(5, 0xffff_ffff);
    const result = decodeFrame(bytes);
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('DECLARED_LENGTH_EXCEEDS_CAP');
    }
  });

  it('returns FRAME_TOO_LARGE for input above the frame cap', () => {
    const result = decodeFrame(new Uint8Array(MAX_FRAME_SIZE + 1));
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('FRAME_TOO_LARGE');
    }
  });

  it('returns UNKNOWN_FRAME_TYPE for an unrecognized type byte', () => {
    const bytes = encodeFrame(makeFrame(FrameType.PING, 1, new Uint8Array(0)));
    bytes[0] = 0xff;
    const result = decodeFrame(bytes);
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('UNKNOWN_FRAME_TYPE');
    }
  });

  it('returns INVALID_STREAM_ID for a zero stream id on the wire', () => {
    const bytes = encodeFrame(makeFrame(FrameType.PING, 1, new Uint8Array(0)));
    new DataView(bytes.buffer).setUint32(1, 0);
    const result = decodeFrame(bytes);
    expect(isFrameDecodeError(result)).toBe(true);
    if (isFrameDecodeError(result)) {
      expect(result.kind).toBe('INVALID_STREAM_ID');
    }
  });

  it('returns a typed error for arbitrary garbage bytes without throwing', () => {
    const garbage = new Uint8Array(32).map((_, i) => (i * 251 + 17) % 256);
    garbage[0] = 0xee;
    const result = decodeFrame(garbage);
    expect(isFrameDecodeError(result)).toBe(true);
  });

  it('decodes a frame from a non-zero buffer offset (subarray input)', () => {
    const encoded = encodeFrame(makeFrame(FrameType.PING, 5, new Uint8Array([1, 2, 3])));
    const padded = new Uint8Array(encoded.byteLength + 4);
    padded.set(encoded, 4);
    const result = decodeFrame(padded.subarray(4));
    expect(isFrameDecodeError(result)).toBe(false);
    expect((result as Frame).streamId).toBe(5);
    expect(Array.from((result as Frame).payload)).toEqual([1, 2, 3]);
  });
});

describe('encodeFrame wire layout', () => {
  it('writes the documented 9-byte big-endian header', () => {
    const frame = makeFrame(FrameType.RESPONSE_HEAD, 0x01020304, new Uint8Array([0xaa, 0xbb]));
    const bytes = encodeFrame(frame);
    expect(bytes.byteLength).toBe(HEADER_SIZE + 2);
    expect(Array.from(bytes.subarray(0, HEADER_SIZE))).toEqual([4, 1, 2, 3, 4, 0, 0, 0, 2]);
  });
});
