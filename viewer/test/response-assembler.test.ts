import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseAssembler } from '../src/response-assembler.js';
import {
  createFramePayload,
  createStreamId,
  FrameType,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
} from '../src/protocol-bridge.js';

function makeFrame(type: number, payloadBytes: Uint8Array): Frame {
  const streamId = createStreamId(1);
  if (isInvalidStreamIdError(streamId)) throw new Error('bad streamId');
  const payload = createFramePayload(payloadBytes);
  if (isPayloadTooLargeError(payload)) throw new Error('payload too large');
  return { type: type as Frame['type'], streamId, payload };
}

// Host contract (encodeResponseHead): {status, headers} with Record headers.
// No statusText on the wire — corrected after the local e2e harness caught
// the old array-of-pairs shape rejecting every real host response.
function headFrame(status = 200, headers: Record<string, string> = {}): Frame {
  const json = JSON.stringify({ status, headers });
  return makeFrame(FrameType.RESPONSE_HEAD, new TextEncoder().encode(json));
}

function bodyFrame(text: string): Frame {
  return makeFrame(FrameType.RESPONSE_BODY_CHUNK, new TextEncoder().encode(text));
}

function endFrame(): Frame {
  return makeFrame(FrameType.RESPONSE_END, new Uint8Array(0));
}

describe('ResponseAssembler', () => {
  let assembler: ResponseAssembler;

  beforeEach(() => {
    assembler = new ResponseAssembler();
  });

  it('RESPONSE_HEAD sets status and headers on the built Response', () => {
    const result = assembler.feed(headFrame(201, { 'x-custom': 'val' }));
    expect(result).toBe('continue');
    const response = assembler.buildResponse();
    expect(response.status).toBe(201);
    expect(response.headers.get('x-custom')).toBe('val');
    assembler.feed(endFrame());
  });

  it('RESPONSE_BODY_CHUNK chunks are streamed through the ReadableStream body', async () => {
    assembler.feed(headFrame());
    const response = assembler.buildResponse();
    assembler.feed(bodyFrame('hello '));
    assembler.feed(bodyFrame('world'));
    assembler.feed(endFrame());
    const text = await response.text();
    expect(text).toBe('hello world');
  });

  it('RESPONSE_END closes the stream and returns complete', () => {
    assembler.feed(headFrame());
    assembler.buildResponse();
    assembler.feed(bodyFrame('data'));
    const result = assembler.feed(endFrame());
    expect(result).toBe('complete');
  });

  it('RESPONSE_BODY_CHUNK before HEAD returns error', () => {
    const result = assembler.feed(bodyFrame('premature'));
    expect(result).toBe('error');
  });

  it('RESPONSE_END before HEAD returns error', () => {
    const result = assembler.feed(endFrame());
    expect(result).toBe('error');
  });

  it('N3 / B2: abort() mid-stream errors the ReadableStream', async () => {
    assembler.feed(headFrame());
    const response = assembler.buildResponse();
    assembler.feed(bodyFrame('partial'));
    assembler.abort('disconnect');

    // The ReadableStream should error when consumed
    let threw = false;
    try {
      await response.text();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('abort() in idle state is a noop (no throw)', () => {
    expect(() => assembler.abort('reason')).not.toThrow();
  });

  it('abort() after complete is a noop (no throw)', () => {
    assembler.feed(headFrame());
    assembler.buildResponse();
    assembler.feed(endFrame());
    expect(() => assembler.abort('reason')).not.toThrow();
  });

  it('second RESPONSE_HEAD returns error', () => {
    assembler.feed(headFrame());
    const result = assembler.feed(headFrame(404));
    expect(result).toBe('error');
  });
});
