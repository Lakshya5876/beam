/**
 * WebRTC peer-connection transport (design doc §10 S9, §6 honest-failure).
 * Implements the domain PeerTransport seam over node-datachannel.
 *
 * The native PeerConnection/DataChannel sit behind infra-internal STRUCTURAL
 * PORTS injected via a factory: the real node-datachannel objects satisfy
 * them in composition; fakes drive them in tests. No native/WebRTC type
 * crosses the PeerTransport (domain) boundary — the TURN-swap seam is intact.
 *
 * Native-lifecycle totality (validated empirically):
 *   - addRemoteCandidate BEFORE setRemoteDescription aborts the process, so
 *     remote candidates are BUFFERED until the remote description is applied,
 *     then flushed. Every native call is guarded into a typed error.
 *
 * NOTE: a real two-endpoint ICE round-trip and the empirical max-message-size
 * reconciliation against S4 are DEFERRED to S18/S19. Two in-process peers do
 * NOT pair (confirmed in multiple environments) — S18 must use a real second
 * endpoint (browser or separate process), never two in-process peers.
 */

import nodeDataChannel from 'node-datachannel';
import { decodeFrame, encodeFrame, isFrameDecodeError, MAX_FRAME_SIZE, type Frame } from '../domain/frame.js';
import {
  err,
  ok,
  type PeerTransport,
  type Result,
  type TransportClosedError,
  type Unsubscribe,
} from '../domain/interfaces.js';

export const DEFAULT_STUN_SERVER = 'stun:stun.l.google.com:19302';
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Infra-internal port: the subset of a native data channel we depend on. */
export interface NativeDataChannel {
  sendMessageBinary(buffer: Uint8Array): boolean;
  isOpen(): boolean;
  bufferedAmount(): number;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

/** Infra-internal port: the subset of a native peer connection we depend on. */
export interface NativePeerConnection {
  createDataChannel(label: string): NativeDataChannel;
  setRemoteDescription(sdp: string, type: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  state(): string;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (channel: NativeDataChannel) => void): void;
  close(): void;
}

export type NativePeerConnectionFactory = (iceServers: string[], maxMessageSize: number) => NativePeerConnection;

export type PeerRole = 'offer' | 'answer';

export interface PeerConnectFailedError {
  readonly error: 'PeerConnectFailed';
  readonly reason: 'no-viable-candidate' | 'connect-timeout' | 'closed-before-open';
}

export interface PeerSignalingError {
  readonly error: 'PeerSignalingRejected';
  readonly reason: string;
}

export function isPeerConnectFailedError(value: unknown): value is PeerConnectFailedError {
  return typeof value === 'object' && value !== null && (value as PeerConnectFailedError).error === 'PeerConnectFailed';
}

export function isPeerSignalingError(value: unknown): value is PeerSignalingError {
  return typeof value === 'object' && value !== null && (value as PeerSignalingError).error === 'PeerSignalingRejected';
}

/**
 * Pure failure classifier (design §6). Returns the typed failure reason for a
 * pre-open connection state, or null when the state is not a failure.
 */
export function classifyConnectionFailure(state: string): PeerConnectFailedError['reason'] | null {
  if (state === 'failed') {
    return 'no-viable-candidate';
  }
  if (state === 'disconnected' || state === 'closed') {
    return 'closed-before-open';
  }
  return null;
}

function signalingError(reason: string): PeerSignalingError {
  return { error: 'PeerSignalingRejected', reason };
}

function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array | null {
  if (typeof msg === 'string') {
    return null;
  }
  return msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg);
}

function defaultFactory(iceServers: string[], maxMessageSize: number): NativePeerConnection {
  // The real node-datachannel PeerConnection structurally satisfies the port;
  // the cast confines native typing to this one adapter line.
  return new nodeDataChannel.PeerConnection('beam', { iceServers, maxMessageSize }) as unknown as NativePeerConnection;
}

interface PeerConnectionOptions {
  readonly role: PeerRole;
  readonly iceServers?: string[];
  readonly connectTimeoutMs?: number;
  readonly maxMessageSize?: number;
  readonly factory?: NativePeerConnectionFactory;
}

export class PeerConnectionTransport implements PeerTransport {
  private readonly pc: NativePeerConnection;
  private readonly role: PeerRole;
  private readonly connectTimeoutMs: number;
  private channel: NativeDataChannel | null = null;
  private channelOpen = false;
  private remoteDescriptionApplied = false;
  private pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  private readonly frameHandlers: Array<(frame: Frame) => void> = [];
  private readonly closeHandlers: Array<(reason: string) => void> = [];
  private readonly localDescriptionHandlers: Array<(sdp: string, type: string) => void> = [];
  private readonly localCandidateHandlers: Array<(candidate: string, mid: string) => void> = [];
  private connectSettled = false;
  private closeFired = false;
  private connectResolve: ((result: Result<undefined, PeerConnectFailedError>) => void) | null = null;
  private connectResult: Result<undefined, PeerConnectFailedError> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PeerConnectionOptions) {
    this.role = options.role;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const factory = options.factory ?? defaultFactory;
    this.pc = factory(options.iceServers ?? [DEFAULT_STUN_SERVER], options.maxMessageSize ?? MAX_FRAME_SIZE);
    this.wirePeerConnection();
  }

  private wirePeerConnection(): void {
    this.pc.onLocalDescription((sdp, type) => {
      console.log(`[HOST-PC] localDescription type=${type} sdp.length=${sdp.length}`);
      for (const handler of this.localDescriptionHandlers) {
        handler(sdp, type);
      }
    });
    this.pc.onLocalCandidate((candidate, mid) => {
      console.log(`[HOST-PC] localCandidate mid=${mid} ${candidate.slice(0, 80)}`);
      for (const handler of this.localCandidateHandlers) {
        handler(candidate, mid);
      }
    });
    this.pc.onStateChange((state) => {
      console.log(`[HOST-PC] peerState=${state}`);
      this.handleStateChange(state);
    });
    this.pc.onDataChannel((channel) => {
      this.adoptChannel(channel);
    });
  }

  /** Begin the connection attempt. Offerer creates the channel (kicks ICE). */
  start(): void {
    console.log(`[HOST-PC] start role=${this.role} timeout=${this.connectTimeoutMs}ms`);
    this.connectTimer = setTimeout(() => {
      console.log('[HOST-PC] connect TIMEOUT');
      this.settleConnect(err({ error: 'PeerConnectFailed', reason: 'connect-timeout' }));
    }, this.connectTimeoutMs);
    if (this.role === 'offer') {
      try {
        console.log('[HOST-PC] createDataChannel');
        this.adoptChannel(this.pc.createDataChannel('beam'));
      } catch {
        this.settleConnect(err({ error: 'PeerConnectFailed', reason: 'closed-before-open' }));
      }
    }
  }

  private adoptChannel(channel: NativeDataChannel): void {
    this.channel = channel;
    channel.onOpen(() => {
      console.log('[HOST-PC] DataChannel OPEN');
      this.channelOpen = true;
      this.settleConnect(ok());
    });
    channel.onClosed(() => {
      console.log('[HOST-PC] DataChannel CLOSED');
      this.channelOpen = false;
      this.fireClose('data channel closed');
    });
    channel.onError((reason) => {
      console.log(`[HOST-PC] DataChannel ERROR: ${reason}`);
      this.fireClose(reason);
    });
    channel.onMessage((msg) => {
      this.deliverInbound(msg);
    });
  }

  private handleStateChange(state: string): void {
    if (!this.connectSettled) {
      const reason = classifyConnectionFailure(state);
      if (reason) {
        this.settleConnect(err({ error: 'PeerConnectFailed', reason }));
      }
      return;
    }
    if (this.channelOpen && (state === 'failed' || state === 'disconnected' || state === 'closed')) {
      this.fireClose(`peer ${state}`);
    }
  }

  private deliverInbound(msg: string | Buffer | ArrayBuffer): void {
    const bytes = toBytes(msg);
    if (!bytes) {
      return;
    }
    const decoded = decodeFrame(bytes);
    if (isFrameDecodeError(decoded)) {
      return;
    }
    for (const handler of this.frameHandlers) {
      handler(decoded);
    }
  }

  private settleConnect(result: Result<undefined, PeerConnectFailedError>): void {
    if (this.connectSettled) {
      return;
    }
    this.connectSettled = true;
    this.connectResult = result;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.connectResolve) {
      this.connectResolve(result);
    }
  }

  private fireClose(reason: string): void {
    if (this.closeFired) {
      return;
    }
    this.closeFired = true;
    for (const handler of this.closeHandlers) {
      handler(reason);
    }
  }

  awaitConnected(): Promise<Result<undefined, PeerConnectFailedError>> {
    if (this.connectResult) {
      return Promise.resolve(this.connectResult);
    }
    return new Promise<Result<undefined, PeerConnectFailedError>>((resolve) => {
      this.connectResolve = resolve;
    });
  }

  onLocalDescription(handler: (sdp: string, type: string) => void): Unsubscribe {
    return this.register(this.localDescriptionHandlers, handler);
  }

  onLocalCandidate(handler: (candidate: string, mid: string) => void): Unsubscribe {
    return this.register(this.localCandidateHandlers, handler);
  }

  applyRemoteDescription(sdp: string, type: string): Result<undefined, PeerSignalingError> {
    console.log(`[HOST-PC] applyRemoteDescription type=${type} sdp.length=${sdp.length}`);
    try {
      this.pc.setRemoteDescription(sdp, type);
    } catch {
      console.log('[HOST-PC] applyRemoteDescription FAILED');
      return err(signalingError('apply-remote-description-failed'));
    }
    this.remoteDescriptionApplied = true;
    console.log(`[HOST-PC] flushing ${String(this.pendingCandidates.length)} buffered candidates`);
    for (const pending of this.pendingCandidates) {
      this.guardedAddCandidate(pending.candidate, pending.mid);
    }
    this.pendingCandidates = [];
    return ok();
  }

  addRemoteCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError> {
    console.log(`[HOST-PC] addRemoteCandidate buffered=${!this.remoteDescriptionApplied} ${candidate.slice(0, 80)}`);
    if (!this.remoteDescriptionApplied) {
      // Buffer until the remote description is applied — a candidate passed to
      // the native layer first aborts the process.
      this.pendingCandidates.push({ candidate, mid });
      return ok();
    }
    return this.guardedAddCandidate(candidate, mid);
  }

  private guardedAddCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError> {
    try {
      this.pc.addRemoteCandidate(candidate, mid);
    } catch {
      return err(signalingError('add-remote-candidate-failed'));
    }
    return ok();
  }

  send(frame: Frame): Result<undefined, TransportClosedError> {
    if (!this.channel || !this.channelOpen) {
      return err({ error: 'TransportClosed' });
    }
    try {
      this.channel.sendMessageBinary(encodeFrame(frame));
    } catch {
      this.channelOpen = false;
      return err({ error: 'TransportClosed' });
    }
    return ok();
  }

  onFrame(handler: (frame: Frame) => void): Unsubscribe {
    return this.register(this.frameHandlers, handler);
  }

  onClose(handler: (reason: string) => void): Unsubscribe {
    return this.register(this.closeHandlers, handler);
  }

  bufferedAmount(): number {
    if (!this.channel || !this.channelOpen) {
      return 0;
    }
    return this.channel.bufferedAmount();
  }

  close(): void {
    this.channelOpen = false;
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // already closed natively — nothing to surface
      }
      this.channel = null;
    }
    try {
      this.pc.close();
    } catch {
      // already closed natively — nothing to surface
    }
  }

  private register<T>(list: T[], handler: T): Unsubscribe {
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }
}
