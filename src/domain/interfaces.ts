/**
 * The four seam interfaces (design doc §A.6.1, CLAUDE.md §1 Domain).
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
}

export interface ReplayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ReplayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ReplayFailedError {
  readonly error: 'ReplayFailed';
  readonly reason: string;
}

/** Replays a viewer request against the developer's localhost app. */
export interface ReplayClient {
  replay(request: ReplayRequest): Promise<Result<ReplayResponse, ReplayFailedError>>;
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
