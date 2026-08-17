/**
 * Protocol bridge — the viewer's single point of contact with the CORE shared
 * protocol. It imports frame.ts and protocol.ts from the core package
 * READ-ONLY (../../src/**) and re-exports them, so the viewer multiplexes and
 * frames over the EXACT SAME implementation as the host. The wire-protocol ends
 * cannot drift, because there is only one implementation — never a reimplementation.
 */

import {
  createFramePayload,
  createStreamId,
  decodeFrame,
  encodeFrame,
  FrameType,
  HEADER_SIZE,
  MAX_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  isFrameDecodeError,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
  type StreamId,
} from '../../src/domain/frame.js';
import { StreamMultiplexer } from '../../src/application/protocol.js';
import { err, ok, type PeerTransport, type Result, type Unsubscribe } from '../../src/domain/interfaces.js';
import {
  decodeWsAcceptHead,
  decodeWsCloseInfo,
  decodeWsConnectHead,
  encodeWsCloseInfo,
  encodeWsConnectHead,
  frameWsAccept,
  frameWsClose,
  frameWsMessage,
  WsMessageReassembler,
  type WsCloseInfo,
  type WsConnectHead,
} from '../../src/application/ws-relay-use-case.js';

/** Build the viewer-side multiplexer over a byte transport using the shared mux. */
export function createViewerMultiplexer(transport: PeerTransport): StreamMultiplexer {
  return new StreamMultiplexer(transport);
}

// Re-export the canonical codec + frame builders so viewer code only ever
// touches the CORE protocol through this single bridge — never reimplemented.
export {
  createFramePayload,
  createStreamId,
  decodeFrame,
  encodeFrame,
  FrameType,
  HEADER_SIZE,
  MAX_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  isFrameDecodeError,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  StreamMultiplexer,
  decodeWsAcceptHead,
  decodeWsCloseInfo,
  decodeWsConnectHead,
  encodeWsCloseInfo,
  encodeWsConnectHead,
  frameWsAccept,
  frameWsClose,
  frameWsMessage,
  WsMessageReassembler,
  err,
  ok,
};
export type { Frame, PeerTransport, Result, StreamId, Unsubscribe, WsCloseInfo, WsConnectHead };
