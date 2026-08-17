/**
 * WebSocket relay use-case: orchestrates one WS_CONNECT..WS_CLOSE lifecycle
 * over a single stream id, symmetrically with ExecuteRelayUseCase's HTTP
 * request/response lifecycle. A service worker cannot intercept
 * `new WebSocket()` (see viewer/src/ws-shim.ts for the page-level shim this
 * pairs with), so this is a genuinely separate relay path, not a variant of
 * the HTTP one — but it reuses the same Frame/StreamMultiplexer machinery.
 *
 * Message framing: one WS message becomes WS_MESSAGE_HEAD (1-byte isBinary
 * flag) + WS_MESSAGE_CHUNK* (payload split at MAX_PAYLOAD_SIZE) +
 * WS_MESSAGE_END — mirroring REQUEST_HEAD/BODY_CHUNK/END so a message
 * larger than one frame still has an unambiguous boundary. WS_MESSAGE_END
 * does NOT close the stream (see protocol.ts releasesBufferOnly) — only
 * WS_CLOSE does.
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
import type { WsRelayClient, WsRelaySession } from '../domain/interfaces.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface WsConnectHead {
  readonly path: string;
  readonly protocols: readonly string[];
}

export interface WsAcceptHead {
  readonly protocol: string;
}

export interface WsCloseInfo {
  readonly code: number;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

export function decodeWsConnectHead(bytes: Uint8Array): WsConnectHead | null {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || typeof parsed.path !== 'string') {
    return null;
  }
  const protocols = Array.isArray(parsed.protocols) ? parsed.protocols.filter((p): p is string => typeof p === 'string') : [];
  return { path: parsed.path, protocols };
}

export function encodeWsConnectHead(head: WsConnectHead): Uint8Array {
  return utf8Encoder.encode(JSON.stringify({ path: head.path, protocols: head.protocols }));
}

export function decodeWsAcceptHead(bytes: Uint8Array): WsAcceptHead | null {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || typeof parsed.protocol !== 'string') {
    return null;
  }
  return { protocol: parsed.protocol };
}

export function encodeWsAcceptHead(head: WsAcceptHead): Uint8Array {
  return utf8Encoder.encode(JSON.stringify({ protocol: head.protocol }));
}

export function decodeWsCloseInfo(bytes: Uint8Array): WsCloseInfo | null {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || typeof parsed.code !== 'number') {
    return null;
  }
  return { code: parsed.code, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
}

export function encodeWsCloseInfo(info: WsCloseInfo): Uint8Array {
  return utf8Encoder.encode(JSON.stringify({ code: info.code, reason: info.reason }));
}

function payloadOf(bytes: Uint8Array): FramePayload | null {
  const payload = createFramePayload(bytes);
  return isPayloadTooLargeError(payload) ? null : payload;
}

function frame(type: FrameType, streamId: StreamId, bytes: Uint8Array): Frame | null {
  const payload = payloadOf(bytes);
  return payload ? { type, streamId, payload } : null;
}

/** Frame one outbound WS message as HEAD + CHUNK* + END. Oversized-payload cases are unreachable given the fixed-size flag byte and MAX_PAYLOAD_SIZE chunking, but are skipped defensively rather than corrupting the boundary. */
export function frameWsMessage(streamId: StreamId, data: Uint8Array, isBinary: boolean): Frame[] {
  const frames: Frame[] = [];
  const head = frame(FrameType.WS_MESSAGE_HEAD, streamId, new Uint8Array([isBinary ? 1 : 0]));
  if (head) frames.push(head);
  for (let offset = 0; offset < data.byteLength; offset += MAX_PAYLOAD_SIZE) {
    const chunk = frame(FrameType.WS_MESSAGE_CHUNK, streamId, data.subarray(offset, Math.min(offset + MAX_PAYLOAD_SIZE, data.byteLength)));
    if (chunk) frames.push(chunk);
  }
  const end = frame(FrameType.WS_MESSAGE_END, streamId, new Uint8Array(0));
  if (end) frames.push(end);
  return frames;
}

export function frameWsAccept(streamId: StreamId, protocol: string): Frame | null {
  return frame(FrameType.WS_ACCEPT, streamId, encodeWsAcceptHead({ protocol }));
}

export function frameWsReject(streamId: StreamId, reason: string): Frame | null {
  return frame(FrameType.WS_REJECT, streamId, utf8Encoder.encode(reason));
}

export function frameWsClose(streamId: StreamId, code: number, reason: string): Frame | null {
  return frame(FrameType.WS_CLOSE, streamId, encodeWsCloseInfo({ code, reason }));
}

export interface ReassembledMessage {
  readonly data: Uint8Array;
  readonly isBinary: boolean;
}

/**
 * Reassembles one WS_MESSAGE_HEAD + CHUNK(s) + END triad into a complete message.
 * Shared by BOTH directions on BOTH ends of the relay — the host reassembling
 * viewer->host frames (HostWsRelaySession below) and the viewer reassembling
 * host->viewer frames (viewer/src/ws-bridge.ts) are the exact same logic, so
 * it lives here once rather than being written twice.
 */
export class WsMessageReassembler {
  private binary = false;
  private chunks: Uint8Array[] = [];

  /** Feed one frame; returns the complete message once WS_MESSAGE_END arrives, else null. */
  feed(f: Frame): ReassembledMessage | null {
    if (f.type === FrameType.WS_MESSAGE_HEAD) {
      this.binary = f.payload[0] === 1;
      this.chunks = [];
      return null;
    }
    if (f.type === FrameType.WS_MESSAGE_CHUNK) {
      this.chunks.push(f.payload);
      return null;
    }
    if (f.type !== FrameType.WS_MESSAGE_END) {
      return null;
    }
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    return { data: body, isBinary: this.binary };
  }
}

/**
 * One relayed WS connection's host-side state machine. Owns message
 * reassembly for BOTH directions: inbound wire frames (viewer -> host,
 * reassembled here before handing a complete message to the local
 * WsRelaySession) and the local session's inbound events (host's localhost
 * app -> viewer, framed here for the caller to write to the mux).
 *
 * isClosed() semantics: becomes true exactly once, when the LOCAL WebSocket
 * (whichever side asked for the close) actually finishes closing and its
 * onClose callback fires — never set eagerly on a mere close REQUEST. The
 * caller (composition.ts) uses isClosed() to know when it may drop its
 * bookkeeping for this stream; dropping it before the outbound WS_CLOSE
 * frame is actually emitted would mean that frame never gets sent.
 */
export class HostWsRelaySession {
  private readonly session: WsRelaySession;
  private readonly inbound = new WsMessageReassembler();
  private closed = false;

  constructor(
    private readonly streamId: StreamId,
    private readonly connectHead: WsConnectHead,
    client: WsRelayClient,
    private readonly onFrame: (frame: Frame) => void,
  ) {
    this.session = client.connect(
      { path: connectHead.path, protocols: connectHead.protocols },
      {
        onOpen: (protocol) => {
          const accept = frameWsAccept(this.streamId, protocol);
          if (accept) this.onFrame(accept);
        },
        onMessage: (data, isBinary) => {
          for (const f of frameWsMessage(this.streamId, data, isBinary)) {
            this.onFrame(f);
          }
        },
        onClose: (code, reason) => {
          this.finish(code, reason);
        },
        onError: (reason) => {
          const reject = frameWsReject(this.streamId, reason);
          if (reject) this.onFrame(reject);
          this.finish(1011, reason);
        },
      },
    );
  }

  /** Feed one inbound wire frame belonging to this stream (viewer -> host direction). */
  acceptInbound(f: Frame): void {
    if (this.closed) {
      return;
    }
    if (f.type === FrameType.WS_CLOSE) {
      this.handleInboundClose(f);
      return;
    }
    const message = this.inbound.feed(f);
    if (message) {
      this.session.send(message.data, message.isBinary);
    }
  }

  /**
   * A viewer-initiated close asks the LOCAL WebSocket to close; `closed` is
   * NOT set here — it is set exactly once, by finish() below, when the local
   * socket's own onClose callback actually fires. That is the single source
   * of truth for "this session is done" (see class doc for why: the caller
   * needs isClosed() to become true precisely when it can drop this session
   * from its bookkeeping, which is only true once the outbound WS_CLOSE
   * frame has actually been emitted).
   */
  private handleInboundClose(f: Frame): void {
    const info = decodeWsCloseInfo(f.payload);
    this.session.close(info?.code ?? 1000, info?.reason ?? '');
  }

  private finish(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const close = frameWsClose(this.streamId, code, reason);
    if (close) this.onFrame(close);
  }

  isClosed(): boolean {
    return this.closed;
  }
}
