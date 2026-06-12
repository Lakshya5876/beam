/**
 * Wire format for the Beam framing protocol (design doc §4, §A.2.1).
 * Scope: encode/decode of single frames only. Stream liveness, concurrency
 * caps, and backpressure are S4 (shared/protocol) concerns, not wire format.
 *
 * Layout (big-endian): [type:1][streamId:4][payloadLength:4][payload...]
 */

export const FrameType = {
  REQUEST_HEAD: 1,
  REQUEST_BODY_CHUNK: 2,
  REQUEST_END: 3,
  RESPONSE_HEAD: 4,
  RESPONSE_BODY_CHUNK: 5,
  RESPONSE_END: 6,
  ERROR: 7,
  PING: 8,
  PONG: 9,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_VALUES: ReadonlySet<number> = new Set(Object.values(FrameType));

export const HEADER_SIZE = 9;
export const MAX_PAYLOAD_SIZE = 256 * 1024;
export const MAX_FRAME_SIZE = HEADER_SIZE + MAX_PAYLOAD_SIZE;

const MAX_STREAM_ID = 0xffff_ffff;

declare const streamIdBrand: unique symbol;
export type StreamId = number & { readonly [streamIdBrand]: true };

export interface InvalidStreamIdError {
  readonly error: 'InvalidStreamId';
  readonly value: number;
  readonly reason: string;
}

export function createStreamId(value: number): StreamId | InvalidStreamIdError {
  if (!Number.isInteger(value)) {
    return { error: 'InvalidStreamId', value, reason: 'must be an integer' };
  }
  if (value < 1 || value > MAX_STREAM_ID) {
    return { error: 'InvalidStreamId', value, reason: 'must be in range 1..2^32-1' };
  }
  return value as StreamId;
}

export function isInvalidStreamIdError(value: unknown): value is InvalidStreamIdError {
  return typeof value === 'object' && value !== null && (value as InvalidStreamIdError).error === 'InvalidStreamId';
}

declare const framePayloadBrand: unique symbol;
export type FramePayload = Uint8Array & { readonly [framePayloadBrand]: true };

export interface PayloadTooLargeError {
  readonly error: 'PayloadTooLarge';
  readonly actualSize: number;
  readonly maxSize: number;
}

export function createFramePayload(bytes: Uint8Array): FramePayload | PayloadTooLargeError {
  if (bytes.byteLength > MAX_PAYLOAD_SIZE) {
    return { error: 'PayloadTooLarge', actualSize: bytes.byteLength, maxSize: MAX_PAYLOAD_SIZE };
  }
  return bytes as FramePayload;
}

export function isPayloadTooLargeError(value: unknown): value is PayloadTooLargeError {
  return typeof value === 'object' && value !== null && (value as PayloadTooLargeError).error === 'PayloadTooLarge';
}

export interface Frame {
  readonly type: FrameType;
  readonly streamId: StreamId;
  readonly payload: FramePayload;
}

export type FrameDecodeErrorKind =
  | 'EMPTY_INPUT'
  | 'FRAME_TOO_LARGE'
  | 'TRUNCATED_HEADER'
  | 'UNKNOWN_FRAME_TYPE'
  | 'INVALID_STREAM_ID'
  | 'DECLARED_LENGTH_EXCEEDS_CAP'
  | 'LENGTH_MISMATCH';

export interface FrameDecodeError {
  readonly error: 'FrameDecode';
  readonly kind: FrameDecodeErrorKind;
  readonly message: string;
}

export function isFrameDecodeError(value: unknown): value is FrameDecodeError {
  return typeof value === 'object' && value !== null && (value as FrameDecodeError).error === 'FrameDecode';
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.type);
  view.setUint32(1, frame.streamId);
  view.setUint32(5, frame.payload.byteLength);
  out.set(frame.payload, HEADER_SIZE);
  return out;
}

function decodeError(kind: FrameDecodeErrorKind, message: string): FrameDecodeError {
  return { error: 'FrameDecode', kind, message };
}

/**
 * Total decoder: every input maps to a Frame or a FrameDecodeError — never
 * throws. The declared payload length is validated against the bytes actually
 * present before the payload region is touched; no allocation is ever sized
 * from a peer-supplied length field.
 */
export function decodeFrame(bytes: Uint8Array): Frame | FrameDecodeError {
  if (bytes.byteLength === 0) {
    return decodeError('EMPTY_INPUT', 'input is empty');
  }
  if (bytes.byteLength > MAX_FRAME_SIZE) {
    return decodeError('FRAME_TOO_LARGE', `frame of ${String(bytes.byteLength)} bytes exceeds cap ${String(MAX_FRAME_SIZE)}`);
  }
  if (bytes.byteLength < HEADER_SIZE) {
    return decodeError('TRUNCATED_HEADER', `need ${String(HEADER_SIZE)} header bytes, got ${String(bytes.byteLength)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeByte = view.getUint8(0);
  if (!FRAME_TYPE_VALUES.has(typeByte)) {
    return decodeError('UNKNOWN_FRAME_TYPE', `unknown frame type ${String(typeByte)}`);
  }
  const streamId = createStreamId(view.getUint32(1));
  if (isInvalidStreamIdError(streamId)) {
    return decodeError('INVALID_STREAM_ID', `wire stream id invalid: ${streamId.reason}`);
  }
  const declaredLength = view.getUint32(5);
  if (declaredLength > MAX_PAYLOAD_SIZE) {
    return decodeError('DECLARED_LENGTH_EXCEEDS_CAP', `declared payload length ${String(declaredLength)} exceeds cap ${String(MAX_PAYLOAD_SIZE)}`);
  }
  const actualLength = bytes.byteLength - HEADER_SIZE;
  if (declaredLength !== actualLength) {
    return decodeError('LENGTH_MISMATCH', `declared payload length ${String(declaredLength)}, actual ${String(actualLength)}`);
  }
  return {
    type: typeByte as FrameType,
    streamId,
    payload: bytes.subarray(HEADER_SIZE) as FramePayload,
  };
}
