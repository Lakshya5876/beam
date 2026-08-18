/**
 * Composition root — the ONLY place concrete infrastructure is wired to
 * domain interfaces.
 *
 * Holds the host runtime: the signaling<->peer SDP/ICE glue (deferred here
 * from S11 because it needs concrete peer-connection methods absent from the
 * PeerTransport interface), and the decode -> authorize -> relay -> record ->
 * send loop. All concretions are instantiated ONLY in `realFactories`.
 */

import { loadConfig, type BeamConfig, type IceTransportPolicy } from './config.js';
import { FrameType, type Frame, type StreamId } from './domain/frame.js';
import {
  ok,
  type IceConfigClient,
  type IceServerConfig,
  type PeerTransport,
  type ReplayClient,
  type RequestLogRepository,
  type Result,
  type SignalingClient,
  type SignalingMessage,
  type SignalingNotConnectedError,
  type Unsubscribe,
  type WsRelayClient,
} from './domain/interfaces.js';
import { InMemoryRequestLogStore } from './infrastructure/request-log-store.js';
import { LoopbackReplayClient } from './infrastructure/replay-client.js';
import { LoopbackWsRelayClient } from './infrastructure/ws-relay-client.js';
import { WebSocketSignalingClient } from './infrastructure/signaling-client.js';
import { HttpIceConfigClient } from './infrastructure/ice-config-client.js';
import { hasRelayServer, mergeIceServers } from './application/ice-servers.js';
import {
  initNativeLogging,
  PeerConnectionTransport,
  type PeerConnectFailedError,
  type PeerSignalingError,
} from './infrastructure/peer-connection.js';
import { LOW_WATER_MARK, StreamMultiplexer } from './application/protocol.js';
import {
  assembleRequest,
  decodeResponseHead,
  ExecuteRelayUseCase,
  frameError,
  frameResponse,
} from './application/relay-use-case.js';
import { decodeWsConnectHead, frameWsReject, HostWsRelaySession } from './application/ws-relay-use-case.js';
import { ExecuteSessionUseCase, type StartSessionError } from './application/session-use-case.js';
import { QueryDiagnosticsUseCase, RecordRequestUseCase } from './application/diagnostics-use-case.js';
import { forbiddenResponse, isPathAllowed } from './application/path-authorization.js';

export interface AppContext {
  readonly config: BeamConfig;
}

export function composeApp(env?: NodeJS.ProcessEnv): AppContext {
  return { config: loadConfig(env) };
}

/**
 * The peer surface the host runtime needs: the PeerTransport seam plus the
 * connection-lifecycle methods (SDP/ICE) that are not on that interface. The
 * concrete PeerConnectionTransport satisfies it; tests inject a fake.
 */
export interface ConnectablePeer extends PeerTransport {
  start(): void;
  onLocalDescription(handler: (sdp: string, type: string) => void): Unsubscribe;
  onLocalCandidate(handler: (candidate: string, mid: string) => void): Unsubscribe;
  applyRemoteDescription(sdp: string, type: string): Result<undefined, PeerSignalingError>;
  addRemoteCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError>;
  awaitConnected(): Promise<Result<undefined, PeerConnectFailedError>>;
}

export interface PeerCreationOptions {
  readonly log?: (msg: string) => void;
  readonly iceServers?: readonly IceServerConfig[];
  readonly ipv4Only?: boolean;
  readonly iceTransportPolicy?: IceTransportPolicy;
}

export interface HostFactories {
  createLogStore(): RequestLogRepository;
  createReplayClient(localPort: number): ReplayClient;
  createWsRelayClient(localPort: number): WsRelayClient;
  createSignalingClient(signalingUrl: string, log?: (msg: string) => void): SignalingClient;
  createIceConfigClient(log?: (msg: string) => void): IceConfigClient;
  createPeer(options?: PeerCreationOptions): ConnectablePeer;
}

// The ONLY place concrete infrastructure is instantiated.
export const realFactories: HostFactories = {
  createLogStore: () => new InMemoryRequestLogStore(),
  createReplayClient: (localPort) => new LoopbackReplayClient(localPort),
  createWsRelayClient: (localPort) => new LoopbackWsRelayClient(localPort),
  createSignalingClient: (signalingUrl, log) => new WebSocketSignalingClient(signalingUrl, undefined, undefined, log),
  createIceConfigClient: (log) => new HttpIceConfigClient(undefined, undefined, log),
  createPeer: (options = {}) =>
    new PeerConnectionTransport({
      role: 'offer',
      ...(options.log !== undefined && { log: options.log }),
      ...(options.iceServers !== undefined && { iceServers: options.iceServers }),
      ...(options.ipv4Only === true && { ipv4Only: true }),
      ...(options.iceTransportPolicy !== undefined && { iceTransportPolicy: options.iceTransportPolicy }),
    }),
};

/**
 * Assemble the host's ICE servers: anything pinned via BEAM_ICE_SERVERS/--ice
 * first, then whatever the signaling origin serves at /ice-config (which is
 * where minted TURN credentials come from). Merged rather than either/or, so
 * pinning a self-hosted STUN does not silently discard TURN.
 *
 * A fetch failure is logged and ignored — the host proceeds with what it has
 * and still attempts a direct connection.
 */
export async function resolveHostIceServers(
  client: IceConfigClient,
  signalingUrl: string,
  configured: readonly IceServerConfig[] | undefined,
  log: (msg: string) => void,
): Promise<readonly IceServerConfig[] | undefined> {
  const fetched = await client.fetchIceServers(signalingUrl);
  if (!fetched.ok) {
    log(`[HOST-ICE] ${fetched.error.reason} — continuing with configured/default ICE servers`);
    return configured;
  }
  const merged = mergeIceServers(configured ?? [], fetched.value);
  log(`[HOST-ICE] ${String(merged.length)} ice server(s), relay=${String(hasRelayServer(merged))}`);
  return merged;
}

function parseRemoteCandidate(payload: string): { candidate: string; mid: string } | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { candidate?: unknown }).candidate;
      const mid = (parsed as { mid?: unknown }).mid;
      if (typeof candidate === 'string') {
        // Browser sdpMid can be null for the first m-line; treat null/missing as '0'.
        return { candidate, mid: typeof mid === 'string' ? mid : '0' };
      }
    }
  } catch {
    // Malformed inbound candidate — drop, never abort.
    return null;
  }
  return null;
}

/** Forward the peer's local SDP/ICE out through the signaling channel. */
export function forwardLocalSignals(peer: ConnectablePeer, signaling: SignalingClient): void {
  peer.onLocalDescription((sdp, type) => {
    void signaling.sendMessage({ kind: type as SignalingMessage['kind'], payload: sdp });
  });
  peer.onLocalCandidate((candidate, mid) => {
    void signaling.sendMessage({ kind: 'ice-candidate', payload: JSON.stringify({ candidate, mid }) });
  });
}

/** Route inbound signaling messages into the peer (candidates buffer in S9). */
export function applyRemoteSignals(signaling: SignalingClient, peer: ConnectablePeer): void {
  signaling.onMessage((message) => {
    // setImmediate: the signaling callback fires on node-datachannel's native
    // WebSocket thread; calling back into the native PeerConnection from
    // inside it is native→native reentrancy that intermittently stalled ICE
    // (host stuck in 'checking', never answering connectivity checks — caught
    // by the local e2e harness). Deferring to the Node event loop serializes
    // the two native layers. Ordering is preserved: setImmediate callbacks
    // run FIFO, and addRemoteCandidate buffers until the description applies.
    setImmediate(() => {
      if (message.kind === 'ice-candidate') {
        const parsed = parseRemoteCandidate(message.payload);
        if (parsed) {
          // Goes through the peer's buffering addRemoteCandidate (S9): a
          // pre-remote-description candidate is queued, never passed to native.
          peer.addRemoteCandidate(parsed.candidate, parsed.mid);
        }
        return;
      }
      peer.applyRemoteDescription(message.payload, message.kind);
    });
  });
}

/** Start the connection and route the bounded honest-failure outcome. */
export async function runConnection(peer: ConnectablePeer, session: ExecuteSessionUseCase): Promise<void> {
  peer.start();
  const outcome = await peer.awaitConnected();
  if (outcome.ok) {
    session.markEstablished();
    return;
  }
  await session.markFailed(outcome.error.reason);
}

function responseSizeBytes(frames: readonly Frame[]): number {
  let total = 0;
  for (const frame of frames) {
    if (frame.type === FrameType.RESPONSE_BODY_CHUNK) {
      total += frame.payload.byteLength;
    }
  }
  return total;
}

interface RelayDependencies {
  readonly mux: StreamMultiplexer;
  readonly relay: ExecuteRelayUseCase;
  readonly wsRelayClient: WsRelayClient;
  readonly recorder: RecordRequestUseCase;
  readonly allowedPaths: readonly string[];
  readonly now: () => number;
  readonly waitForDrain: () => Promise<void>;
}

/**
 * Write one response frame through the mux (NOT transport.send) so it shares
 * the request's stream id (S4.1 half-close) and engages backpressure. When
 * the mux signals pause (high-water), defer until the channel drains before
 * returning — the caller (a per-chunk callback from the streaming relay use
 * case, or writeResponse below) awaits this before producing the next frame,
 * so a large response no longer floods past the threshold.
 */
async function writeOneFrame(deps: RelayDependencies, frame: Frame): Promise<void> {
  deps.mux.writeFrame(frame);
  if (deps.mux.isPaused()) {
    await deps.waitForDrain();
  }
}

/** Write a complete, already-buffered frame array (synthetic responses: parse errors, 403). */
async function writeResponse(deps: RelayDependencies, frames: readonly Frame[]): Promise<void> {
  for (const frame of frames) {
    await writeOneFrame(deps, frame);
  }
}

/** Decode a single RESPONSE_HEAD frame's status, defaulting to 502 on a malformed/absent head. */
function frameHeadStatus(frame: Frame): number {
  if (frame.type !== FrameType.RESPONSE_HEAD) {
    return 502;
  }
  const decoded = decodeResponseHead(frame.payload);
  return decoded.ok ? decoded.value.status : 502;
}

async function completeRequest(frames: Frame[], streamId: StreamId, deps: RelayDependencies): Promise<void> {
  const assembled = assembleRequest(frames);
  if (!assembled.ok) {
    await writeResponse(deps, frameError(streamId, assembled.error.reason));
    return;
  }
  const request = assembled.value;
  if (!isPathAllowed(deps.allowedPaths, request.path)) {
    const denied = frameResponse(streamId, forbiddenResponse());
    await writeResponse(deps, denied);
    await deps.recorder.record({ method: request.method, path: request.path, status: 403, latencyMs: 0, responseSizeBytes: responseSizeBytes(denied), streamId });
    return;
  }
  const startedAt = deps.now();
  let status = 502;
  let headSeen = false;
  let bytesSent = 0;
  await deps.relay.execute(frames, async (frame) => {
    if (frame.type === FrameType.RESPONSE_HEAD && !headSeen) {
      headSeen = true;
      status = frameHeadStatus(frame);
    } else if (frame.type === FrameType.RESPONSE_BODY_CHUNK) {
      bytesSent += frame.payload.byteLength;
    }
    await writeOneFrame(deps, frame);
  });
  await deps.recorder.record({
    method: request.method,
    path: request.path,
    status,
    latencyMs: deps.now() - startedAt,
    responseSizeBytes: bytesSent,
    streamId,
  });
}

/**
 * Start a WS relay session for a brand-new stream whose first frame is
 * WS_CONNECT: authorize against --allowed-paths exactly like an HTTP
 * request, then hand off to HostWsRelaySession for the connection's
 * lifetime. Frames it emits are written through the mux the same way an
 * HTTP response's frames are (writeOneFrame — same backpressure path).
 *
 * `onClosed` fires once isClosed() actually becomes true — which can happen
 * either reactively (in response to the inbound frame that triggered it) or
 * later, asynchronously, if the LOCAL side closes first (the developer's app
 * drops the connection unprompted). The caller uses this to drop its
 * bookkeeping in EITHER case — see HostWsRelaySession's isClosed() doc for
 * why relying only on "check after the next inbound frame" would leak.
 */
function startWsSession(
  streamId: StreamId,
  connectFrame: Frame,
  deps: RelayDependencies,
  onClosed: () => void,
): HostWsRelaySession | null {
  const head = decodeWsConnectHead(connectFrame.payload);
  if (!head) {
    return null;
  }
  if (!isPathAllowed(deps.allowedPaths, head.path)) {
    const rejected = frameWsReject(streamId, 'path not in --allowed-paths');
    if (rejected) {
      void writeOneFrame(deps, rejected);
    }
    return null;
  }
  const session: HostWsRelaySession = new HostWsRelaySession(streamId, head, deps.wsRelayClient, (frame) => {
    void writeOneFrame(deps, frame).then(() => {
      if (session.isClosed()) {
        onClosed();
      }
    });
  });
  return session;
}

/**
 * Inbound frames are demuxed by the StreamMultiplexer and routed per stream:
 * an HTTP request accumulates REQUEST_* frames until REQUEST_END (unchanged
 * behavior, see completeRequest); a WS_CONNECT starts a WsRelaySession that
 * owns the rest of that stream's frames until WS_CLOSE. The FIRST frame seen
 * for a given stream id decides which path it takes.
 */
export function runRelayLoop(deps: RelayDependencies): Unsubscribe {
  const pendingHttp = new Map<number, Frame[]>();
  const wsSessions = new Map<number, HostWsRelaySession>();
  return deps.mux.onInbound((frame) => {
    const existingWs = wsSessions.get(frame.streamId);
    if (existingWs) {
      existingWs.acceptInbound(frame);
      return;
    }
    if (frame.type === FrameType.WS_CONNECT) {
      const session = startWsSession(frame.streamId, frame, deps, () => {
        wsSessions.delete(frame.streamId);
      });
      if (session) {
        wsSessions.set(frame.streamId, session);
      }
      return;
    }
    const list = pendingHttp.get(frame.streamId) ?? [];
    list.push(frame);
    pendingHttp.set(frame.streamId, list);
    if (frame.type === FrameType.REQUEST_END) {
      pendingHttp.delete(frame.streamId);
      void completeRequest(list, frame.streamId, deps);
    }
  });
}

const BACKPRESSURE_POLL_MS = 25;

/** Poll-based drain: resolves once the channel's buffered bytes fall to the
 *  low-water mark. Keys off the PeerTransport.bufferedAmount() seam — no new
 *  interface method needed. */
function pollDrain(transport: PeerTransport, lowWaterMark: number): () => Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return async (): Promise<void> => {
    while (transport.bufferedAmount() > lowWaterMark) {
      await sleep(BACKPRESSURE_POLL_MS);
    }
  };
}

export interface HostOptions {
  readonly localPort: number;
  readonly signalingUrl: string;
  readonly allowedPaths?: readonly string[];
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly debug?: boolean;
  readonly iceServers?: readonly IceServerConfig[];
  /** 'relay' forces TURN; verification/diagnosis only (see config.ts). */
  readonly iceTransportPolicy?: IceTransportPolicy;
  /** Debug sink; when set with debug, overrides the default stderr writer
   *  (the CLI injects a timestamped timeline logger). */
  readonly log?: (msg: string) => void;
  /** libdatachannel log level (BEAM_NATIVE_LOG); unset = native logging off. */
  readonly nativeLogLevel?: string;
  /** Drop IPv6 ICE candidates both ways (--ipv4-only); see peer-connection. */
  readonly ipv4Only?: boolean;
}

export interface HostRuntime {
  start(rawCode: string): Promise<Result<undefined, StartSessionError>>;
  close(reason: string): Promise<void>;
  registerPin(hash: string): Promise<Result<undefined, SignalingNotConnectedError>>;
  readonly session: ExecuteSessionUseCase;
  readonly diagnostics: QueryDiagnosticsUseCase;
}

/**
 * Resolve the host's ICE servers before composing the runtime. Separate from
 * composeHost because it is async and composeHost must stay synchronous (it
 * wires signal handlers onto the peer at construction); the CLI awaits this,
 * then passes the result in as HostOptions.iceServers.
 */
export function composeHostIceServers(
  signalingUrl: string,
  configured: readonly IceServerConfig[] | undefined,
  log: (msg: string) => void = () => { /* noop */ },
  factories: HostFactories = realFactories,
): Promise<readonly IceServerConfig[] | undefined> {
  return resolveHostIceServers(factories.createIceConfigClient(log), signalingUrl, configured, log);
}

/** Debug sink: the CLI's timestamped logger when given, else stderr. */
function hostLogger(options: HostOptions): ((msg: string) => void) | undefined {
  if (options.debug !== true) {
    return undefined;
  }
  return options.log ?? ((msg: string): void => { process.stderr.write(`${msg}\n`); });
}

function peerOptionsFor(options: HostOptions, log: ((msg: string) => void) | undefined): PeerCreationOptions {
  return {
    ...(log !== undefined && { log }),
    ...(options.iceServers !== undefined && { iceServers: options.iceServers }),
    ...(options.ipv4Only === true && { ipv4Only: true }),
    ...(options.iceTransportPolicy !== undefined && { iceTransportPolicy: options.iceTransportPolicy }),
  };
}

export function composeHost(options: HostOptions, factories: HostFactories = realFactories): HostRuntime {
  const now = options.now ?? ((): number => Date.now());
  const log = hostLogger(options);
  if (options.nativeLogLevel !== undefined) {
    initNativeLogging(options.nativeLogLevel);
  }
  const logStore = factories.createLogStore();
  const replayClient = factories.createReplayClient(options.localPort);
  const wsRelayClient = factories.createWsRelayClient(options.localPort);
  const signaling = factories.createSignalingClient(options.signalingUrl, log);
  const peer = factories.createPeer(peerOptionsFor(options, log));
  const mux = new StreamMultiplexer(peer);
  const relay = new ExecuteRelayUseCase(replayClient);
  const recorder = new RecordRequestUseCase(logStore, now);
  const session = new ExecuteSessionUseCase(signaling, now);
  const diagnostics = new QueryDiagnosticsUseCase(logStore);

  forwardLocalSignals(peer, signaling);
  applyRemoteSignals(signaling, peer);
  runRelayLoop({ mux, relay, wsRelayClient, recorder, allowedPaths: options.allowedPaths ?? [], now, waitForDrain: pollDrain(peer, LOW_WATER_MARK) });

  return {
    session,
    diagnostics,
    async start(rawCode) {
      const started = await session.startSession(rawCode, options.ttlMs);
      if (!started.ok) {
        return started;
      }
      void runConnection(peer, session);
      return ok();
    },
    async close(reason) {
      peer.close();
      await session.closeSession(reason);
    },
    registerPin(hash) {
      return signaling.registerPin(hash);
    },
  };
}
