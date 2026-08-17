import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackWsRelayClient } from '../../src/infrastructure/ws-relay-client.js';
import type { WsRelaySessionHandlers } from '../../src/domain/interfaces.js';

/**
 * Minimal hand-rolled RFC 6455 WebSocket echo server — no new dependency,
 * same technique already used to smoke-test Node's built-in WebSocket client
 * during development. Only what LoopbackWsRelayClient actually needs:
 * accept the handshake, decode a client (masked) text frame, echo it back
 * prefixed, and honor a clean close handshake.
 */
function wsAccept(key: string): string {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer } {
  const second = buf[1] ?? 0;
  const opcode = (buf[0] ?? 0) & 0x0f;
  const masked = (second & 0x80) !== 0;
  let len = second & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  if (!masked) {
    return { opcode, payload: buf.subarray(offset, offset + len) };
  }
  const maskKey = buf.subarray(offset, offset + 4);
  const data = buf.subarray(offset + 4, offset + 4 + len);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) {
    payload[i] = (data[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
  }
  return { opcode, payload };
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(2 + payload.length);
  frame[0] = 0x80 | opcode;
  frame[1] = payload.length; // test payloads are always < 126 bytes
  payload.copy(frame, 2);
  return frame;
}

interface EchoServerOptions {
  readonly path?: string;
  readonly onConnect?: (req: http.IncomingMessage) => void;
}

async function startEchoServer(options: EchoServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer();
  const openSockets = new Set<import('node:stream').Duplex>();
  server.on('upgrade', (req, socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    if (options.path && req.url !== options.path) {
      socket.destroy();
      return;
    }
    options.onConnect?.(req);
    const key = req.headers['sec-websocket-key'] as string;
    const protocol = req.headers['sec-websocket-protocol'];
    const acceptedProtocol = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() : undefined;
    const headerLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      ...(acceptedProtocol ? [`Sec-WebSocket-Protocol: ${acceptedProtocol}`] : []),
      '',
      '',
    ];
    socket.write(headerLines.join('\r\n'));
    socket.on('data', (buf: Buffer) => {
      const { opcode, payload } = decodeClientFrame(buf);
      if (opcode === 0x8) {
        // close frame: echo a close frame back, then end.
        socket.write(encodeServerFrame(0x8, Buffer.alloc(0)));
        socket.end();
        return;
      }
      const isBinary = opcode === 0x2;
      const reply = isBinary ? payload : Buffer.from(`echo:${payload.toString('utf8')}`, 'utf8');
      socket.write(encodeServerFrame(isBinary ? 0x2 : 0x1, reply));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-destroy any lingering upgraded sockets — http.Server.close()
        // otherwise waits indefinitely for keep-alive connections to end on
        // their own, which the test client doesn't always do (it may just
        // stop reading after resolving its own onClose).
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

function collect(): { handlers: WsRelaySessionHandlers; events: string[]; messages: Array<{ data: Uint8Array; isBinary: boolean }> } {
  const events: string[] = [];
  const messages: Array<{ data: Uint8Array; isBinary: boolean }> = [];
  const handlers: WsRelaySessionHandlers = {
    onOpen: (protocol) => events.push(`open:${protocol}`),
    onMessage: (data, isBinary) => messages.push({ data, isBinary }),
    onClose: (code, reason) => events.push(`close:${String(code)}:${reason}`),
    onError: (reason) => events.push(`error:${reason}`),
  };
  return { handlers, events, messages };
}

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('LoopbackWsRelayClient — real WebSocket round trip', () => {
  it('connects, exchanges a text message, and closes cleanly', async () => {
    const server = await startEchoServer();
    cleanup = server.close;
    const client = new LoopbackWsRelayClient(server.port);
    const { handlers, events, messages } = collect();

    const session = client.connect({ path: '/', protocols: [] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('open:')));

    session.send(new TextEncoder().encode('hello'), false);
    await waitFor(() => messages.length > 0);
    expect(new TextDecoder().decode(messages[0]!.data)).toBe('echo:hello');
    expect(messages[0]!.isBinary).toBe(false);

    session.close(1000, 'done');
    await waitFor(() => events.some((e) => e.startsWith('close:')));
  });

  it('relays a binary message byte-for-byte', async () => {
    const server = await startEchoServer();
    cleanup = server.close;
    const client = new LoopbackWsRelayClient(server.port);
    const { handlers, events, messages } = collect();

    const session = client.connect({ path: '/', protocols: [] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('open:')));

    const bytes = new Uint8Array([1, 2, 3, 4, 250]);
    session.send(bytes, true);
    await waitFor(() => messages.length > 0);
    expect(Array.from(messages[0]!.data)).toEqual(Array.from(bytes));
    expect(messages[0]!.isBinary).toBe(true);
  });

  it('negotiates the requested subprotocol', async () => {
    const server = await startEchoServer();
    cleanup = server.close;
    const client = new LoopbackWsRelayClient(server.port);
    const { handlers, events } = collect();

    client.connect({ path: '/', protocols: ['beam-proto'] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('open:')));
    expect(events).toContain('open:beam-proto');
  });

  it('dials only the constructed loopback port, ignoring the path as if it were a full URL', async () => {
    const server = await startEchoServer({ path: '/exact' });
    cleanup = server.close;
    const client = new LoopbackWsRelayClient(server.port);
    const { handlers, events } = collect();

    client.connect({ path: '/exact', protocols: [] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('open:')));
    expect(events).toEqual(['open:']);
  });
});

describe('LoopbackWsRelayClient — totality and validation (never throws)', () => {
  it('reports onError, never throws, when the connection is refused', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = new LoopbackWsRelayClient(deadPort);
    const { handlers, events } = collect();
    expect(() => client.connect({ path: '/', protocols: [] }, handlers)).not.toThrow();
    await waitFor(() => events.some((e) => e.startsWith('error:')));
  });

  it('rejects a path with CRLF before ever opening a socket', async () => {
    const client = new LoopbackWsRelayClient(9); // port 9 (discard) — never actually dialed if validation is correct
    const { handlers, events } = collect();
    client.connect({ path: '/x\r\nInjected: evil', protocols: [] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('error:')));
    expect(events[0]).toContain('control characters');
  });

  it('rejects a path traversal sequence before ever opening a socket', async () => {
    const client = new LoopbackWsRelayClient(9);
    const { handlers, events } = collect();
    client.connect({ path: '/../etc/passwd', protocols: [] }, handlers);
    await waitFor(() => events.some((e) => e.startsWith('error:')));
    expect(events[0]).toContain('traversal');
  });
});
