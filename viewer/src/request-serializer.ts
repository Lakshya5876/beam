import {
  createFramePayload,
  createStreamId,
  FrameType,
  MAX_PAYLOAD_SIZE,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
} from './protocol-bridge.js';

export interface RequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<[string, string]>;
  readonly body?: Uint8Array;
}

function makeFrame(type: number, streamIdNum: number, payloadBytes: Uint8Array): Frame {
  const streamId = createStreamId(streamIdNum);
  if (isInvalidStreamIdError(streamId)) throw new Error(`invalid streamId ${String(streamIdNum)}`);
  const payload = createFramePayload(payloadBytes);
  if (isPayloadTooLargeError(payload)) throw new Error('payload exceeds MAX_PAYLOAD_SIZE');
  return { type: type as Frame['type'], streamId, payload };
}

/**
 * Encode a request into REQUEST_HEAD + REQUEST_BODY_CHUNK* + REQUEST_END frames.
 * Body chunks are split at MAX_PAYLOAD_SIZE boundaries.
 * MAX_PAYLOAD_SIZE is imported from protocol-bridge (sourced from CORE — never redeclared).
 */
export function encodeRequest(streamIdNum: number, req: RequestLike): Frame[] {
  const frames: Frame[] = [];

  // REQUEST_HEAD: JSON-encoded method, url, headers
  const headJson = JSON.stringify({ method: req.method, url: req.url, headers: req.headers });
  const headBytes = new TextEncoder().encode(headJson);
  frames.push(makeFrame(FrameType.REQUEST_HEAD, streamIdNum, headBytes));

  // REQUEST_BODY_CHUNK: split body at MAX_PAYLOAD_SIZE
  if (req.body && req.body.byteLength > 0) {
    let offset = 0;
    while (offset < req.body.byteLength) {
      const chunk = req.body.subarray(offset, offset + MAX_PAYLOAD_SIZE);
      frames.push(makeFrame(FrameType.REQUEST_BODY_CHUNK, streamIdNum, chunk));
      offset += MAX_PAYLOAD_SIZE;
    }
  }

  // REQUEST_END: empty payload signals end of request
  frames.push(makeFrame(FrameType.REQUEST_END, streamIdNum, new Uint8Array(0)));

  return frames;
}
