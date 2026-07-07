/**
 * WebSocket signaling client (design doc §10 S8, §A.2.4 spirit).
 * Implements the domain SignalingClient over node-datachannel's BUNDLED
 * dc.WebSocket — no separate `ws` dependency.
 *
 * The domain never parses SDP/ICE: SignalingMessage payloads are opaque
 * strings carried as JSON. The inbound path is total — malformed, oversized,
 * or wrong-shaped frames are dropped, never thrown, never delivered.
 */

import nodeDataChannel from 'node-datachannel';
import {
  err,
  ok,
  type Result,
  type SignalingClient,
  type SignalingConnectError,
  type SignalingMessage,
  type SignalingNotConnectedError,
  type Unsubscribe,
} from '../domain/interfaces.js';
import type { SessionCode } from '../domain/session.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_INBOUND_BYTES = 64 * 1024;

type DcWebSocket = InstanceType<typeof nodeDataChannel.WebSocket>;
type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

const VALID_KINDS: ReadonlySet<SignalingMessage['kind']> = new Set(['offer', 'answer', 'ice-candidate']);

function connectFailed(reason: string): SignalingConnectError {
  return { error: 'SignalingConnectFailed', reason };
}

function rawToText(raw: string | Buffer | ArrayBuffer): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  return Buffer.from(new Uint8Array(raw)).toString('utf8');
}

/** Total: any non-conforming input yields null (dropped), never a throw. */
function parseSignalingMessage(text: string): SignalingMessage | null {
  let parsed: unknown;
  try {
    // JSON.parse has no non-throwing form; malformed PEER input is expected,
    // so we convert it to a dropped message (null), not a crash.
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as { kind?: unknown; payload?: unknown };
  if (typeof candidate.kind !== 'string' || !VALID_KINDS.has(candidate.kind as SignalingMessage['kind'])) {
    return null;
  }
  if (typeof candidate.payload !== 'string') {
    return null;
  }
  return { kind: candidate.kind as SignalingMessage['kind'], payload: candidate.payload };
}

export class WebSocketSignalingClient implements SignalingClient {
  private socket: DcWebSocket | null = null;
  private state: ConnectionState = 'idle';
  private readonly handlers: Array<(message: SignalingMessage) => void> = [];
  private readonly log: (msg: string) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
    private readonly maxInboundBytes: number = DEFAULT_MAX_INBOUND_BYTES,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? ((): void => { /* noop */ });
  }

  /** Pure URL construction. SessionCode is branded [a-z0-9]{26,} — URL-safe. */
  buildUrl(code: SessionCode): string {
    const base = this.baseUrl.replace(/\/+$/, '').replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    return `${base}/${code}`;
  }

  connect(code: SessionCode): Promise<Result<undefined, SignalingConnectError>> {
    if (this.state === 'connecting' || this.state === 'open') {
      return Promise.resolve(err(connectFailed('already-connected')));
    }
    this.state = 'connecting';
    const url = this.buildUrl(code);
    this.log(`[HOST-SIG] connect url=${url}`);
    return new Promise<Result<undefined, SignalingConnectError>>((resolve) => {
      this.openSocket(url, resolve);
    });
  }

  private openSocket(url: string, resolve: (result: Result<undefined, SignalingConnectError>) => void): void {
    const socket = new nodeDataChannel.WebSocket();
    this.socket = socket;
    let settled = false;
    const finish = (result: Result<undefined, SignalingConnectError>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      this.state = 'closed';
      socket.forceClose();
      finish(err(connectFailed('connect timed out')));
    }, this.connectTimeoutMs);
    this.wireSocket(socket, finish);
    try {
      socket.open(url);
    } catch {
      this.state = 'closed';
      finish(err(connectFailed('failed to open socket')));
    }
  }

  private wireSocket(socket: DcWebSocket, finish: (result: Result<undefined, SignalingConnectError>) => void): void {
    socket.onOpen(() => {
      this.log('[HOST-SIG] WebSocket OPEN');
      this.state = 'open';
      finish(ok());
    });
    socket.onError((reason) => {
      this.log(`[HOST-SIG] WebSocket ERROR: ${reason}`);
      this.state = 'closed';
      finish(err(connectFailed(reason)));
    });
    socket.onClosed(() => {
      this.log('[HOST-SIG] WebSocket CLOSED');
      this.state = 'closed';
    });
    socket.onMessage((raw) => {
      this.handleInbound(raw);
    });
  }

  private handleInbound(raw: string | Buffer | ArrayBuffer): void {
    const text = rawToText(raw);
    if (Buffer.byteLength(text, 'utf8') > this.maxInboundBytes) {
      this.log(`[HOST-SIG] inbound DROPPED oversized len=${Buffer.byteLength(text, 'utf8')}`);
      return;
    }
    const message = parseSignalingMessage(text);
    if (!message) {
      this.log(`[HOST-SIG] inbound DROPPED unparseable: ${text.slice(0, 80)}`);
      return;
    }
    this.log(`[HOST-SIG] inbound kind=${message.kind}`);
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  sendMessage(message: SignalingMessage): Promise<Result<undefined, SignalingNotConnectedError>> {
    if (this.state !== 'open' || !this.socket) {
      this.log(`[HOST-SIG] sendMessage DROPPED (not connected) kind=${message.kind}`);
      return Promise.resolve(err({ error: 'SignalingNotConnected' }));
    }
    this.log(`[HOST-SIG] sending kind=${message.kind}`);
    try {
      this.socket.sendMessage(JSON.stringify({ kind: message.kind, payload: message.payload }));
    } catch {
      // The native socket can close underneath us between the state check and
      // the send (race); surface as not-connected rather than aborting.
      this.state = 'closed';
      return Promise.resolve(err({ error: 'SignalingNotConnected' }));
    }
    return Promise.resolve(ok());
  }

  registerPin(hash: string): Promise<Result<undefined, SignalingNotConnectedError>> {
    if (this.state !== 'open' || !this.socket) {
      return Promise.resolve(err({ error: 'SignalingNotConnected' }));
    }
    try {
      this.socket.sendMessage(JSON.stringify({ type: 'pin-register', hash }));
    } catch {
      this.state = 'closed';
      return Promise.resolve(err({ error: 'SignalingNotConnected' }));
    }
    return Promise.resolve(ok());
  }

  onMessage(handler: (message: SignalingMessage) => void): Unsubscribe {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.state = 'closed';
    return Promise.resolve();
  }
}
