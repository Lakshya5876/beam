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
  type ReplaySink,
  type Result,
} from '../domain/interfaces.js';
import { createHtmlInjector, isInjectableHtml, type HtmlInjector } from './html-injection.js';

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Served by the SW's shouldBypassRelay as a Beam-owned asset (`/__beam/*`
 * always bypasses relay — see viewer/src/sw-fetch-gate.ts), regardless of
 * whether the outer shell or the tunneled-app iframe requests it. Injected
 * into every HTML response so `new WebSocket()` calls anywhere the tunneled
 * app runs get shimmed — a service worker cannot intercept the WebSocket
 * constructor itself, only fetch(), so this is the only way in.
 */
// type="module": module scripts are deferred (execute after full parse, in
// insertion order relative to each other) — matches how virtually every
// modern bundled app (Vite/Next/CRA-style dev servers, this product's
// primary audience) ships its own JS, so the shim still runs before the
// app's own module scripts despite not being a blocking classic script.
// Documented limitation: an app relying SOLELY on classic (non-module)
// scripts that construct a WebSocket synchronously during initial parse can
// race ahead of the shim (LIMITATIONS.md).
const WS_SHIM_SCRIPT_TAG = utf8Encoder.encode('<script type="module" src="/__beam/ws-shim.js"></script>');

/**
 * Only inject into an uncompressed HTML response: injecting into raw
 * compressed bytes (gzip/br/deflate) would corrupt the stream, and
 * decompress-inject-recompress is real complexity this v1 skips. A
 * compressed HTML response is relayed byte-for-byte, unmodified, same as
 * always — it just does not get the WS shim (documented limitation).
 */
function canInjectShim(headers: Readonly<Record<string, string>>): boolean {
  const encoding = headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
    return false;
  }
  return isInjectableHtml(headers['content-type']);
}

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

/**
 * A tunneled server has no idea it is being tunneled: when it redirects to
 * itself it naturally builds the Location from what IT thinks its own
 * origin is — `http://localhost:<port>/...` or `http://127.0.0.1:<port>/...`.
 * Followed literally by the viewer's browser, that means "connect to
 * localhost on the VIEWER's own machine", which is either a dead connection
 * or — worse — some unrelated service on the viewer's port. Rewriting a
 * self-referential absolute Location to a path-relative one lets the browser
 * resolve it against the viewer's actual (tunnel) origin instead, exactly
 * like every other relayed same-origin link. A Location pointing at a
 * genuinely different host is left untouched — only localhost/127.0.0.1 (any
 * port) is rewritten, since the viewer's browser can never legitimately
 * reach the developer's loopback interface by IP.
 */
export function rewriteSelfReferentialLocation(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // already relative (or unparseable) — leave alone
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return raw;
}

function rewriteLocationIfPresent(headers: Record<string, string>): Record<string, string> {
  const location = headers['location'];
  if (location === undefined) {
    return headers;
  }
  const rewritten = rewriteSelfReferentialLocation(location);
  return rewritten === location ? headers : { ...headers, location: rewritten };
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

export type FrameSink = (frame: Frame) => void | Promise<void>;

async function emitAll(onFrame: FrameSink, frames: readonly Frame[]): Promise<void> {
  for (const frame of frames) {
    await onFrame(frame);
  }
}

export class ExecuteRelayUseCase {
  constructor(
    private readonly replayClient: ReplayClient,
    private readonly maxBodyBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES,
  ) {}

  /**
   * Streams the response back through `onFrame` as bytes arrive from the
   * replay client, instead of buffering the full response before framing it
   * (see ReplaySink doc: required for SSE / long-lived / large responses).
   */
  async execute(requestFrames: readonly Frame[], onFrame: FrameSink): Promise<void> {
    const first = requestFrames[0];
    if (!first) {
      return;
    }
    const streamId = first.streamId;
    const assembled = assembleRequest(requestFrames, this.maxBodyBytes);
    if (!assembled.ok) {
      await emitAll(onFrame, frameError(streamId, assembled.error.reason));
      return;
    }

    let htmlInjector: HtmlInjector | null = null;

    const emitBodyBytes = async (bytes: Uint8Array): Promise<void> => {
      for (const piece of chunkBody(bytes)) {
        const chunkPayload = createFramePayload(piece);
        if (isPayloadTooLargeError(chunkPayload)) {
          continue; // unreachable: chunkBody bounds every piece to MAX_PAYLOAD_SIZE
        }
        await onFrame({ type: FrameType.RESPONSE_BODY_CHUNK, streamId, payload: chunkPayload });
      }
    };

    const sink: ReplaySink = {
      onHead: async (head) => {
        const rewrittenHeaders = rewriteLocationIfPresent(head.headers);
        if (canInjectShim(rewrittenHeaders)) {
          htmlInjector = createHtmlInjector(WS_SHIM_SCRIPT_TAG);
          delete rewrittenHeaders['content-length']; // body length changes once the shim is inserted
        }
        const headPayload = createFramePayload(encodeResponseHead({ status: head.status, headers: rewrittenHeaders }));
        if (isPayloadTooLargeError(headPayload)) {
          await emitAll(onFrame, frameError(streamId, 'response head too large'));
          return;
        }
        await onFrame({ type: FrameType.RESPONSE_HEAD, streamId, payload: headPayload });
      },
      onChunk: async (chunk) => {
        await emitBodyBytes(htmlInjector ? htmlInjector.push(chunk) : chunk);
      },
      onEnd: async () => {
        if (htmlInjector) {
          await emitBodyBytes(htmlInjector.flush());
        }
        await onFrame({ type: FrameType.RESPONSE_END, streamId, payload: emptyPayload() });
      },
    };

    const replayed = await this.replayClient.replay(assembled.value, sink);
    if (!replayed.ok) {
      // Pre-head failure (connection refused, DNS, etc.) and a mid-stream abort
      // (upstream socket dropped after headers) both surface as a single ERROR
      // frame; the SW distinguishes them by whether it already resolved a
      // Response — see viewer/src/sw.ts handleRelayError.
      await emitAll(onFrame, frameError(streamId, replayed.error.reason));
    }
  }
}
