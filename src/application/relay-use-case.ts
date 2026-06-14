/**
 * Relay use-case (design doc §10 S10, §2 flow): decode inbound REQUEST_*
 * frames into a ReplayRequest, replay it via the ReplayClient domain
 * interface, and encode the ReplayResponse (or failure) back into
 * RESPONSE / ERROR frames.
 *
 * Application layer: orchestrates Domain + Infrastructure through interfaces
 * only. No transport/HTTP/CLI specifics, no clock, no randomness — request-log
 * timing/records are an S11 concern. Decode is total: malformed peer frames
 * yield a typed error and, on the wire, an ERROR frame — never a throw.
 */

import {
  createFramePayload,
  FrameType,
  isPayloadTooLargeError,
  MAX_PAYLOAD_SIZE,
  type Frame,
  type FramePayload,
  type StreamId,
} from '../domain/frame.js';
import {
  err,
  ok,
  type ReplayClient,
  type ReplayRequest,
  type ReplayResponse,
  type Result,
} from '../domain/interfaces.js';

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface RequestHead {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}

export interface ResponseHead {
  readonly status: number;
  readonly headers: Record<string, string>;
}

export interface RelayDecodeError {
  readonly error: 'RelayDecode';
  readonly reason: string;
}

export function isRelayDecodeError(value: unknown): value is RelayDecodeError {
  return typeof value === 'object' && value !== null && (value as RelayDecodeError).error === 'RelayDecode';
}

function relayDecode(reason: string): RelayDecodeError {
  return { error: 'RelayDecode', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    // Malformed peer bytes are expected input, not a bug — drop to a typed error.
    return undefined;
  }
}

export function encodeRequestHead(head: RequestHead): Uint8Array {
  return utf8Encoder.encode(JSON.stringify({ method: head.method, path: head.path, headers: head.headers }));
}

export function encodeResponseHead(head: ResponseHead): Uint8Array {
  return utf8Encoder.encode(JSON.stringify({ status: head.status, headers: head.headers }));
}

export function decodeRequestHead(bytes: Uint8Array): Result<RequestHead, RelayDecodeError> {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed)) {
    return err(relayDecode('request head is not a JSON object'));
  }
  if (typeof parsed.method !== 'string' || typeof parsed.path !== 'string') {
    return err(relayDecode('request head missing method/path'));
  }
  if (!isStringRecord(parsed.headers)) {
    return err(relayDecode('request head has invalid headers'));
  }
  return ok({ method: parsed.method, path: parsed.path, headers: parsed.headers });
}

export function decodeResponseHead(bytes: Uint8Array): Result<ResponseHead, RelayDecodeError> {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed)) {
    return err(relayDecode('response head is not a JSON object'));
  }
  if (typeof parsed.status !== 'number' || !Number.isInteger(parsed.status)) {
    return err(relayDecode('response head missing integer status'));
  }
  if (!isStringRecord(parsed.headers)) {
    return err(relayDecode('response head has invalid headers'));
  }
  return ok({ status: parsed.status, headers: parsed.headers });
}

function emptyPayload(): FramePayload {
  return createFramePayload(new Uint8Array(0)) as FramePayload;
}

function chunkBody(body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < body.byteLength; offset += MAX_PAYLOAD_SIZE) {
    chunks.push(body.subarray(offset, Math.min(offset + MAX_PAYLOAD_SIZE, body.byteLength)));
  }
  return chunks;
}

interface BodyResult {
  readonly body: Uint8Array;
}

function collectRequestBody(
  frames: readonly Frame[],
  streamId: StreamId,
  maxBodyBytes: number,
): Result<BodyResult, RelayDecodeError> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i] as Frame;
    if (frame.streamId !== streamId) {
      return err(relayDecode('frames span multiple streams'));
    }
    if (ended) {
      return err(relayDecode('frame after REQUEST_END'));
    }
    if (frame.type === FrameType.REQUEST_END) {
      ended = true;
    } else if (frame.type === FrameType.REQUEST_BODY_CHUNK) {
      total += frame.payload.byteLength;
      if (total > maxBodyBytes) {
        return err(relayDecode('request body exceeds cap'));
      }
      chunks.push(frame.payload);
    } else {
      return err(relayDecode('unexpected frame type in request'));
    }
  }
  if (!ended) {
    return err(relayDecode('missing REQUEST_END'));
  }
  return ok({ body: concatChunks(chunks, total) });
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function assembleRequest(
  frames: readonly Frame[],
  maxBodyBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Result<ReplayRequest, RelayDecodeError> {
  const head = frames[0];
  if (!head || head.type !== FrameType.REQUEST_HEAD) {
    return err(relayDecode('first frame is not REQUEST_HEAD'));
  }
  const decodedHead = decodeRequestHead(head.payload);
  if (!decodedHead.ok) {
    return decodedHead;
  }
  const collected = collectRequestBody(frames, head.streamId, maxBodyBytes);
  if (!collected.ok) {
    return collected;
  }
  return ok({
    method: decodedHead.value.method,
    path: decodedHead.value.path,
    headers: decodedHead.value.headers,
    body: collected.value.body,
  });
}

export function frameError(streamId: StreamId, reason: string): Frame[] {
  const payload = createFramePayload(utf8Encoder.encode(reason));
  if (isPayloadTooLargeError(payload)) {
    return [{ type: FrameType.ERROR, streamId, payload: createFramePayload(utf8Encoder.encode('relay error')) as FramePayload }];
  }
  return [{ type: FrameType.ERROR, streamId, payload }];
}

export function frameResponse(streamId: StreamId, response: ReplayResponse): Frame[] {
  const headPayload = createFramePayload(encodeResponseHead({ status: response.status, headers: response.headers }));
  if (isPayloadTooLargeError(headPayload)) {
    return frameError(streamId, 'response head too large');
  }
  const frames: Frame[] = [{ type: FrameType.RESPONSE_HEAD, streamId, payload: headPayload }];
  for (const chunk of chunkBody(response.body)) {
    const chunkPayload = createFramePayload(chunk);
    if (isPayloadTooLargeError(chunkPayload)) {
      return frameError(streamId, 'response chunk too large');
    }
    frames.push({ type: FrameType.RESPONSE_BODY_CHUNK, streamId, payload: chunkPayload });
  }
  frames.push({ type: FrameType.RESPONSE_END, streamId, payload: emptyPayload() });
  return frames;
}

export class ExecuteRelayUseCase {
  constructor(
    private readonly replayClient: ReplayClient,
    private readonly maxBodyBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES,
  ) {}

  async execute(requestFrames: readonly Frame[]): Promise<readonly Frame[]> {
    const first = requestFrames[0];
    if (!first) {
      return [];
    }
    const streamId = first.streamId;
    const assembled = assembleRequest(requestFrames, this.maxBodyBytes);
    if (!assembled.ok) {
      return frameError(streamId, assembled.error.reason);
    }
    const replayed = await this.replayClient.replay(assembled.value);
    if (!replayed.ok) {
      return frameError(streamId, replayed.error.reason);
    }
    return frameResponse(streamId, replayed.value);
  }
}
