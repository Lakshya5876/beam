import { describe, expect, it } from 'vitest';
import {
  createFramePayload,
  createStreamId,
  FrameType,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  MAX_PAYLOAD_SIZE,
  type Frame,
  type FramePayload,
  type StreamId,
} from '../../src/domain/frame.js';
import { err, ok, type ReplayClient, type ReplayFailedError, type ReplayRequest, type ReplayResponse, type Result } from '../../src/domain/interfaces.js';
import {
  assembleRequest,
  decodeRequestHead,
  decodeResponseHead,
  encodeRequestHead,
  encodeResponseHead,
  ExecuteRelayUseCase,
  frameError,
  frameResponse,
  isRelayDecodeError,
} from '../../src/application/relay-use-case.js';

const SID = 5;

function sid(value: number = SID): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  return id;
}

function payload(bytes: Uint8Array): FramePayload {
  const p = createFramePayload(bytes);
  if (isPayloadTooLargeError(p)) {
    throw new Error('test setup: payload too large');
  }
  return p;
}

function frame(type: FrameType, bytes: Uint8Array, streamId: number = SID): Frame {
  return { type, streamId: sid(streamId), payload: payload(bytes) };
}

const utf8 = new TextEncoder();
const decode = new TextDecoder();

// Reuses the S3 fake pattern (tests/domain/interfaces.test.ts): a plain object
// literal implementing ReplayClient via ok/err — here parameterized to record
// the request and return a configurable Result. No parallel reimplementation.
function makeReplayClient(
  impl: (request: ReplayRequest) => Result<ReplayResponse, ReplayFailedError>,
): { client: ReplayClient; calls: ReplayRequest[] } {
  const calls: ReplayRequest[] = [];
  const client: ReplayClient = {
    replay(request) {
      calls.push(request);
      return Promise.resolve(impl(request));
    },
  };
  return { client, calls };
}

describe('relay head codecs', () => {
  it('request head round-trips', () => {
    const head = { method: 'POST', path: '/api/x?q=1', headers: { 'content-type': 'application/json' } };
    const decoded = decodeRequestHead(encodeRequestHead(head));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value).toEqual(head);
    }
  });

  it('response head round-trips', () => {
    const head = { status: 201, headers: { location: '/api/x/7' } };
    const decoded = decodeResponseHead(encodeResponseHead(head));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value).toEqual(head);
    }
  });

  it('decodeRequestHead rejects malformed / wrong-typed input', () => {
    expect(isRelayDecodeError(unwrapErr(decodeRequestHead(utf8.encode('not json{'))))).toBe(true);
    expect(isRelayDecodeError(unwrapErr(decodeRequestHead(utf8.encode('"a string"'))))).toBe(true);
    expect(isRelayDecodeError(unwrapErr(decodeRequestHead(utf8.encode(JSON.stringify({ method: 'GET' })))))).toBe(true);
    expect(isRelayDecodeError(unwrapErr(decodeRequestHead(utf8.encode(JSON.stringify({ method: 'GET', path: '/', headers: { a: 1 } })))))).toBe(true);
  });

  it('decodeResponseHead rejects a non-integer status', () => {
    expect(isRelayDecodeError(unwrapErr(decodeResponseHead(utf8.encode(JSON.stringify({ status: 'ok', headers: {} })))))).toBe(true);
  });
});

function unwrapErr<T, E>(result: Result<T, E>): E | undefined {
  return result.ok ? undefined : result.error;
}

describe('assembleRequest', () => {
  it('reconstructs method, path, headers, and body from HEAD + chunks + END', () => {
    const frames = [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'PUT', path: '/p', headers: { 'x-a': '1' } })),
      frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode('hello ')),
      frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode('world')),
      frame(FrameType.REQUEST_END, new Uint8Array(0)),
    ];
    const result = assembleRequest(frames);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe('PUT');
      expect(result.value.path).toBe('/p');
      expect(result.value.headers).toEqual({ 'x-a': '1' });
      expect(decode.decode(result.value.body)).toBe('hello world');
    }
  });

  it('handles an empty-body request (HEAD + END)', () => {
    const frames = [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'GET', path: '/', headers: {} })),
      frame(FrameType.REQUEST_END, new Uint8Array(0)),
    ];
    const result = assembleRequest(frames);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body.byteLength).toBe(0);
    }
  });

  it('rejects a body frame before the head', () => {
    const result = assembleRequest([frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode('x'))]);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing REQUEST_END', () => {
    const frames = [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'GET', path: '/', headers: {} })),
      frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode('x')),
    ];
    expect(assembleRequest(frames).ok).toBe(false);
  });

  it('rejects frames spanning multiple streams', () => {
    const frames = [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'GET', path: '/', headers: {} }), 5),
      frame(FrameType.REQUEST_END, new Uint8Array(0), 6),
    ];
    expect(assembleRequest(frames).ok).toBe(false);
  });

  it('rejects an assembled body over the cap', () => {
    const frames = [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'POST', path: '/', headers: {} })),
      frame(FrameType.REQUEST_BODY_CHUNK, new Uint8Array(20)),
      frame(FrameType.REQUEST_END, new Uint8Array(0)),
    ];
    const result = assembleRequest(frames, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('request body exceeds cap');
    }
  });
});

describe('frameResponse / frameError', () => {
  it('frames a small response as HEAD, CHUNK, END decoding back to the response', () => {
    const frames = frameResponse(sid(), { status: 200, headers: { 'x-h': 'v' }, body: utf8.encode('body!') });
    expect(frames.map((f) => f.type)).toEqual([FrameType.RESPONSE_HEAD, FrameType.RESPONSE_BODY_CHUNK, FrameType.RESPONSE_END]);
    const head = decodeResponseHead(frames[0]!.payload);
    expect(head.ok).toBe(true);
    if (head.ok) {
      expect(head.value).toEqual({ status: 200, headers: { 'x-h': 'v' } });
    }
    expect(decode.decode(frames[1]!.payload)).toBe('body!');
  });

  it('frames an empty-body response as HEAD, END (no chunk)', () => {
    const frames = frameResponse(sid(), { status: 204, headers: {}, body: new Uint8Array(0) });
    expect(frames.map((f) => f.type)).toEqual([FrameType.RESPONSE_HEAD, FrameType.RESPONSE_END]);
  });

  it('splits a large body into chunks each <= MAX_PAYLOAD_SIZE reassembling to the original', () => {
    const body = new Uint8Array(MAX_PAYLOAD_SIZE * 2 + 100).map((_, i) => i % 256);
    const frames = frameResponse(sid(), { status: 200, headers: {}, body });
    const chunks = frames.filter((f) => f.type === FrameType.RESPONSE_BODY_CHUNK);
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.payload.byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_SIZE);
    }
    const reassembled = new Uint8Array(body.byteLength);
    let off = 0;
    for (const c of chunks) {
      reassembled.set(c.payload, off);
      off += c.payload.byteLength;
    }
    expect(Array.from(reassembled)).toEqual(Array.from(body));
  });

  it('frameError yields a single ERROR frame carrying the reason', () => {
    const frames = frameError(sid(), 'ECONNREFUSED');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(FrameType.ERROR);
    expect(decode.decode(frames[0]!.payload)).toBe('ECONNREFUSED');
  });
});

describe('ExecuteRelayUseCase', () => {
  function requestFrames(path: string, body: string): Frame[] {
    return [
      frame(FrameType.REQUEST_HEAD, encodeRequestHead({ method: 'GET', path, headers: {} })),
      frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode(body)),
      frame(FrameType.REQUEST_END, new Uint8Array(0)),
    ];
  }

  it('replays the assembled request and returns the response frames', async () => {
    const { client, calls } = makeReplayClient((request) =>
      ok({ status: 200, headers: { 'content-type': 'text/plain' }, body: utf8.encode(`echo:${request.path}`) }),
    );
    const useCase = new ExecuteRelayUseCase(client);
    const frames = await useCase.execute(requestFrames('/hi', 'payload'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/hi');
    expect(decode.decode(calls[0]!.body)).toBe('payload');
    expect(frames.map((f) => f.type)).toEqual([FrameType.RESPONSE_HEAD, FrameType.RESPONSE_BODY_CHUNK, FrameType.RESPONSE_END]);
    expect(decode.decode(frames[1]!.payload)).toBe('echo:/hi');
  });

  it('returns a single ERROR frame when replay fails', async () => {
    const { client } = makeReplayClient(() => err({ error: 'ReplayFailed', reason: 'ECONNREFUSED' }));
    const useCase = new ExecuteRelayUseCase(client);
    const frames = await useCase.execute(requestFrames('/down', ''));
    expect(frames.map((f) => f.type)).toEqual([FrameType.ERROR]);
    expect(decode.decode(frames[0]!.payload)).toBe('ECONNREFUSED');
  });

  it('returns an ERROR frame and never calls replay on malformed request frames', async () => {
    const { client, calls } = makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) }));
    const useCase = new ExecuteRelayUseCase(client);
    // Body chunk before head -> assembly fails.
    const frames = await useCase.execute([frame(FrameType.REQUEST_BODY_CHUNK, utf8.encode('x'))]);
    expect(frames.map((f) => f.type)).toEqual([FrameType.ERROR]);
    expect(calls).toHaveLength(0);
  });

  it('returns no frames for an empty input', async () => {
    const { client } = makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) }));
    const useCase = new ExecuteRelayUseCase(client);
    expect(await useCase.execute([])).toEqual([]);
  });
});
