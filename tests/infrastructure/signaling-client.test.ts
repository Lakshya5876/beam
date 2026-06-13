import nodeDataChannel from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocketSignalingClient } from '../../src/infrastructure/signaling-client.js';
import { createSessionCode, isInvalidSessionCodeError, type SessionCode } from '../../src/domain/session.js';
import type { SignalingMessage } from '../../src/domain/interfaces.js';

type DcWebSocket = InstanceType<typeof nodeDataChannel.WebSocket>;

const CODE_RAW = 'k7x2m9q4w8r3t6y1u5z0a2b4c7';

function mustCode(): SessionCode {
  const code = createSessionCode(CODE_RAW);
  if (isInvalidSessionCodeError(code)) {
    throw new Error('test setup: invalid code');
  }
  return code;
}

let server: nodeDataChannel.WebSocketServer | null = null;
const signalingClients: WebSocketSignalingClient[] = [];

interface ServerHooks {
  onConnect?: (client: DcWebSocket) => void;
  onMessage?: (client: DcWebSocket, message: string) => void;
}

function startServer(hooks: ServerHooks = {}): number {
  const ws = new nodeDataChannel.WebSocketServer({ port: 0, bindAddress: '127.0.0.1' });
  server = ws;
  ws.onClient((client) => {
    // The server owns and closes its client sockets in stop(); the test does
    // not close them itself (a manual close + stop double-frees natively).
    client.onMessage((raw) => {
      hooks.onMessage?.(client, typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8'));
    });
    // A server-side push must wait for the socket to actually open — sending
    // before open throws natively ("WebSocket is not open").
    const fireConnect = (): void => hooks.onConnect?.(client);
    if (client.isOpen()) {
      fireConnect();
    } else {
      client.onOpen(fireConnect);
    }
  });
  return ws.port();
}

/** Construct a tracked client so afterEach can disconnect it deterministically. */
function makeClient(url: string, connectTimeoutMs?: number, maxInboundBytes?: number): WebSocketSignalingClient {
  const instance = new WebSocketSignalingClient(url, connectTimeoutMs, maxInboundBytes);
  signalingClients.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(signalingClients.map((client) => client.disconnect()));
  signalingClients.length = 0;
  if (server) {
    server.stop();
    server = null;
  }
});

// node-datachannel runs native threads; the worker must shut the library down
// cleanly before it exits, or the fork crashes on teardown.
afterAll(() => {
  nodeDataChannel.cleanup();
});

function waitFor<T>(executor: (resolve: (value: T) => void) => void, timeoutMs = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
    executor((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('WebSocketSignalingClient — URL construction', () => {
  it('appends the validated session code as a trailing path segment', () => {
    const client = makeClient('ws://127.0.0.1:9000/signal/');
    expect(client.buildUrl(mustCode())).toBe(`ws://127.0.0.1:9000/signal/${CODE_RAW}`);
  });
});

describe('WebSocketSignalingClient — connect / round-trip (real bundled server)', () => {
  it('connects to a live server and round-trips an opaque offer to the server', async () => {
    const received = await new Promise<string>((resolve) => {
      const port = startServer({ onMessage: (_c, message) => resolve(message) });
      const client = makeClient(`ws://127.0.0.1:${String(port)}`);
      void client.connect(mustCode()).then((result) => {
        expect(result.ok).toBe(true);
        void client.sendMessage({ kind: 'offer', payload: 'v=0 opaque-sdp' });
      });
    });
    expect(JSON.parse(received)).toEqual({ kind: 'offer', payload: 'v=0 opaque-sdp' });
  });

  it('delivers a server->client message parsed back into a SignalingMessage', async () => {
    const port = startServer({
      onConnect: (client) => {
        client.sendMessage(JSON.stringify({ kind: 'ice-candidate', payload: 'candidate:opaque' }));
      },
    });
    const client = makeClient(`ws://127.0.0.1:${String(port)}`);
    const delivered = await waitFor<SignalingMessage>((resolve) => {
      client.onMessage((m) => resolve(m));
      void client.connect(mustCode());
    });
    expect(delivered).toEqual({ kind: 'ice-candidate', payload: 'candidate:opaque' });
  });

  it('round-trips answer and ice-candidate kinds', async () => {
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      const port = startServer({
        onMessage: (_c, message) => {
          seen.push(JSON.parse(message).kind);
          if (seen.length === 2) {
            resolve();
          }
        },
      });
      const client = makeClient(`ws://127.0.0.1:${String(port)}`);
      void client.connect(mustCode()).then(() => {
        void client.sendMessage({ kind: 'answer', payload: 'a' });
        void client.sendMessage({ kind: 'ice-candidate', payload: 'c' });
      });
    });
    await done;
    expect(seen).toEqual(['answer', 'ice-candidate']);
  });
});

describe('WebSocketSignalingClient — totality of inbound handling', () => {
  it('drops malformed JSON and an unknown kind without delivering or throwing', async () => {
    const port = startServer({
      onConnect: (client) => {
        client.sendMessage('this is not json{');
        client.sendMessage(JSON.stringify({ kind: 'not-a-real-kind', payload: 'x' }));
        client.sendMessage(JSON.stringify({ kind: 'offer', payload: 'good' }));
      },
    });
    const client = makeClient(`ws://127.0.0.1:${String(port)}`);
    const delivered: SignalingMessage[] = [];
    await waitFor<SignalingMessage>((resolve) => {
      client.onMessage((m) => {
        delivered.push(m);
        resolve(m);
      });
      void client.connect(mustCode());
    });
    // Only the well-formed offer is delivered; the two bad frames were dropped.
    expect(delivered).toEqual([{ kind: 'offer', payload: 'good' }]);
  });

  it('drops an inbound message above the size cap while a small one passes', async () => {
    const oversized = 'x'.repeat(200);
    const port = startServer({
      onConnect: (client) => {
        // Sent first, but dropped by the 32-byte app-level cap.
        client.sendMessage(JSON.stringify({ kind: 'offer', payload: oversized }));
        // Small, well-formed: passes.
        client.sendMessage(JSON.stringify({ kind: 'answer', payload: 'ok' }));
      },
    });
    const client = makeClient(`ws://127.0.0.1:${String(port)}`, 10_000, 32);
    const delivered = await waitFor<SignalingMessage>((resolve) => {
      client.onMessage((m) => resolve(m));
      void client.connect(mustCode());
    });
    // The first message the handler ever sees is the small one — the oversized
    // frame was dropped before delivery.
    expect(delivered).toEqual({ kind: 'answer', payload: 'ok' });
  });
});

describe('WebSocketSignalingClient — connection state and failures', () => {
  it('sendMessage before connect returns SignalingNotConnected', async () => {
    const client = makeClient('ws://127.0.0.1:9');
    const result = await client.sendMessage({ kind: 'offer', payload: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'SignalingNotConnected' });
    }
  });

  it('a second connect while open is rejected as already-connected', async () => {
    const port = startServer();
    const client = makeClient(`ws://127.0.0.1:${String(port)}`);
    const first = await client.connect(mustCode());
    expect(first.ok).toBe(true);
    const second = await client.connect(mustCode());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.reason).toBe('already-connected');
    }
  });

  it('connect to a dead port resolves SignalingConnectFailed within the bounded timeout', async () => {
    const client = makeClient('ws://127.0.0.1:1', 2000);
    const result = await client.connect(mustCode());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('SignalingConnectFailed');
    }
  });

  it('disconnect closes the socket; a later sendMessage returns SignalingNotConnected', async () => {
    const port = startServer();
    const client = makeClient(`ws://127.0.0.1:${String(port)}`);
    await client.connect(mustCode());
    await client.disconnect();
    const result = await client.sendMessage({ kind: 'offer', payload: 'x' });
    expect(result.ok).toBe(false);
  });

  it('disconnect is idempotent when never connected', async () => {
    const client = makeClient('ws://127.0.0.1:9');
    await expect(client.disconnect()).resolves.toBeUndefined();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('onMessage unsubscribe stops delivery', async () => {
    const port = startServer();
    const client = makeClient(`ws://127.0.0.1:${String(port)}`);
    const received: SignalingMessage[] = [];
    const unsubscribe = client.onMessage((m) => received.push(m));
    unsubscribe();
    await client.connect(mustCode());
    // No server push configured; after unsubscribe nothing is delivered regardless.
    expect(received).toEqual([]);
  });
});
