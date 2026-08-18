/**
 * The four seam interfaces (design doc §A.6.1).
 * Everything here is typed in domain terms only — no WebRTC, WebSocket,
 * Node http, or platform types cross these boundaries. Infrastructure
 * implements these; application orchestrates against them; composition.ts
 * is the only place the two meet.
 */

import type { Frame, StreamId } from './frame.js';
import type { SessionCode } from './session.js';

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok(): Ok<undefined>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Handler deregistration function returned by every on* subscription. */
export type Unsubscribe = () => void;

export interface TransportClosedError {
  readonly error: 'TransportClosed';
}

/**
 * Byte/frame channel abstraction. The S4 protocol depends on THIS, never on
 * WebRTC — the same protocol code runs over a data channel, a future TURN
 * relay, or an in-process pipe in tests. bufferedAmount exposes the
 * backpressure signal S4's high/low-water marks are built on.
 */
export interface PeerTransport {
  send(frame: Frame): Result<undefined, TransportClosedError>;
  onFrame(handler: (frame: Frame) => void): Unsubscribe;
  onClose(handler: (reason: string) => void): Unsubscribe;
  close(): void;
  bufferedAmount(): number;
}

/**
 * Opaque connection-setup message (SDP offer/answer, ICE candidate).
 * The domain relays these; it never parses them.
 */
export interface SignalingMessage {
  readonly kind: 'offer' | 'answer' | 'ice-candidate';
  readonly payload: string;
}

export interface SignalingConnectError {
  readonly error: 'SignalingConnectFailed';
  readonly reason: string;
}

export interface SignalingNotConnectedError {
  readonly error: 'SignalingNotConnected';
}

export interface SignalingClient {
  connect(code: SessionCode): Promise<Result<undefined, SignalingConnectError>>;
  sendMessage(message: SignalingMessage): Promise<Result<undefined, SignalingNotConnectedError>>;
  onMessage(handler: (message: SignalingMessage) => void): Unsubscribe;
  disconnect(): Promise<void>;
  registerPin(hash: string): Promise<Result<undefined, SignalingNotConnectedError>>;
}

/**
 * One ICE server, in Beam's own terms — deliberately RTCIceServer-compatible
 * so it needs no translation at the browser end, but owned here so neither a
 * TURN provider's response shape nor node-datachannel's config type leaks
 * across a layer boundary. Credentials stay in separate fields rather than
 * being packed into the URL: a provider-generated password may contain ':'
 * or '@', which the `turn:user:pass@host:port` form cannot represent
 * unambiguously.
 */
export interface IceServerConfig {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface IceConfigFetchError {
  readonly error: 'IceConfigFetchFailed';
  readonly reason: string;
}

/**
 * Fetches the ICE servers both peers should use (GET /ice-config on the
 * signaling origin). The host needs this for the same reason the viewer does:
 * TURN credentials are minted server-side and are short-lived, so neither end
 * can have them compiled in. A failure here is NOT fatal — the caller falls
 * back to its configured/default STUN and still attempts a direct connection.
 */
export interface IceConfigClient {
  fetchIceServers(signalingUrl: string): Promise<Result<readonly IceServerConfig[], IceConfigFetchError>>;
}

export interface ReplayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** A complete, buffered response — still used for synthetic responses (e.g. the 403 the path-authorization layer builds) that never touch a real upstream. */
export interface ReplayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ReplayResponseHead {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Streaming sink for a replayed response: onHead fires once, then onChunk
 * fires zero or more times with body bytes IN ORDER, then onEnd fires once —
 * mirroring the wire's RESPONSE_HEAD / RESPONSE_BODY_CHUNK* / RESPONSE_END
 * sequence so the caller can frame and forward bytes as they arrive instead
 * of buffering the full body first. Required for SSE, long-lived responses,
 * and large downloads — buffering the whole body before relaying anything
 * both stalls forever on a response that never ends and holds arbitrarily
 * large bodies in host memory.
 *
 * Each method may return a Promise; a ReplayClient implementation MUST await
 * it before pulling more bytes from the upstream connection — this is the
 * mechanism by which outbound-transport backpressure (the DataChannel mux's
 * high-water mark) propagates back to the loopback socket, so a slow viewer
 * cannot make the host buffer an unbounded amount of a large response.
 */
export interface ReplaySink {
  onHead(head: ReplayResponseHead): void | Promise<void>;
  onChunk(chunk: Uint8Array): void | Promise<void>;
  onEnd(): void | Promise<void>;
}

export interface ReplayFailedError {
  readonly error: 'ReplayFailed';
  readonly reason: string;
}

/**
 * Replays a viewer request against the developer's localhost app, streaming
 * the response through `sink`. Resolves ok() once onEnd has completed, or
 * err() on failure. A failure reported AFTER onHead has already fired is a
 * MID-STREAM abort (the response was already partially delivered) — callers
 * must not treat it as a fresh, headless failure.
 */
export interface ReplayClient {
  replay(request: ReplayRequest, sink: ReplaySink): Promise<Result<undefined, ReplayFailedError>>;
}

/** One replayed request, as rendered by the diagnostics surface (design §7). */
export interface RequestRecord {
  readonly timestampMs: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly responseSizeBytes: number;
  readonly streamId: StreamId;
}

export interface RequestLogRepository {
  persistRecord(record: RequestRecord): Promise<void>;
  fetchRecent(limit: number): Promise<readonly RequestRecord[]>;
  findByStreamId(streamId: StreamId): Promise<readonly RequestRecord[]>;
}

export interface WsConnectRequest {
  readonly path: string;
  readonly protocols: readonly string[];
}

/** Callbacks the WsRelayClient drives as the localhost WebSocket connection progresses. */
export interface WsRelaySessionHandlers {
  onOpen(protocol: string): void;
  onMessage(data: Uint8Array, isBinary: boolean): void;
  onClose(code: number, reason: string): void;
  /** A connect-time or mid-connection failure. May fire instead of onOpen, or after it. */
  onError(reason: string): void;
}

/** A live (or connecting) relayed WebSocket connection to the developer's localhost app. */
export interface WsRelaySession {
  send(data: Uint8Array, isBinary: boolean): void;
  close(code: number, reason: string): void;
}

/**
 * Opens a WebSocket to the developer's localhost app on the viewer's behalf.
 * Loopback-confined the same way ReplayClient is — the target host:port is
 * fixed at construction, never sourced from viewer input.
 */
export interface WsRelayClient {
  connect(request: WsConnectRequest, handlers: WsRelaySessionHandlers): WsRelaySession;
}
