import { describe, expect, it } from 'vitest';
import { createWsBridge, type BeamWsHandlers } from '../src/ws-bridge.js';
import {
  decodeWsConnectHead,
  encodeWsCloseInfo,
  FrameType,
  frameWsAccept,
  frameWsMessage,
  ok,
  StreamMultiplexer,
  type Frame,
  type PeerTransport,
  type Result,
  type Unsubscribe,
} from '../src/protocol-bridge.js';

function acceptFrame(streamId: number, protocol: string): Frame {
  return frameWsAccept(streamId as never, protocol) as Frame;
}

class FakePeerTransport implements PeerTransport {
  public readonly sent: Frame[] = [];
  private handler: ((frame: Frame) => void) | null = null;

  send(frame: Frame): Result<undefined, { error: 'TransportClosed' }> {
    this.sent.push(frame);
    return ok();
  }
  onFrame(handler: (frame: Frame) => void): Unsubscribe {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  onClose(): Unsubscribe {
    return () => undefined;
  }
  close(): void {
    /* no-op */
  }
  bufferedAmount(): number {
    return 0;
  }
  emit(frame: Frame): void {
    this.handler?.(frame);
  }
}

function collectHandlers(): { handlers: BeamWsHandlers; events: string[]; messages: Array<{ data: Uint8Array; isBinary: boolean }> } {
  const events: string[] = [];
  const messages: Array<{ data: Uint8Array; isBinary: boolean }> = [];
  const handlers: BeamWsHandlers = {
    onOpen: (protocol) => events.push(`open:${protocol}`),
    onMessage: (data, isBinary) => messages.push({ data, isBinary }),
    onClose: (code, reason) => events.push(`close:${String(code)}:${reason}`),
    onError: (reason) => events.push(`error:${reason}`),
  };
  return { handlers, events, messages };
}

describe('createWsBridge — open()', () => {
  it('writes a WS_CONNECT frame with the requested path/protocols', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers } = collectHandlers();

    bridge.open('/socket', ['chat'], handlers);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.type).toBe(FrameType.WS_CONNECT);
    const head = decodeWsConnectHead(transport.sent[0]!.payload);
    expect(head).toEqual({ path: '/socket', protocols: ['chat'] });
  });

  it('routes an inbound WS_ACCEPT for that stream to onOpen', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers, events } = collectHandlers();

    const handle = bridge.open('/socket', [], handlers);
    transport.emit(acceptFrame(handle.streamId, 'chat'));

    expect(events).toEqual(['open:chat']);
  });

  it('does not route a WS_ACCEPT meant for a DIFFERENT stream', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers, events } = collectHandlers();

    bridge.open('/socket', [], handlers);
    transport.emit(acceptFrame(9999, 'chat')); // unrelated stream id

    expect(events).toEqual([]);
  });
});

describe('createWsBridge — message relay both directions', () => {
  it('send() frames an outbound message as HEAD+CHUNK+END on the stream', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers } = collectHandlers();

    const handle = bridge.open('/socket', [], handlers);
    transport.sent.length = 0; // clear the WS_CONNECT frame
    bridge.send(handle, new TextEncoder().encode('hi'), false);

    const types = transport.sent.map((f) => f.type);
    expect(types).toEqual([FrameType.WS_MESSAGE_HEAD, FrameType.WS_MESSAGE_CHUNK, FrameType.WS_MESSAGE_END]);
    expect(new TextDecoder().decode(transport.sent[1]!.payload)).toBe('hi');
  });

  it('reassembles an inbound HEAD+CHUNK+END into one onMessage call', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers, messages } = collectHandlers();

    const handle = bridge.open('/socket', [], handlers);
    for (const f of frameWsMessage(handle.streamId as never, new TextEncoder().encode('pong'), false)) {
      transport.emit(f);
    }

    expect(messages).toHaveLength(1);
    expect(new TextDecoder().decode(messages[0]!.data)).toBe('pong');
    expect(messages[0]!.isBinary).toBe(false);
  });
});

describe('createWsBridge — close both directions', () => {
  it('close() writes a WS_CLOSE frame', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers } = collectHandlers();

    const handle = bridge.open('/socket', [], handlers);
    transport.sent.length = 0;
    bridge.close(handle, 1000, 'done');

    expect(transport.sent.map((f) => f.type)).toEqual([FrameType.WS_CLOSE]);
  });

  it('an inbound WS_CLOSE calls onClose with the decoded code/reason', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers, events } = collectHandlers();

    const handle = bridge.open('/socket', [], handlers);
    transport.emit({
      type: FrameType.WS_CLOSE,
      streamId: handle.streamId as never,
      payload: encodeWsCloseInfo({ code: 1000, reason: 'bye' }) as never,
    });

    expect(events).toEqual(['close:1000:bye']);
  });

  it('a WS_REJECT calls onError, not onOpen', () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const bridge = createWsBridge(mux);
    const { handlers, events } = collectHandlers();

    const handle = bridge.open('/blocked', [], handlers);
    transport.emit({
      type: FrameType.WS_REJECT,
      streamId: handle.streamId as never,
      payload: new TextEncoder().encode('path not in --allowed-paths') as never,
    });

    expect(events).toEqual(['error:path not in --allowed-paths']);
  });
});
