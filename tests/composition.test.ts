import { describe, expect, it } from 'vitest';
import {
  createFramePayload,
  createStreamId,
  FrameType,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
  type FramePayload,
  type StreamId,
} from '../src/domain/frame.js';
import {
  err,
  ok,
  type IceConfigClient,
  type PeerTransport,
  type Result,
  type SignalingClient,
  type SignalingConnectError,
  type SignalingMessage,
  type SignalingNotConnectedError,
  type ReplayClient,
  type ReplayRequest,
  type ReplayResponse,
  type ReplayFailedError,
  type RequestLogRepository,
  type RequestRecord,
  type Unsubscribe,
  type WsConnectRequest,
  type WsRelayClient,
  type WsRelaySession,
  type WsRelaySessionHandlers,
} from '../src/domain/interfaces.js';
import type { PeerConnectFailedError, PeerSignalingError } from '../src/infrastructure/peer-connection.js';
import { DEFAULT_MULTIPLEXER_LIMITS, StreamMultiplexer } from '../src/application/protocol.js';
import { ExecuteRelayUseCase, encodeRequestHead } from '../src/application/relay-use-case.js';
import { encodeWsConnectHead } from '../src/application/ws-relay-use-case.js';
import { ExecuteSessionUseCase } from '../src/application/session-use-case.js';
import { RecordRequestUseCase } from '../src/application/diagnostics-use-case.js';
import {
  applyRemoteSignals,
  composeApp,
  composeHost,
  forwardLocalSignals,
  resolveHostIceServers,
  runConnection,
  runRelayLoop,
  type ConnectablePeer,
  type HostFactories,
} from '../src/composition.js';
import { fixtureEnv } from './fixtures/test-env.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  return id;
}

function pay(bytes: Uint8Array): FramePayload {
  const p = createFramePayload(bytes);
  if (isPayloadTooLargeError(p)) {
    throw new Error('test setup: payload');
  }
  return p;
}

describe('composition root (config)', () => {
  it('test_compose_app_wires_config_from_injected_env', () => {
    const ctx = composeApp(fixtureEnv());
    expect(ctx.config.logLevel).toBe('silent');
    expect(ctx.config.appPort).toBe(8099);
  });
});

class FakeSignalingClient implements SignalingClient {
  public sent: SignalingMessage[] = [];
  public registeredPinHashes: string[] = [];
  private handler: ((m: SignalingMessage) => void) | null = null;
  connect(): Promise<Result<undefined, SignalingConnectError>> {
    return Promise.resolve(ok());
  }
  sendMessage(message: SignalingMessage): Promise<Result<undefined, SignalingNotConnectedError>> {
    this.sent.push(message);
    return Promise.resolve(ok());
  }
  onMessage(handler: (m: SignalingMessage) => void): Unsubscribe {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  registerPin(hash: string): Promise<Result<undefined, SignalingNotConnectedError>> {
    this.registeredPinHashes.push(hash);
    return Promise.resolve(ok());
  }
  emit(message: SignalingMessage): void {
    this.handler?.(message);
  }
}

class FakeHostPeer implements ConnectablePeer {
  public appliedDescriptions: Array<{ sdp: string; type: string }> = [];
  public addedCandidates: Array<{ candidate: string; mid: string }> = [];
  public started = false;
  private localDesc: Array<(sdp: string, type: string) => void> = [];
  private localCand: Array<(candidate: string, mid: string) => void> = [];
  private connectResult: Result<undefined, PeerConnectFailedError> = ok();

  send(): Result<undefined, { error: 'TransportClosed' }> {
    return ok();
  }
  onFrame(): Unsubscribe {
    return () => undefined;
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
  start(): void {
    this.started = true;
  }
  onLocalDescription(handler: (sdp: string, type: string) => void): Unsubscribe {
    this.localDesc.push(handler);
    return () => undefined;
  }
  onLocalCandidate(handler: (candidate: string, mid: string) => void): Unsubscribe {
    this.localCand.push(handler);
    return () => undefined;
  }
  applyRemoteDescription(sdp: string, type: string): Result<undefined, PeerSignalingError> {
    this.appliedDescriptions.push({ sdp, type });
    return ok();
  }
  addRemoteCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError> {
    this.addedCandidates.push({ candidate, mid });
    return ok();
  }
  awaitConnected(): Promise<Result<undefined, PeerConnectFailedError>> {
    return Promise.resolve(this.connectResult);
  }
  setConnectResult(result: Result<undefined, PeerConnectFailedError>): void {
    this.connectResult = result;
  }
  emitLocalDescription(sdp: string, type: string): void {
    for (const cb of this.localDesc) {
      cb(sdp, type);
    }
  }
  emitLocalCandidate(candidate: string, mid: string): void {
    for (const cb of this.localCand) {
      cb(candidate, mid);
    }
  }
}

class FakePeerTransport implements PeerTransport {
  public sent: Frame[] = [];
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
  public buffered = 0;
  bufferedAmount(): number {
    return this.buffered;
  }
  setBuffered(n: number): void {
    this.buffered = n;
  }
  emit(frame: Frame): void {
    this.handler?.(frame);
  }
}

function makeReplayClient(impl: (r: ReplayRequest) => Result<ReplayResponse, ReplayFailedError>): {
  client: ReplayClient;
  calls: ReplayRequest[];
} {
  const calls: ReplayRequest[] = [];
  const client: ReplayClient = {
    async replay(request, sink) {
      calls.push(request);
      const result = impl(request);
      if (!result.ok) {
        return result;
      }
      await sink.onHead({ status: result.value.status, headers: result.value.headers });
      if (result.value.body.byteLength > 0) {
        await sink.onChunk(result.value.body);
      }
      await sink.onEnd();
      return ok(undefined);
    },
  };
  return { client, calls };
}

/** A WsRelayClient fake that never actually connects — sufficient for tests
 *  that don't exercise the WS relay path but need a HostFactories value. */
class NoopWsRelayClient implements WsRelayClient {
  public calls: WsConnectRequest[] = [];
  connect(request: WsConnectRequest): WsRelaySession {
    this.calls.push(request);
    return { send: () => undefined, close: () => undefined };
  }
}

class FakeRequestLogRepository implements RequestLogRepository {
  public records: RequestRecord[] = [];
  persistRecord(record: RequestRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
  fetchRecent(): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.records);
  }
  findByStreamId(): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.records);
  }
}

describe('SDP/ICE glue', () => {
  it('forwards local description and candidate out through signaling', () => {
    const peer = new FakeHostPeer();
    const signaling = new FakeSignalingClient();
    forwardLocalSignals(peer, signaling);
    peer.emitLocalDescription('v=0 sdp', 'offer');
    peer.emitLocalCandidate('candidate:1 udp', '0');
    expect(signaling.sent[0]).toEqual({ kind: 'offer', payload: 'v=0 sdp' });
    expect(signaling.sent[1]).toEqual({ kind: 'ice-candidate', payload: JSON.stringify({ candidate: 'candidate:1 udp', mid: '0' }) });
  });

  // applyRemoteSignals defers peer calls to the event loop (setImmediate) to
  // avoid native→native reentrancy from the signaling callback thread; tests
  // flush one macrotask before asserting.
  const flushImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('routes an inbound candidate through the peer buffering addRemoteCandidate', async () => {
    const peer = new FakeHostPeer();
    const signaling = new FakeSignalingClient();
    applyRemoteSignals(signaling, peer);
    signaling.emit({ kind: 'ice-candidate', payload: JSON.stringify({ candidate: 'cand-X', mid: '0' }) });
    await flushImmediate();
    expect(peer.addedCandidates).toEqual([{ candidate: 'cand-X', mid: '0' }]);
  });

  it('routes an inbound offer to applyRemoteDescription', async () => {
    const peer = new FakeHostPeer();
    const signaling = new FakeSignalingClient();
    applyRemoteSignals(signaling, peer);
    signaling.emit({ kind: 'offer', payload: 'remote-sdp' });
    await flushImmediate();
    expect(peer.appliedDescriptions).toEqual([{ sdp: 'remote-sdp', type: 'offer' }]);
  });

  it('drops a malformed inbound candidate without calling addRemoteCandidate (no abort)', async () => {
    const peer = new FakeHostPeer();
    const signaling = new FakeSignalingClient();
    applyRemoteSignals(signaling, peer);
    // Not valid JSON — must be dropped entirely.
    signaling.emit({ kind: 'ice-candidate', payload: 'not json' });
    // Missing candidate field — must be dropped.
    signaling.emit({ kind: 'ice-candidate', payload: JSON.stringify({ mid: '0' }) });
    await flushImmediate();
    expect(peer.addedCandidates).toEqual([]);
  });

  it('accepts a candidate whose sdpMid is null/absent (browser first m-line), defaulting mid to "0"', async () => {
    const peer = new FakeHostPeer();
    const signaling = new FakeSignalingClient();
    applyRemoteSignals(signaling, peer);
    // Browser can emit event.candidate.sdpMid === null for the first m-line.
    signaling.emit({ kind: 'ice-candidate', payload: JSON.stringify({ candidate: 'cand-no-mid' }) });
    await flushImmediate();
    expect(peer.addedCandidates).toEqual([{ candidate: 'cand-no-mid', mid: '0' }]);
  });
});

describe('runConnection — honest-failure outcome routing', () => {
  async function startedSession(signaling: FakeSignalingClient): Promise<ExecuteSessionUseCase> {
    const session = new ExecuteSessionUseCase(signaling, () => 1000);
    const started = await session.startSession('k7x2m9q4w8r3t6y1u5z0a2b4c7');
    if (!started.ok) {
      throw new Error('setup: startSession');
    }
    return session;
  }

  it('a no-viable-candidate outcome flows through markFailed to a SessionFailed event', async () => {
    const session = await startedSession(new FakeSignalingClient());
    const events: string[] = [];
    session.onEvent((e) => events.push(e.event));
    const peer = new FakeHostPeer();
    peer.setConnectResult(err({ error: 'PeerConnectFailed', reason: 'no-viable-candidate' }));
    await runConnection(peer, session);
    expect(session.state()).toBe('failed');
    expect(events).toEqual(['SessionFailed']);
  });

  it('a successful connection flows through markEstablished', async () => {
    const session = await startedSession(new FakeSignalingClient());
    const peer = new FakeHostPeer();
    peer.setConnectResult(ok());
    await runConnection(peer, session);
    expect(session.state()).toBe('established');
    expect(peer.started).toBe(true);
  });
});

describe('runRelayLoop — authorization gates the relay (real StreamMultiplexer)', () => {
  function requestFrames(streamId: number, path: string): Frame[] {
    return [
      { type: FrameType.REQUEST_HEAD, streamId: sid(streamId), payload: pay(encodeRequestHead({ method: 'GET', path, headers: {} })) },
      { type: FrameType.REQUEST_END, streamId: sid(streamId), payload: pay(new Uint8Array(0)) },
    ];
  }

  it('relays an allowed path and records the request', async () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const { client, calls } = makeReplayClient(() => ok({ status: 200, headers: {}, body: new TextEncoder().encode('ok') }));
    const repo = new FakeRequestLogRepository();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(client),
      wsRelayClient: new NoopWsRelayClient(),
      recorder: new RecordRequestUseCase(repo, () => 42),
      allowedPaths: ['/api'],
      now: () => 42,
      waitForDrain: () => Promise.resolve(),
    });
    for (const frame of requestFrames(1, '/api/items')) {
      transport.emit(frame);
    }
    await flush();
    expect(calls).toHaveLength(1);
    // Responses now flow through mux.writeFrame -> transport.send (still observed here).
    expect(transport.sent.map((f) => f.type)).toEqual([FrameType.RESPONSE_HEAD, FrameType.RESPONSE_BODY_CHUNK, FrameType.RESPONSE_END]);
    expect(repo.records[0]?.status).toBe(200);
  });

  it('denies /apifoo against allow-list [/api] with a 403 and never calls replay', async () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const { client, calls } = makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) }));
    const repo = new FakeRequestLogRepository();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(client),
      wsRelayClient: new NoopWsRelayClient(),
      recorder: new RecordRequestUseCase(repo, () => 0),
      allowedPaths: ['/api'],
      now: () => 0,
      waitForDrain: () => Promise.resolve(),
    });
    for (const frame of requestFrames(2, '/apifoo')) {
      transport.emit(frame);
    }
    await flush();
    expect(calls).toHaveLength(0);
    expect(repo.records[0]?.status).toBe(403);
    expect(transport.sent[0]?.type).toBe(FrameType.RESPONSE_HEAD);
  });

  it('honors backpressure: defers response writes past the high-water mark until drain', async () => {
    const transport = new FakePeerTransport();
    // High-water 1: the very first response write trips pause.
    const mux = new StreamMultiplexer(transport, { ...DEFAULT_MULTIPLEXER_LIMITS, highWaterMark: 1, lowWaterMark: 0 });
    const { client } = makeReplayClient(() => ok({ status: 200, headers: {}, body: new TextEncoder().encode('a-body') }));
    const repo = new FakeRequestLogRepository();
    let releaseDrain: () => void = () => undefined;
    const drained: Promise<void> = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(client),
      wsRelayClient: new NoopWsRelayClient(),
      recorder: new RecordRequestUseCase(repo, () => 0),
      allowedPaths: [],
      now: () => 0,
      waitForDrain: () => drained,
    });
    transport.setBuffered(1000); // above high-water → first write pauses
    for (const frame of requestFrames(3, '/x')) {
      transport.emit(frame);
    }
    await flush();
    // Deferred mid-response: RESPONSE_HEAD written, then paused before the rest.
    expect(transport.sent.map((f) => f.type)).toEqual([FrameType.RESPONSE_HEAD]);
    expect(mux.isPaused()).toBe(true);
    // Drain and release: the remaining frames flush.
    transport.setBuffered(0);
    releaseDrain();
    await flush();
    expect(transport.sent.map((f) => f.type)).toEqual([
      FrameType.RESPONSE_HEAD,
      FrameType.RESPONSE_BODY_CHUNK,
      FrameType.RESPONSE_END,
    ]);
  });
});

describe('runRelayLoop — WS relay routing (real StreamMultiplexer)', () => {
  /** A WsRelayClient fake the test drives directly, exercising the real composition.ts wiring end-to-end (minus the actual localhost socket). */
  class ControllableWsRelayClient implements WsRelayClient {
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
        close: (code, reason) => {
          this.closed.push({ code, reason });
        },
      };
    }
  }

  function wsConnectFrame(streamId: number, path: string): Frame {
    return { type: FrameType.WS_CONNECT, streamId: sid(streamId), payload: pay(encodeWsConnectHead({ path, protocols: [] })) };
  }

  it('routes WS_CONNECT to the WsRelayClient and relays onOpen as WS_ACCEPT', async () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const ws = new ControllableWsRelayClient();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client),
      wsRelayClient: ws,
      recorder: new RecordRequestUseCase(new FakeRequestLogRepository(), () => 0),
      allowedPaths: [],
      now: () => 0,
      waitForDrain: () => Promise.resolve(),
    });

    transport.emit(wsConnectFrame(11, '/socket'));
    await flush();
    expect(ws.lastRequest).toEqual({ path: '/socket', protocols: [] });

    ws.handlers!.onOpen('');
    expect(transport.sent.map((f) => f.type)).toEqual([FrameType.WS_ACCEPT]);
  });

  it('rejects WS_CONNECT against a disallowed path without ever calling the WsRelayClient', async () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const ws = new ControllableWsRelayClient();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client),
      wsRelayClient: ws,
      recorder: new RecordRequestUseCase(new FakeRequestLogRepository(), () => 0),
      allowedPaths: ['/api'],
      now: () => 0,
      waitForDrain: () => Promise.resolve(),
    });

    transport.emit(wsConnectFrame(12, '/socket'));
    await flush();
    expect(ws.lastRequest).toBeNull();
    expect(transport.sent.map((f) => f.type)).toEqual([FrameType.WS_REJECT]);
  });

  it('relays a full message round trip both directions and closes on WS_CLOSE', async () => {
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const ws = new ControllableWsRelayClient();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client),
      wsRelayClient: ws,
      recorder: new RecordRequestUseCase(new FakeRequestLogRepository(), () => 0),
      allowedPaths: [],
      now: () => 0,
      waitForDrain: () => Promise.resolve(),
    });

    transport.emit(wsConnectFrame(13, '/socket'));
    await flush();
    ws.handlers!.onOpen('');

    // Viewer -> host: a text message arrives as HEAD+CHUNK+END.
    transport.emit({ type: FrameType.WS_MESSAGE_HEAD, streamId: sid(13), payload: pay(new Uint8Array([0])) });
    transport.emit({ type: FrameType.WS_MESSAGE_CHUNK, streamId: sid(13), payload: pay(new TextEncoder().encode('hi')) });
    transport.emit({ type: FrameType.WS_MESSAGE_END, streamId: sid(13), payload: pay(new Uint8Array(0)) });
    await flush();
    expect(ws.sent).toHaveLength(1);
    expect(new TextDecoder().decode(ws.sent[0]!.data)).toBe('hi');

    // Host -> viewer: the local app sends a message back.
    ws.handlers!.onMessage(new TextEncoder().encode('yo'), false);
    const wsFrameTypes = transport.sent.filter((f) => f.type !== FrameType.WS_ACCEPT).map((f) => f.type);
    expect(wsFrameTypes).toEqual([FrameType.WS_MESSAGE_HEAD, FrameType.WS_MESSAGE_CHUNK, FrameType.WS_MESSAGE_END]);

    // Viewer closes.
    transport.emit({ type: FrameType.WS_CLOSE, streamId: sid(13), payload: pay(new TextEncoder().encode(JSON.stringify({ code: 1000, reason: '' }))) });
    await flush();
    expect(ws.closed).toEqual([{ code: 1000, reason: '' }]);
  });

  it('a HOST-initiated close (the local app drops the connection, unprompted) still emits an outbound WS_CLOSE frame', async () => {
    // Regression test: the session-bookkeeping cleanup used to run only
    // reactively off the NEXT inbound frame, so a close the local app
    // initiated with no further inbound activity on that stream would never
    // clean up (and, in an earlier draft, never even emit the frame — see
    // HostWsRelaySession's isClosed()/finish() single-source-of-truth doc).
    const transport = new FakePeerTransport();
    const mux = new StreamMultiplexer(transport);
    const ws = new ControllableWsRelayClient();
    runRelayLoop({
      mux,
      relay: new ExecuteRelayUseCase(makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client),
      wsRelayClient: ws,
      recorder: new RecordRequestUseCase(new FakeRequestLogRepository(), () => 0),
      allowedPaths: [],
      now: () => 0,
      waitForDrain: () => Promise.resolve(),
    });

    transport.emit(wsConnectFrame(14, '/socket'));
    await flush();
    ws.handlers!.onOpen('');

    // No inbound frame ever triggers this — the local app just closes.
    ws.handlers!.onClose(1006, 'abnormal');
    await flush();

    expect(transport.sent.filter((f) => f.type === FrameType.WS_CLOSE)).toHaveLength(1);
  });
});

/** ICE config is fetched at startup; these cases exercise other wiring. */
function stubIceConfigClient(): IceConfigClient {
  return { fetchIceServers: () => Promise.resolve(err({ error: 'IceConfigFetchFailed', reason: 'stub' })) };
}

describe('composeHost — wiring with injected fakes', () => {
  it('start() connects signaling and starts the peer; close() closes the session', async () => {
    const signaling = new FakeSignalingClient();
    const peer = new FakeHostPeer();
    const factories: HostFactories = {
      createLogStore: () => new FakeRequestLogRepository(),
      createReplayClient: () => makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client,
      createWsRelayClient: () => new NoopWsRelayClient(),
      createSignalingClient: () => signaling,
      createIceConfigClient: () => stubIceConfigClient(),
      createPeer: () => peer,
    };
    const runtime = composeHost({ localPort: 3000, signalingUrl: 'ws://127.0.0.1:9', now: () => 1 }, factories);
    const started = await runtime.start('k7x2m9q4w8r3t6y1u5z0a2b4c7');
    expect(started.ok).toBe(true);
    await flush();
    expect(peer.started).toBe(true);
    await runtime.close('done');
    expect(runtime.session.state()).toBe('closed');
  });

  it('registerPin() delegates to signaling.registerPin()', async () => {
    const signaling = new FakeSignalingClient();
    const factories: HostFactories = {
      createLogStore: () => new FakeRequestLogRepository(),
      createReplayClient: () => makeReplayClient(() => ok({ status: 200, headers: {}, body: new Uint8Array(0) })).client,
      createWsRelayClient: () => new NoopWsRelayClient(),
      createSignalingClient: () => signaling,
      createIceConfigClient: () => stubIceConfigClient(),
      createPeer: () => new FakeHostPeer(),
    };
    const runtime = composeHost({ localPort: 3000, signalingUrl: 'ws://127.0.0.1:9', now: () => 1 }, factories);
    const fakeHash = 'b'.repeat(64);
    const result = await runtime.registerPin(fakeHash);
    expect(result.ok).toBe(true);
    expect(signaling.registeredPinHashes).toContain(fakeHash);
  });
});

describe('resolveHostIceServers — the host gets the same relay candidates as the viewer', () => {
  const fetched = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' },
  ];

  function clientReturning(value: typeof fetched): IceConfigClient {
    return { fetchIceServers: () => Promise.resolve(ok(value)) };
  }

  it('merges locally-pinned servers ahead of fetched ones', async () => {
    const pinned = [{ urls: 'stun:self-hosted.example.com:3478' }];

    const resolved = await resolveHostIceServers(clientReturning(fetched), 'ws://sig', pinned, () => {});

    expect(resolved).toEqual([
      { urls: 'stun:self-hosted.example.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.com:80', username: 'u', credential: 'c' },
    ]);
  });

  it('returns the fetched servers when nothing is pinned', async () => {
    const resolved = await resolveHostIceServers(clientReturning(fetched), 'ws://sig', undefined, () => {});
    expect(resolved).toEqual(fetched);
  });

  it('keeps the configured servers and continues when the fetch fails', async () => {
    // A TURN/ICE-config outage must not stop the host from attempting a
    // direct connection, which is what most networks use anyway.
    const client: IceConfigClient = {
      fetchIceServers: () => Promise.resolve(err({ error: 'IceConfigFetchFailed', reason: 'offline' })),
    };
    const pinned = [{ urls: 'stun:self-hosted.example.com:3478' }];
    const logs: string[] = [];

    const resolved = await resolveHostIceServers(client, 'ws://sig', pinned, (m) => logs.push(m));

    expect(resolved).toEqual(pinned);
    expect(logs.some((l) => l.includes('offline'))).toBe(true);
  });

  it('reports whether the resolved set actually offers a relay path', async () => {
    const logs: string[] = [];
    await resolveHostIceServers(clientReturning(fetched), 'ws://sig', undefined, (m) => logs.push(m));
    expect(logs.some((l) => l.includes('relay=true'))).toBe(true);

    const stunOnly: IceConfigClient = {
      fetchIceServers: () => Promise.resolve(ok([{ urls: 'stun:stun.l.google.com:19302' }])),
    };
    const logs2: string[] = [];
    await resolveHostIceServers(stunOnly, 'ws://sig', undefined, (m) => logs2.push(m));
    expect(logs2.some((l) => l.includes('relay=false'))).toBe(true);
  });
});
