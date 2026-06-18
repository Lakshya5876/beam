import { describe, it, expect } from 'vitest';
import { encodeRequest, type RequestLike } from '../src/request-serializer.js';
import {
  decodeFrame,
  encodeFrame,
  isFrameDecodeError,
  FrameType,
  MAX_PAYLOAD_SIZE,
  HEADER_SIZE,
} from '../src/protocol-bridge.js';

const STREAM_ID = 1;

const GET_REQ: RequestLike = {
  method: 'GET',
  path: '/api/users',
  headers: [['accept', 'application/json']],
};

const POST_REQ: RequestLike = {
  method: 'POST',
  path: '/api/data',
  headers: [['content-type', 'application/json']],
  body: new TextEncoder().encode('{"hello":"world"}'),
};

describe('encodeRequest', () => {
  it('GET (no body) produces REQUEST_HEAD + REQUEST_END only', () => {
    const frames = encodeRequest(STREAM_ID, GET_REQ);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.type).toBe(FrameType.REQUEST_HEAD);
    expect(frames[1]?.type).toBe(FrameType.REQUEST_END);
  });

  it('POST with body produces REQUEST_HEAD + REQUEST_BODY_CHUNK + REQUEST_END', () => {
    const frames = encodeRequest(STREAM_ID, POST_REQ);
    expect(frames).toHaveLength(3);
    expect(frames[0]?.type).toBe(FrameType.REQUEST_HEAD);
    expect(frames[1]?.type).toBe(FrameType.REQUEST_BODY_CHUNK);
    expect(frames[2]?.type).toBe(FrameType.REQUEST_END);
  });

  it('REQUEST_HEAD payload encodes method, path, headers as JSON', () => {
    const frames = encodeRequest(STREAM_ID, GET_REQ);
    const headFrame = frames[0];
    expect(headFrame).toBeDefined();
    if (!headFrame) return;
    const decoded = JSON.parse(new TextDecoder().decode(headFrame.payload)) as unknown;
    expect(decoded).toEqual({ method: 'GET', path: GET_REQ.path, headers: GET_REQ.headers });
  });

  it('body larger than MAX_PAYLOAD_SIZE chunks into multiple REQUEST_BODY_CHUNK frames', () => {
    const bigBody = new Uint8Array(MAX_PAYLOAD_SIZE * 2 + 100);
    bigBody.fill(0xab);
    const frames = encodeRequest(STREAM_ID, { ...GET_REQ, body: bigBody });
    const bodyChunks = frames.filter((f) => f.type === FrameType.REQUEST_BODY_CHUNK);
    expect(bodyChunks).toHaveLength(3); // ceil((2*MAX+100)/MAX) = 3
  });

  it('N7: every REQUEST_BODY_CHUNK encoded frame size = payload.byteLength + HEADER_SIZE (wire-frame bound)', () => {
    const bigBody = new Uint8Array(MAX_PAYLOAD_SIZE + 500);
    bigBody.fill(0xcd);
    const frames = encodeRequest(STREAM_ID, { ...GET_REQ, body: bigBody });
    for (const frame of frames.filter((f) => f.type === FrameType.REQUEST_BODY_CHUNK)) {
      const encoded = encodeFrame(frame);
      expect(encoded.byteLength).toBe(frame.payload.byteLength + HEADER_SIZE);
    }
  });

  it('N7: each REQUEST_BODY_CHUNK payload ≤ MAX_PAYLOAD_SIZE', () => {
    const bigBody = new Uint8Array(MAX_PAYLOAD_SIZE * 3);
    bigBody.fill(0x01);
    const frames = encodeRequest(STREAM_ID, { ...GET_REQ, body: bigBody });
    for (const frame of frames.filter((f) => f.type === FrameType.REQUEST_BODY_CHUNK)) {
      expect(frame.payload.byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_SIZE);
    }
  });

  it('round-trips through the shared codec (decodeFrame recovers every frame)', () => {
    const frames = encodeRequest(STREAM_ID, POST_REQ);
    for (const frame of frames) {
      const encoded = encodeFrame(frame);
      const decoded = decodeFrame(encoded);
      expect(isFrameDecodeError(decoded)).toBe(false);
      if (!isFrameDecodeError(decoded)) {
        expect(decoded.type).toBe(frame.type);
        expect(decoded.streamId).toBe(frame.streamId);
      }
    }
  });
});
