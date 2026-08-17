/**
 * The OUTER shell's half of WebSocket relay: exposed on `window.__beamWsBridge`
 * so the injected shim running in the tunneled-app IFRAME (ws-shim.ts) can
 * reach the DataChannel mux through a direct same-origin `window.parent`
 * call — no postMessage plumbing needed, no service worker involved (a SW
 * can intercept fetch(), but there is no equivalent for `new WebSocket()`,
 * which is why this exists as a separate relay path from the HTTP one).
 *
 * Reuses the SAME StreamMultiplexer as HTTP relay (openStream/writeFrame/
 * onInbound) — a WS connection is just another stream on the one DataChannel.
 */

import {
  createFramePayload,
  createStreamId,
  decodeWsAcceptHead,
  decodeWsCloseInfo,
  encodeWsConnectHead,
  FrameType,
  frameWsClose,
  frameWsMessage,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  WsMessageReassembler,
  type Frame,
  type StreamId,
  type StreamMultiplexer,
} from './protocol-bridge.js';

export interface BeamWsHandlers {
  onOpen(protocol: string): void;
  onMessage(data: Uint8Array, isBinary: boolean): void;
  onClose(code: number, reason: string): void;
  onError(reason: string): void;
}

// Plain number, not the branded domain StreamId: this is the OUTER boundary
// of the relay (handed to the shim's WebSocket-lookalike object), so it
// carries no domain-layer guarantee. -1 is the sentinel for "never actually
// opened a stream" (concurrency cap hit) — send/close on it are no-ops.
export interface BeamWsHandle {
  readonly streamId: number;
}

const NO_STREAM: BeamWsHandle = { streamId: -1 };

export interface BeamWsBridge {
  open(path: string, protocols: readonly string[], handlers: BeamWsHandlers): BeamWsHandle;
  send(handle: BeamWsHandle, data: Uint8Array, isBinary: boolean): void;
  close(handle: BeamWsHandle, code: number, reason: string): void;
}

function decodeReasonText(payload: Uint8Array): string {
  try {
    return new TextDecoder().decode(payload) || 'rejected';
  } catch {
    return 'rejected';
  }
}

export function createWsBridge(mux: StreamMultiplexer): BeamWsBridge {
  const handlersByStream = new Map<number, BeamWsHandlers>();
  const reassemblers = new Map<number, WsMessageReassembler>();

  function handleAccept(frame: Frame, handlers: BeamWsHandlers): void {
    const head = decodeWsAcceptHead(frame.payload);
    handlers.onOpen(head?.protocol ?? '');
  }

  function handleReject(frame: Frame, handlers: BeamWsHandlers): void {
    handlers.onError(decodeReasonText(frame.payload));
    cleanup(frame.streamId);
  }

  function handleClose(frame: Frame, handlers: BeamWsHandlers): void {
    const info = decodeWsCloseInfo(frame.payload);
    handlers.onClose(info?.code ?? 1000, info?.reason ?? '');
    cleanup(frame.streamId);
  }

  function handleMessageFrame(frame: Frame, handlers: BeamWsHandlers): void {
    const message = reassemblers.get(frame.streamId)?.feed(frame);
    if (message) {
      handlers.onMessage(message.data, message.isBinary);
    }
  }

  function routeInbound(frame: Frame): void {
    const handlers = handlersByStream.get(frame.streamId);
    if (!handlers) {
      return;
    }
    if (frame.type === FrameType.WS_ACCEPT) {
      handleAccept(frame, handlers);
    } else if (frame.type === FrameType.WS_REJECT) {
      handleReject(frame, handlers);
    } else if (frame.type === FrameType.WS_CLOSE) {
      handleClose(frame, handlers);
    } else {
      handleMessageFrame(frame, handlers);
    }
  }

  function cleanup(streamId: number): void {
    handlersByStream.delete(streamId);
    reassemblers.delete(streamId);
  }

  mux.onInbound(routeInbound);

  return {
    open(path, protocols, handlers) {
      const idResult = mux.openStream();
      if (!idResult.ok) {
        queueMicrotask(() => {
          handlers.onError(`relay stream limit reached (${idResult.error.reason})`);
        });
        return NO_STREAM;
      }
      const streamId = idResult.value;
      handlersByStream.set(streamId, handlers);
      reassemblers.set(streamId, new WsMessageReassembler());

      const payload = createFramePayload(encodeWsConnectHead({ path, protocols: [...protocols] }));
      if (isPayloadTooLargeError(payload)) {
        queueMicrotask(() => {
          handlers.onError('connect request too large');
        });
        cleanup(streamId);
        return NO_STREAM;
      }
      mux.writeFrame({ type: FrameType.WS_CONNECT, streamId, payload });
      return { streamId };
    },
    send(handle, data, isBinary) {
      const streamId = toStreamId(handle.streamId);
      if (streamId === null) return;
      for (const f of frameWsMessage(streamId, data, isBinary)) {
        mux.writeFrame(f);
      }
    },
    close(handle, code, reason) {
      const streamId = toStreamId(handle.streamId);
      if (streamId === null) return;
      const f = frameWsClose(streamId, code, reason);
      if (f) {
        mux.writeFrame(f);
      }
      cleanup(streamId);
    },
  };
}

function toStreamId(raw: number): StreamId | null {
  const id = createStreamId(raw);
  return isInvalidStreamIdError(id) ? null : id;
}
