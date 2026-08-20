/**
 * Injected into every relayed HTML response (see src/application/html-injection.ts
 * on the host side) as `<script type="module" src="/__beam/ws-shim.js">`.
 * Runs in the TUNNELED APP's own document — an iframe under the outer shell,
 * see pages.ts renderConnectedShell — and replaces `window.WebSocket` with a
 * lookalike that relays through `window.parent.__beamWsBridge` instead of
 * opening a real network socket. A service worker can intercept fetch(), but
 * there is no equivalent hook for `new WebSocket()`; this is the only way WS
 * traffic can go through the tunnel at all.
 *
 * Impure browser boundary (monkey-patches a global, depends on window.parent)
 * — not unit-tested here, same convention as browser-peer.ts /
 * browser-signaling.ts; verified live.
 */

export {}; // forces module scope so `declare global` below is valid TS syntax

interface BridgeHandlers {
  onOpen(protocol: string): void;
  onMessage(data: Uint8Array, isBinary: boolean): void;
  onClose(code: number, reason: string): void;
  onError(reason: string): void;
}
interface BridgeHandle {
  readonly streamId: number;
}
interface Bridge {
  open(path: string, protocols: string[], handlers: BridgeHandlers): BridgeHandle;
  send(handle: BridgeHandle, data: Uint8Array, isBinary: boolean): void;
  close(handle: BridgeHandle, code: number, reason: string): void;
}

declare global {
  interface Window {
    __beamWsBridge?: Bridge;
    /** Set by the OUTER window (bootstrap.ts) before this iframe exists —
     *  see announceIframeOwner below and that file's own doc comment. */
    __beamSessionCode?: string;
  }
}

const BRIDGE_WAIT_TIMEOUT_MS = 5000;
const BRIDGE_POLL_MS = 20;

/**
 * Tell the Service Worker which session this document belongs to, so every
 * fetch it makes (this page's own XHR/fetch calls, and any later in-place
 * navigation) is routed to the right session's DataChannel instead of
 * whichever tab's mux the SW heard from most recently — the Critical
 * cross-session relay hijack fixed by sw-session-registry.ts (see
 * SECURITY_AUDIT_20-08.md finding #1). `window.parent.__beamSessionCode` is
 * a same-origin, synchronous read (bootstrap.ts sets it before this iframe
 * is ever created) — no postMessage handshake needed for THIS document's own
 * announcement, only for re-announcing on request (see below).
 *
 * Runs once per page load, same as the WebSocket monkey-patch below — this
 * script is injected fresh into every relayed HTML response, so a full-page
 * navigation inside the iframe re-announces automatically with the new
 * document's own (new) client id.
 */
function announceIframeOwner(): void {
  const sessionCode = window.parent.__beamSessionCode;
  const controller = navigator.serviceWorker.controller;
  if (sessionCode && controller) {
    controller.postMessage({ type: 'iframe-owner', sessionCode });
  }
}

announceIframeOwner();

// SW-restart recovery: a Service Worker instance can be terminated by the
// browser while idle and restarted on the next fetch, losing its in-memory
// session registry entirely (module state, not the pages themselves). The
// restarted instance asks every window client to re-announce itself; this
// document's own script already ran once at load and won't re-run on its
// own, so it must listen and reply.
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown } | null;
    if (data && data.type === 'request-mux-ready') {
      announceIframeOwner();
    }
  });
}

/**
 * The bridge is installed on the OUTER window once its DataChannel mux is
 * ready, which can lag slightly behind this iframe's own document loading
 * (see bootstrap.ts). Poll briefly rather than failing immediately.
 */
function waitForBridge(): Promise<Bridge> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      const bridge = window.parent.__beamWsBridge;
      if (bridge) {
        resolve(bridge);
        return;
      }
      if (Date.now() - start > BRIDGE_WAIT_TIMEOUT_MS) {
        reject(new Error('beam relay bridge unavailable'));
        return;
      }
      setTimeout(poll, BRIDGE_POLL_MS);
    };
    poll();
  });
}

/** Only the path (+ query/hash) matters — the loopback server's own idea of its address is irrelevant to the relay. */
function toRelayPath(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

type OutgoingMessage = { readonly bytes: Uint8Array; readonly isBinary: boolean };

class BeamWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  readonly url: string;
  protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private bridge: Bridge | null = null;
  private handle: BridgeHandle | null = null;
  private readonly pending: OutgoingMessage[] = [];

  constructor(url: string | URL, protocols?: string | readonly string[]) {
    super();
    this.url = String(url);
    const protoList = protocols === undefined ? [] : Array.isArray(protocols) ? [...protocols] : [protocols as string];
    const path = toRelayPath(this.url);

    waitForBridge()
      .then((bridge) => {
        this.bridge = bridge;
        this.handle = bridge.open(path, protoList, {
          onOpen: (protocol) => {
            this.readyState = this.OPEN;
            this.protocol = protocol;
            for (const item of this.pending.splice(0)) {
              bridge.send(this.handle!, item.bytes, item.isBinary);
            }
            this.dispatch('open', new Event('open'));
          },
          onMessage: (data, isBinary) => {
            const payload = isBinary ? this.wrapBinary(data) : new TextDecoder().decode(data);
            this.dispatch('message', new MessageEvent('message', { data: payload }));
          },
          onClose: (code, reason) => {
            this.readyState = this.CLOSED;
            this.dispatch('close', new CloseEvent('close', { code, reason, wasClean: true }));
          },
          onError: (reason) => {
            this.readyState = this.CLOSED;
            this.dispatch('error', new Event('error'));
            this.dispatch('close', new CloseEvent('close', { code: 1006, reason, wasClean: false }));
          },
        });
      })
      .catch(() => {
        this.readyState = this.CLOSED;
        this.dispatch('error', new Event('error'));
        this.dispatch('close', new CloseEvent('close', { code: 1006, reason: 'relay unavailable', wasClean: false }));
      });
  }

  private wrapBinary(data: Uint8Array): ArrayBuffer | Blob {
    if (this.binaryType === 'arraybuffer') {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
    return new Blob([data as BlobPart]);
  }

  private dispatch(type: string, ev: Event): void {
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') {
      (handler as (e: Event) => void).call(this, ev);
    }
    this.dispatchEvent(ev);
  }

  /**
   * String/ArrayBuffer/typed-array sends are encoded SYNCHRONOUSLY, so calls
   * made back-to-back preserve their relative order exactly like a real
   * WebSocket's internal send queue would. Only a Blob payload — genuinely
   * rare for outgoing WS messages, and inherently async to read — can land
   * slightly out of order relative to a send() called immediately after it;
   * documented limitation (LIMITATIONS.md), not silently pretended away.
   */
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === this.CLOSING || (this.readyState as number) === this.CLOSED) {
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        this.enqueue({ bytes: new Uint8Array(buf), isBinary: true });
      });
      return;
    }
    this.enqueue(encodeSync(data));
  }

  private enqueue(message: OutgoingMessage): void {
    if (this.bridge && this.handle) {
      this.bridge.send(this.handle, message.bytes, message.isBinary);
    } else {
      this.pending.push(message);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === this.CLOSING || (this.readyState as number) === this.CLOSED) {
      return;
    }
    this.readyState = this.CLOSING;
    if (this.bridge && this.handle) {
      this.bridge.close(this.handle, code, reason);
    }
  }
}

function encodeSync(data: string | ArrayBufferLike | ArrayBufferView): OutgoingMessage {
  if (typeof data === 'string') {
    return { bytes: new TextEncoder().encode(data), isBinary: false };
  }
  if (ArrayBuffer.isView(data)) {
    return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), isBinary: true };
  }
  return { bytes: new Uint8Array(data), isBinary: true };
}

(window as unknown as { WebSocket: unknown }).WebSocket = BeamWebSocket;
