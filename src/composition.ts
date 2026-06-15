/**
 * Composition root — the ONLY place concrete infrastructure is wired to
 * domain interfaces. CORE_FILES member: editing is reviewed as DI wiring and
 * mandates a tier-3 run.
 *
 * Holds the host runtime: the signaling<->peer SDP/ICE glue (deferred here
 * from S11 because it needs concrete peer-connection methods absent from the
 * PeerTransport interface), and the decode -> authorize -> relay -> record ->
 * send loop. All concretions are instantiated ONLY in `realFactories`.
 */

import { loadConfig, type BeamConfig } from './config.js';
import { FrameType, type Frame, type StreamId } from './domain/frame.js';
import {
  ok,
  type PeerTransport,
  type ReplayClient,
  type RequestLogRepository,
  type Result,
  type SignalingClient,
  type SignalingMessage,
  type Unsubscribe,
} from './domain/interfaces.js';
import { InMemoryRequestLogStore } from './infrastructure/request-log-store.js';
import { LoopbackReplayClient } from './infrastructure/replay-client.js';
import { WebSocketSignalingClient } from './infrastructure/signaling-client.js';
import {
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

export interface HostFactories {
  createLogStore(): RequestLogRepository;
  createReplayClient(localPort: number): ReplayClient;
  createSignalingClient(signalingUrl: string): SignalingClient;
  createPeer(): ConnectablePeer;
}

// The ONLY place concrete infrastructure is instantiated.
export const realFactories: HostFactories = {
  createLogStore: () => new InMemoryRequestLogStore(),
  createReplayClient: (localPort) => new LoopbackReplayClient(localPort),
  createSignalingClient: (signalingUrl) => new WebSocketSignalingClient(signalingUrl),
  createPeer: () => new PeerConnectionTransport({ role: 'offer' }),
};

function parseRemoteCandidate(payload: string): { candidate: string; mid: string } | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { candidate?: unknown }).candidate;
      const mid = (parsed as { mid?: unknown }).mid;
      if (typeof candidate === 'string' && typeof mid === 'string') {
        return { candidate, mid };
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

function responseStatus(frames: readonly Frame[]): number {
  const head = frames[0];
  if (!head || head.type !== FrameType.RESPONSE_HEAD) {
    return 502;
  }
  const decoded = decodeResponseHead(head.payload);
  return decoded.ok ? decoded.value.status : 502;
}

interface RelayDependencies {
  readonly mux: StreamMultiplexer;
  readonly relay: ExecuteRelayUseCase;
  readonly recorder: RecordRequestUseCase;
  readonly allowedPaths: readonly string[];
  readonly now: () => number;
  readonly waitForDrain: () => Promise<void>;
}

/**
 * Write response frames through the mux (NOT transport.send) so they share the
 * request's stream id (S4.1 half-close) and engage backpressure. When the mux
 * signals pause (high-water), defer further writes until the channel drains —
 * a large response no longer floods past the threshold.
 */
async function writeResponse(deps: RelayDependencies, frames: readonly Frame[]): Promise<void> {
  for (const frame of frames) {
    deps.mux.writeFrame(frame);
    if (deps.mux.isPaused()) {
      await deps.waitForDrain();
    }
  }
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
  const responseFrames = await deps.relay.execute(frames);
  await writeResponse(deps, responseFrames);
  await deps.recorder.record({
    method: request.method,
    path: request.path,
    status: responseStatus(responseFrames),
    latencyMs: deps.now() - startedAt,
    responseSizeBytes: responseSizeBytes(responseFrames),
    streamId,
  });
}

/**
 * Inbound REQUEST_* frames are demuxed by the StreamMultiplexer, accumulated
 * per stream until REQUEST_END, authorized, relayed, and written back through
 * the mux on the SAME stream id (half-close: the inbound half is closed but the
 * outbound half stays open) with backpressure honored, then recorded.
 */
export function runRelayLoop(deps: RelayDependencies): Unsubscribe {
  const pending = new Map<number, Frame[]>();
  return deps.mux.onInbound((frame) => {
    const list = pending.get(frame.streamId) ?? [];
    list.push(frame);
    pending.set(frame.streamId, list);
    if (frame.type === FrameType.REQUEST_END) {
      pending.delete(frame.streamId);
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
}

export interface HostRuntime {
  start(rawCode: string): Promise<Result<undefined, StartSessionError>>;
  close(reason: string): Promise<void>;
  readonly session: ExecuteSessionUseCase;
  readonly diagnostics: QueryDiagnosticsUseCase;
}

export function composeHost(options: HostOptions, factories: HostFactories = realFactories): HostRuntime {
  const now = options.now ?? ((): number => Date.now());
  const logStore = factories.createLogStore();
  const replayClient = factories.createReplayClient(options.localPort);
  const signaling = factories.createSignalingClient(options.signalingUrl);
  const peer = factories.createPeer();
  const mux = new StreamMultiplexer(peer);
  const relay = new ExecuteRelayUseCase(replayClient);
  const recorder = new RecordRequestUseCase(logStore, now);
  const session = new ExecuteSessionUseCase(signaling, now);
  const diagnostics = new QueryDiagnosticsUseCase(logStore);

  forwardLocalSignals(peer, signaling);
  applyRemoteSignals(signaling, peer);
  runRelayLoop({ mux, relay, recorder, allowedPaths: options.allowedPaths ?? [], now, waitForDrain: pollDrain(peer, LOW_WATER_MARK) });

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
  };
}
