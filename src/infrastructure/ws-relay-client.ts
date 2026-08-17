/**
 * Loopback WebSocket relay client. Implements the domain WsRelayClient
 * interface using Node's built-in global WebSocket (client-only; stable in
 * Node >= 22 via undici) — no new runtime dependency.
 *
 * Security invariants mirror LoopbackReplayClient (S5):
 *   - Connects ONLY to ws://127.0.0.1:<port> — the port is a private
 *     readonly field set at construction; nothing viewer-supplied can
 *     redirect the connection to another host or port.
 *   - CR/LF/NUL and path-traversal patterns in the path are rejected before
 *     any socket is opened, via the same guards replay-client.ts uses.
 *   - connect() is total: it never throws; every failure reaches the caller
 *     through handlers.onError, never an unhandled rejection.
 *
 * Note on auth: the browser WebSocket API does not let page JS set custom
 * handshake headers, and this Node client dials from a separate process —
 * so cookies the viewer's browser holds are NOT forwarded to the localhost
 * WebSocket handshake. Apps that gate a WS connection on cookie-based
 * session auth will not authenticate over the relay (documented in
 * LIMITATIONS.md). Unauthenticated WS use (HMR, most realtime demos) is
 * unaffected.
 */

import { containsControlChars, containsPathTraversal, LOOPBACK_HOST } from './loopback-validation.js';
import type { WsConnectRequest, WsRelayClient, WsRelaySession, WsRelaySessionHandlers } from '../domain/interfaces.js';

function validatePath(path: string): string | null {
  if (containsControlChars(path)) {
    return 'path contains control characters';
  }
  if (containsPathTraversal(path)) {
    return 'path traversal not permitted';
  }
  return null;
}

const NOOP_SESSION: WsRelaySession = {
  send: () => undefined,
  close: () => undefined,
};

function safeReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'websocket request failed';
}

export class LoopbackWsRelayClient implements WsRelayClient {
  constructor(private readonly port: number) {}

  connect(request: WsConnectRequest, handlers: WsRelaySessionHandlers): WsRelaySession {
    const invalid = validatePath(request.path);
    if (invalid) {
      queueMicrotask(() => {
        handlers.onError(invalid);
      });
      return NOOP_SESSION;
    }

    const url = `ws://${LOOPBACK_HOST}:${String(this.port)}${request.path}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [...request.protocols]);
    } catch (error) {
      queueMicrotask(() => {
        handlers.onError(safeReason(error));
      });
      return NOOP_SESSION;
    }
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      handlers.onOpen(socket.protocol);
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        handlers.onMessage(new TextEncoder().encode(event.data), false);
      } else {
        handlers.onMessage(new Uint8Array(event.data as ArrayBuffer), true);
      }
    });
    socket.addEventListener('close', (event) => {
      handlers.onClose(event.code, event.reason);
    });
    socket.addEventListener('error', () => {
      handlers.onError('websocket error');
    });

    return {
      send(data, isBinary) {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          socket.send(isBinary ? data : new TextDecoder().decode(data));
        } catch {
          // Socket closed between the readyState check and send — drop silently.
        }
      },
      close(code, reason) {
        try {
          // A close code outside the valid application range (3000-4999) or
          // the single standard 1000 makes the native WebSocket throw; fall
          // back to a codeless close rather than letting that escape.
          if (code === 1000 || (code >= 3000 && code <= 4999)) {
            socket.close(code, reason);
          } else {
            socket.close();
          }
        } catch {
          // Already closed/closing — nothing to do.
        }
      },
    };
  }
}
