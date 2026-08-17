import { describe, expect, it } from 'vitest';
import { createStreamId, FrameType, isInvalidStreamIdError, type Frame, type StreamId } from '../../src/domain/frame.js';
import type { WsConnectRequest, WsRelayClient, WsRelaySession, WsRelaySessionHandlers } from '../../src/domain/interfaces.js';
import {
  decodeWsCloseInfo,
  decodeWsConnectHead,
  encodeWsConnectHead,
  frameWsClose,
  frameWsMessage,
  HostWsRelaySession,
  WsMessageReassembler,
} from '../../src/application/ws-relay-use-case.js';

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  return id;
}

const utf8 = new TextEncoder();
const decode = new TextDecoder();

/** A controllable WsRelayClient fake: the test drives the fake localhost connection's events directly. */
class FakeWsRelayClient implements WsRelayClient {
  public lastRequest: WsConnectRequest | null = null;
  public handlers: WsRelaySessionHandlers | null = null;
  public sent: Array<{ data: Uint8Array; isBinary: boolean }> = [];
  public closed: Array<{ code: number; reason: string }> = [];

  connect(request: WsConnectRequest, handlers: WsRelaySessionHandlers): WsRelaySession {
    this.lastRequest = request;
    this.handlers = handlers;
    return {
      send: (data, isBinary) => {
        this.sent.push({ data, isBinary });
      },
      // A real WebSocket's close() always eventually fires its OWN onClose
      // callback (WHATWG contract) — the fake mirrors that so tests observe
      // the same "closed becomes true only when onClose actually fires"
      // timing HostWsRelaySession depends on (see its isClosed() doc).
      close: (code, reason) => {
        this.closed.push({ code, reason });
        handlers.onClose(code, reason);
      },
    };
  }
}

describe('WS head codecs', () => {
  it('WS connect head round-trips', () => {
    const decoded = decodeWsConnectHead(encodeWsConnectHead({ path: '/socket', protocols: ['chat', 'v2'] }));
    expect(decoded).toEqual({ path: '/socket', protocols: ['chat', 'v2'] });
  });

  it('decodeWsConnectHead rejects malformed input', () => {
    expect(decodeWsConnectHead(utf8.encode('not json'))).toBeNull();
    expect(decodeWsConnectHead(utf8.encode(JSON.stringify({ protocols: [] })))).toBeNull();
  });

  it('decodeWsCloseInfo defaults reason to empty string when absent', () => {
    const decoded = decodeWsCloseInfo(utf8.encode(JSON.stringify({ code: 1000 })));
    expect(decoded).toEqual({ code: 1000, reason: '' });
  });
});

describe('frameWsMessage', () => {
  it('frames a message as HEAD(isBinary) + CHUNK + END', () => {
    const frames = frameWsMessage(sid(1), utf8.encode('hello'), false);
    expect(frames.map((f) => f.type)).toEqual([FrameType.WS_MESSAGE_HEAD, FrameType.WS_MESSAGE_CHUNK, FrameType.WS_MESSAGE_END]);
    expect(frames[0]!.payload[0]).toBe(0);
    expect(decode.decode(frames[1]!.payload)).toBe('hello');
  });

  it('sets the isBinary flag byte for binary messages', () => {
    const frames = frameWsMessage(sid(1), new Uint8Array([1, 2, 3]), true);
    expect(frames[0]!.payload[0]).toBe(1);
  });

  it('frames an empty message as HEAD + END (no chunk)', () => {
    const frames = frameWsMessage(sid(1), new Uint8Array(0), false);
    expect(frames.map((f) => f.type)).toEqual([FrameType.WS_MESSAGE_HEAD, FrameType.WS_MESSAGE_END]);
  });
});

describe('WsMessageReassembler', () => {
  it('returns null until END, then the complete message', () => {
    const r = new WsMessageReassembler();
    expect(r.feed(frameWsMessage(sid(1), utf8.encode('ab'), false)[0]!)).toBeNull();
    expect(r.feed(frameWsMessage(sid(1), utf8.encode('ab'), false)[1]!)).toBeNull();
    const result = r.feed(frameWsMessage(sid(1), utf8.encode('ab'), false)[2]!);
    expect(result).not.toBeNull();
    expect(decode.decode(result!.data)).toBe('ab');
    expect(result!.isBinary).toBe(false);
  });

  it('is reusable across multiple messages on the same connection', () => {
    const r = new WsMessageReassembler();
    for (const f of frameWsMessage(sid(1), utf8.encode('first'), false)) r.feed(f);
    let second: ReturnType<WsMessageReassembler['feed']> = null;
    for (const f of frameWsMessage(sid(1), utf8.encode('second'), true)) {
      second = r.feed(f);
    }
    expect(decode.decode(second!.data)).toBe('second');
    expect(second!.isBinary).toBe(true);
  });

  it('ignores a non-WS frame type, returning null', () => {
    const r = new WsMessageReassembler();
    expect(r.feed({ type: FrameType.PING, streamId: sid(1), payload: new Uint8Array(0) as unknown as Frame['payload'] })).toBeNull();
  });
});

describe('HostWsRelaySession — connect lifecycle', () => {
  it('dials the WsRelayClient with the decoded path/protocols and emits WS_ACCEPT on open', () => {
    const client = new FakeWsRelayClient();
    const emitted: Frame[] = [];
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: ['proto-a'] }))!;
    new HostWsRelaySession(sid(7), head, client, (f) => emitted.push(f));

    expect(client.lastRequest).toEqual({ path: '/ws', protocols: ['proto-a'] });

    client.handlers!.onOpen('proto-a');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe(FrameType.WS_ACCEPT);
  });

  it('emits WS_REJECT and does not crash on a connect-time error', () => {
    const client = new FakeWsRelayClient();
    const emitted: Frame[] = [];
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/down', protocols: [] }))!;
    new HostWsRelaySession(sid(1), head, client, (f) => emitted.push(f));

    client.handlers!.onError('ECONNREFUSED');
    expect(emitted.map((f) => f.type)).toEqual([FrameType.WS_REJECT, FrameType.WS_CLOSE]);
    expect(decode.decode(emitted[0]!.payload)).toBe('ECONNREFUSED');
  });
});

describe('HostWsRelaySession — message relay both directions', () => {
  it('reassembles an inbound HEAD+CHUNK+END into one session.send call with the right bytes/isBinary', () => {
    const client = new FakeWsRelayClient();
    const emitted: Frame[] = [];
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    const session = new HostWsRelaySession(sid(3), head, client, (f) => emitted.push(f));

    for (const f of frameWsMessage(sid(3), utf8.encode('ping'), false)) {
      session.acceptInbound(f);
    }

    expect(client.sent).toHaveLength(1);
    expect(decode.decode(client.sent[0]!.data)).toBe('ping');
    expect(client.sent[0]!.isBinary).toBe(false);
  });

  it('reassembles a multi-chunk inbound message correctly', () => {
    const client = new FakeWsRelayClient();
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    const session = new HostWsRelaySession(sid(4), head, client, () => undefined);

    session.acceptInbound({ type: FrameType.WS_MESSAGE_HEAD, streamId: sid(4), payload: new Uint8Array([1]) as unknown as Frame['payload'] });
    session.acceptInbound({ type: FrameType.WS_MESSAGE_CHUNK, streamId: sid(4), payload: new Uint8Array([1, 2]) as unknown as Frame['payload'] });
    session.acceptInbound({ type: FrameType.WS_MESSAGE_CHUNK, streamId: sid(4), payload: new Uint8Array([3, 4]) as unknown as Frame['payload'] });
    session.acceptInbound({ type: FrameType.WS_MESSAGE_END, streamId: sid(4), payload: new Uint8Array(0) as unknown as Frame['payload'] });

    expect(Array.from(client.sent[0]!.data)).toEqual([1, 2, 3, 4]);
    expect(client.sent[0]!.isBinary).toBe(true);
  });

  it('frames a local (host -> viewer) message from the WsRelayClient onMessage callback', () => {
    const client = new FakeWsRelayClient();
    const emitted: Frame[] = [];
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    new HostWsRelaySession(sid(5), head, client, (f) => emitted.push(f));

    client.handlers!.onMessage(utf8.encode('pong'), false);

    expect(emitted.map((f) => f.type)).toEqual([FrameType.WS_MESSAGE_HEAD, FrameType.WS_MESSAGE_CHUNK, FrameType.WS_MESSAGE_END]);
    expect(decode.decode(emitted[1]!.payload)).toBe('pong');
  });
});

describe('HostWsRelaySession — close both directions', () => {
  it('an inbound WS_CLOSE calls session.close and marks the session closed', () => {
    const client = new FakeWsRelayClient();
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    const session = new HostWsRelaySession(sid(6), head, client, () => undefined);

    session.acceptInbound(frameWsClose(sid(6), 1000, 'bye')!);

    expect(client.closed).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(session.isClosed()).toBe(true);
  });

  it('a local close (onClose from the WsRelayClient) emits WS_CLOSE exactly once', () => {
    const client = new FakeWsRelayClient();
    const emitted: Frame[] = [];
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    const session = new HostWsRelaySession(sid(8), head, client, (f) => emitted.push(f));

    client.handlers!.onClose(1006, 'abnormal');
    client.handlers!.onClose(1006, 'abnormal'); // duplicate close event — must not double-emit

    expect(emitted.map((f) => f.type)).toEqual([FrameType.WS_CLOSE]);
    expect(session.isClosed()).toBe(true);
  });

  it('ignores further inbound frames once closed', () => {
    const client = new FakeWsRelayClient();
    const head = decodeWsConnectHead(encodeWsConnectHead({ path: '/ws', protocols: [] }))!;
    const session = new HostWsRelaySession(sid(9), head, client, () => undefined);

    session.acceptInbound(frameWsClose(sid(9), 1000, '')!);
    client.sent = [];
    for (const f of frameWsMessage(sid(9), utf8.encode('too-late'), false)) {
      session.acceptInbound(f);
    }
    expect(client.sent).toHaveLength(0);
  });
});
