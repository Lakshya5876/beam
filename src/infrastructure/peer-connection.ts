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
import { resolveWithFallback } from './mdns-resolve.js';
import { parseIceUrl } from '../application/ice-servers.js';
import {
  err,
  ok,
  type IceServerConfig,
  type PeerTransport,
  type Result,
  type TransportClosedError,
  type Unsubscribe,
} from '../domain/interfaces.js';

export const DEFAULT_STUN_SERVER = 'stun:stun.l.google.com:19302';
export const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;

/**
 * node-datachannel's structured ICE server (mirrors its RtcConfig.iceServers
 * member). Declared structurally rather than imported so the native type stays
 * confined to this adapter, like NativePeerConnection above.
 */
export interface NativeIceServer {
  readonly hostname: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly relayType?: 'TurnUdp' | 'TurnTcp' | 'TurnTls';
}

/** TURN over TLS is `turns:`; plain TURN splits on the transport parameter. */
function relayTypeOf(scheme: string, transport: string): 'TurnUdp' | 'TurnTcp' | 'TurnTls' {
  if (scheme === 'turns') {
    return 'TurnTls';
  }
  return transport === 'tcp' ? 'TurnTcp' : 'TurnUdp';
}

/**
 * Convert one domain ICE server into node-datachannel's form. Returns null
 * for an unparseable URL, or a TURN entry missing credentials — both are
 * dropped rather than handed to the native layer, which treats a malformed
 * server as a hard construction failure and would take the whole connection
 * down over one bad entry.
 *
 * The structured form is used deliberately over `turn:user:pass@host:port`:
 * a minted password may contain ':' or '@'.
 */
export function toNativeIceServer(entry: IceServerConfig): NativeIceServer | null {
  const parsed = parseIceUrl(entry.urls);
  if (!parsed) {
    return null;
  }
  if (parsed.scheme === 'stun' || parsed.scheme === 'stuns') {
    return { hostname: parsed.host, port: parsed.port };
  }
  if (entry.username === undefined || entry.credential === undefined) {
    return null;
  }
  return {
    hostname: parsed.host,
    port: parsed.port,
    username: entry.username,
    password: entry.credential,
    relayType: relayTypeOf(parsed.scheme, parsed.transport),
  };
}

export function toNativeIceServers(entries: readonly IceServerConfig[]): NativeIceServer[] {
  const out: NativeIceServer[] = [];
  for (const entry of entries) {
    const native = toNativeIceServer(entry);
    if (native) {
      out.push(native);
    }
  }
  return out;
}

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

/** Selected ICE pair endpoints, when the native layer exposes them. */
export interface SelectedCandidateInfo {
  readonly type?: string;
  readonly address?: string;
  readonly port?: number;
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
  /** Optional (node-datachannel exposes it); used for the relay/direct log. */
  getSelectedCandidatePair?(): { local?: SelectedCandidateInfo; remote?: SelectedCandidateInfo } | null;
  /** Optional diagnostics: ICE/gathering state changes (node-datachannel). */
  onIceStateChange?(cb: (state: string) => void): void;
  onGatheringStateChange?(cb: (state: string) => void): void;
}

/**
 * 'all' (the default) lets ICE try every candidate pair and nominate the best
 * one — direct whenever a direct pair works, relay only as the fallback.
 * 'relay' suppresses host/srflx candidates entirely, forcing traffic through
 * TURN; it exists to VERIFY the relay path end-to-end (and to diagnose a
 * user's network), never as the normal transport.
 */
export type IceTransportPolicy = 'all' | 'relay';

export interface NativePeerOptions {
  readonly iceServers: NativeIceServer[];
  readonly maxMessageSize: number;
  readonly iceTransportPolicy?: IceTransportPolicy;
}

export type NativePeerConnectionFactory = (options: NativePeerOptions) => NativePeerConnection;

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

/**
 * Extract the UUID.local mDNS hostname from a raw ICE candidate string, or
 * return null if the candidate uses a plain IP address.
 *
 * Chrome hides local IPs behind mDNS hostnames (RFC 8828) by default since
 * Chrome 75. libdatachannel does not resolve .local names, so the host must
 * resolve them via the OS mDNS resolver before passing to the native layer.
 */
/** ICE candidate type (`typ host|srflx|prflx|relay`) for diagnostics logs. */
export function candidateTypeOf(candidate: string): string | null {
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(candidate);
  return m?.[1] ?? null;
}

/**
 * True when the candidate's connection address is an IPv6 literal.
 * Candidate grammar: `candidate:<f> <comp> <proto> <pri> <addr> <port> typ …`
 * — the 5th field is the address; a ':' in it means IPv6.
 */
export function isIpv6Candidate(candidate: string): boolean {
  const fields = candidate.trim().split(/\s+/);
  const addr = fields[4];
  return addr !== undefined && addr.includes(':');
}

/** Relay/direct log fragment from a selected ICE pair. */
export function formatSelectedPair(pair: { local?: SelectedCandidateInfo; remote?: SelectedCandidateInfo }): string {
  const localType = pair.local?.type ?? '?';
  const remoteType = pair.remote?.type ?? '?';
  const relayed = localType === 'relay' || remoteType === 'relay';
  const addr = (c?: SelectedCandidateInfo): string => (c?.address !== undefined ? `[${c.address}]:${String(c.port ?? 0)}` : '');
  return `path=${relayed ? 'RELAY (TURN)' : 'DIRECT'} local=${localType}${addr(pair.local)} remote=${remoteType}${addr(pair.remote)}`;
}

export function extractMdnsHost(candidate: string): string | null {
  const m = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local)\b/i.exec(candidate);
  return m?.[1] ?? null;
}

async function defaultResolveMdns(host: string): Promise<string> {
  return resolveWithFallback(host);
}

function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array | null {
  if (typeof msg === 'string') {
    return null;
  }
  return msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg);
}

/**
 * Global libdatachannel log level (BEAM_NATIVE_LOG). Deep-diagnosis knob:
 * shows juice's per-candidate connectivity checks, which --debug's state
 * timeline cannot. Invalid levels are ignored (total).
 */
export function initNativeLogging(level: string): void {
  try {
    nodeDataChannel.initLogger(level as 'Verbose' | 'Debug' | 'Info' | 'Warning' | 'Error');
  } catch {
    // Unknown level or native init failure — diagnostics must never crash the host.
  }
}

function defaultFactory(options: NativePeerOptions): NativePeerConnection {
  // The real node-datachannel PeerConnection structurally satisfies the port;
  // the cast confines native typing to this one adapter line.
  return new nodeDataChannel.PeerConnection('beam', {
    iceServers: options.iceServers as nodeDataChannel.RtcConfig['iceServers'],
    maxMessageSize: options.maxMessageSize,
    ...(options.iceTransportPolicy !== undefined && { iceTransportPolicy: options.iceTransportPolicy }),
  }) as unknown as NativePeerConnection;
}

interface PeerConnectionOptions {
  readonly role: PeerRole;
  readonly iceServers?: readonly IceServerConfig[];
  readonly connectTimeoutMs?: number;
  readonly maxMessageSize?: number;
  readonly factory?: NativePeerConnectionFactory;
  readonly resolveMdns?: (host: string) => Promise<string>;
  readonly log?: (msg: string) => void;
  /** See IceTransportPolicy — 'relay' is a verification/diagnostic mode. */
  readonly iceTransportPolicy?: IceTransportPolicy;
  /**
   * Drop IPv6 candidates in both directions (--ipv4-only). Opt-in mitigation:
   * stalled IPv6 pairs were observed adding ~10s to nomination (and
   * occasionally failing it outright) while IPv4 pairs won every time.
   * Leave off where IPv6 may be the only viable path (e.g. IPv4 CGNAT).
   */
  readonly ipv4Only?: boolean;
}

export class PeerConnectionTransport implements PeerTransport {
  private readonly pc: NativePeerConnection;
  private readonly role: PeerRole;
  private readonly connectTimeoutMs: number;
  private readonly resolveMdns: (host: string) => Promise<string>;
  private readonly ipv4Only: boolean;
  private readonly log: (msg: string) => void;
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
    this.resolveMdns = options.resolveMdns ?? defaultResolveMdns;
    this.ipv4Only = options.ipv4Only ?? false;
    this.log = options.log ?? ((): void => { /* noop */ });
    const factory = options.factory ?? defaultFactory;
    const configured = options.iceServers ?? [{ urls: DEFAULT_STUN_SERVER }];
    const native = toNativeIceServers(configured);
    this.log(
      `[HOST-PC] iceServers=${String(native.length)}/${String(configured.length)} usable` +
        ` relay=${String(native.some((s) => s.relayType !== undefined))}` +
        ` policy=${options.iceTransportPolicy ?? 'all'}`,
    );
    this.pc = factory({
      iceServers: native,
      maxMessageSize: options.maxMessageSize ?? MAX_FRAME_SIZE,
      ...(options.iceTransportPolicy !== undefined && { iceTransportPolicy: options.iceTransportPolicy }),
    });
    this.wirePeerConnection();
  }

  private wirePeerConnection(): void {
    this.pc.onLocalDescription((sdp, type) => {
      this.log(`[HOST-PC] localDescription type=${type} sdp.length=${sdp.length}`);
      for (const handler of this.localDescriptionHandlers) {
        handler(sdp, type);
      }
    });
    this.pc.onLocalCandidate((candidate, mid) => {
      if (this.ipv4Only && isIpv6Candidate(candidate)) {
        this.log(`[HOST-PC] localCandidate SKIPPED (ipv4-only) ${candidate.slice(0, 60)}`);
        return;
      }
      this.log(`[HOST-PC] localCandidate typ=${candidateTypeOf(candidate) ?? '?'} mid=${mid} ${candidate.slice(0, 80)}`);
      for (const handler of this.localCandidateHandlers) {
        handler(candidate, mid);
      }
    });
    this.pc.onStateChange((state) => {
      this.log(`[HOST-PC] peerState=${state}`);
      this.handleStateChange(state);
    });
    this.pc.onDataChannel((channel) => {
      this.adoptChannel(channel);
    });
    // Diagnostics-only: finer-grained than the aggregate peer state. Optional
    // on the port so test fakes stay minimal.
    this.pc.onIceStateChange?.((state) => {
      this.log(`[HOST-PC] iceState=${state}`);
    });
    this.pc.onGatheringStateChange?.((state) => {
      this.log(`[HOST-PC] gatheringState=${state}`);
    });
  }

  /** Begin the connection attempt. Offerer creates the channel (kicks ICE). */
  start(): void {
    this.log(`[HOST-PC] start role=${this.role} timeout=${this.connectTimeoutMs}ms`);
    this.connectTimer = setTimeout(() => {
      this.log('[HOST-PC] connect TIMEOUT');
      this.settleConnect(err({ error: 'PeerConnectFailed', reason: 'connect-timeout' }));
    }, this.connectTimeoutMs);
    if (this.role === 'offer') {
      try {
        this.log('[HOST-PC] createDataChannel');
        this.adoptChannel(this.pc.createDataChannel('beam'));
      } catch {
        this.settleConnect(err({ error: 'PeerConnectFailed', reason: 'closed-before-open' }));
      }
    }
  }

  private adoptChannel(channel: NativeDataChannel): void {
    this.channel = channel;
    channel.onOpen(() => {
      this.log(`[HOST-PC] DataChannel OPEN ${this.describeSelectedPath()}`);
      this.channelOpen = true;
      this.settleConnect(ok());
    });
    channel.onClosed(() => {
      this.log('[HOST-PC] DataChannel CLOSED');
      this.channelOpen = false;
      this.fireClose('data channel closed');
    });
    channel.onError((reason) => {
      this.log(`[HOST-PC] DataChannel ERROR: ${reason}`);
      this.fireClose(reason);
    });
    channel.onMessage((msg) => {
      this.deliverInbound(msg);
    });
  }

  /**
   * Relay/direct indicator from the selected ICE pair, when the native layer
   * exposes it. `relay` on either side means TURN carried the traffic;
   * anything else is a direct (host/srflx/prflx) path. Defensive: absence or
   * a native throw degrades to 'path=unknown', never breaks the open path.
   */
  private describeSelectedPath(): string {
    try {
      const pair = this.pc.getSelectedCandidatePair?.();
      return pair ? formatSelectedPair(pair) : 'path=unknown';
    } catch {
      return 'path=unknown';
    }
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
      this.log('[HOST-PC] inbound DROPPED: non-binary message');
      return;
    }
    const decoded = decodeFrame(bytes);
    if (isFrameDecodeError(decoded)) {
      this.log(`[HOST-PC] inbound DROPPED: ${decoded.error} len=${bytes.byteLength}`);
      return;
    }
    this.log(`[HOST-PC] inbound frame type=${decoded.type} sid=${decoded.streamId} len=${decoded.payload.byteLength} handlers=${this.frameHandlers.length}`);
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
    this.log(`[HOST-PC] applyRemoteDescription type=${type} sdp.length=${sdp.length}`);
    try {
      this.pc.setRemoteDescription(sdp, type);
    } catch {
      this.log('[HOST-PC] applyRemoteDescription FAILED');
      return err(signalingError('apply-remote-description-failed'));
    }
    this.remoteDescriptionApplied = true;
    this.log(`[HOST-PC] flushing ${String(this.pendingCandidates.length)} buffered candidates`);
    for (const pending of this.pendingCandidates) {
      this.guardedAddCandidate(pending.candidate, pending.mid);
    }
    this.pendingCandidates = [];
    return ok();
  }

  addRemoteCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError> {
    if (this.ipv4Only && isIpv6Candidate(candidate)) {
      this.log(`[HOST-PC] addRemoteCandidate SKIPPED (ipv4-only) ${candidate.slice(0, 60)}`);
      return ok();
    }
    this.log(`[HOST-PC] addRemoteCandidate typ=${candidateTypeOf(candidate) ?? '?'} buffered=${!this.remoteDescriptionApplied} ${candidate.slice(0, 80)}`);
    if (!this.remoteDescriptionApplied) {
      // Buffer until the remote description is applied — a candidate passed to
      // the native layer first aborts the process.
      this.pendingCandidates.push({ candidate, mid });
      return ok();
    }
    return this.guardedAddCandidate(candidate, mid);
  }

  private guardedAddCandidate(candidate: string, mid: string): Result<undefined, PeerSignalingError> {
    const mdnsHost = extractMdnsHost(candidate);
    if (mdnsHost) {
      void this.resolveAndAddCandidate(candidate, mdnsHost, mid);
      return ok();
    }
    try {
      this.pc.addRemoteCandidate(candidate, mid);
    } catch (error) {
      this.log(`[HOST-PC] addRemoteCandidate FAILED: ${error instanceof Error ? error.message : String(error)}`);
      return err(signalingError('add-remote-candidate-failed'));
    }
    return ok();
  }

  private async resolveAndAddCandidate(candidate: string, host: string, mid: string): Promise<void> {
    try {
      const ip = await this.resolveMdns(host);
      this.log(`[HOST-PC] mDNS ${host} → ${ip}`);
      this.pc.addRemoteCandidate(candidate.replace(host, ip), mid);
    } catch (err) {
      this.log(`[HOST-PC] mDNS ${host} unresolvable (${err instanceof Error ? err.message : String(err)}) — skipped`);
    }
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
    this.settleConnect(err({ error: 'PeerConnectFailed', reason: 'closed-before-open' }));
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
