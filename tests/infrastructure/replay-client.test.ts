import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackReplayClient } from '../../src/infrastructure/replay-client.js';
import type { ReplayRequest } from '../../src/domain/interfaces.js';

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server | null = null;

async function startServer(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, LOOPBACK, resolve);
  });
  return (server?.address() as AddressInfo).port;
}

const LOOPBACK = '127.0.0.1';

afterEach(async () => {
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
});

/** Capturing handler: records each request and echoes a fixed or body reply. */
function capturing(into: Captured[], echoBody = false): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      into.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = 201;
      res.setHeader('x-server', 'beam-test');
      res.end(echoBody ? body : 'ok');
    });
  };
}

function request(overrides: Partial<ReplayRequest>): ReplayRequest {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    body: new Uint8Array(0),
    ...overrides,
  };
}

describe('LoopbackReplayClient — faithful relay (real loopback server)', () => {
  it('relays method, path, and body and returns the server status/headers/body', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    const result = await client.replay(
      request({ method: 'POST', path: '/api/items?p=2', headers: { 'x-demo': 'yes' }, body: new TextEncoder().encode('hello') }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(201);
      expect(result.value.headers['x-server']).toBe('beam-test');
      expect(new TextDecoder().decode(result.value.body)).toBe('ok');
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe('/api/items?p=2');
    expect(captured[0]?.headers['x-demo']).toBe('yes');
    expect(captured[0]?.body.toString()).toBe('hello');
  });

  it('round-trips a binary body byte-for-byte', async () => {
    const port = await startServer(capturing([], true));
    const client = new LoopbackReplayClient(port);
    const bytes = new Uint8Array(256).map((_, i) => i);

    const result = await client.replay(request({ method: 'PUT', path: '/blob', body: bytes }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.value.body)).toEqual(Array.from(bytes));
    }
  });
});

describe('LoopbackReplayClient — header hygiene', () => {
  it('strips hop-by-hop headers and keeps ordinary ones', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    await client.replay(
      request({
        headers: {
          'transfer-encoding': 'chunked',
          upgrade: 'websocket',
          'x-keep': 'kept',
        },
      }),
    );

    const received = captured[0]?.headers ?? {};
    expect(received['transfer-encoding']).toBeUndefined();
    expect(received.upgrade).toBeUndefined();
    expect(received['x-keep']).toBe('kept');
  });

  it('sets Host to the loopback target, ignoring a viewer-supplied Host', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    await client.replay(request({ headers: { host: 'evil.example.com' } }));

    expect(captured[0]?.headers.host).toBe(`${LOOPBACK}:${String(port)}`);
  });
});

describe('LoopbackReplayClient — injection-safe (rejects before sending)', () => {
  it('rejects a header NAME containing CRLF and the server receives nothing', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    const result = await client.replay(request({ headers: { 'x-bad\r\nInjected: evil': 'v' } }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('ReplayFailed');
    }
    expect(captured).toHaveLength(0);
  });

  it('rejects a header VALUE containing CRLF and the server receives nothing', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    const result = await client.replay(request({ headers: { 'x-bad': 'v\r\nGET /evil HTTP/1.1' } }));

    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('rejects a path containing CRLF and the server receives nothing', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    const result = await client.replay(request({ path: '/x\r\nGET /evil HTTP/1.1' }));

    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

describe('LoopbackReplayClient — totality and port confinement', () => {
  it('returns a typed error (never throws) when the connection is refused', async () => {
    // Bind then release a port to guarantee it is free, then point at it.
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, LOOPBACK, resolve));
    const deadPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const client = new LoopbackReplayClient(deadPort);
    const result = await client.replay(request({}));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('ReplayFailed');
    }
  });

  it('is confined to the construction port — a URL-shaped path still lands on that server', async () => {
    const captured: Captured[] = [];
    const port = await startServer(capturing(captured));
    const client = new LoopbackReplayClient(port);

    // A hostile path that looks like an absolute URL to another host:port is
    // sent only as a request path; host/port remain the constructed loopback.
    await client.replay(request({ path: '/proxy?target=http://other.example:9999/x' }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.host).toBe(`${LOOPBACK}:${String(port)}`);
    expect(captured[0]?.url).toBe('/proxy?target=http://other.example:9999/x');
  });
});
