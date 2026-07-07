/**
 * Viewer-side answerer orchestration: receive offer, answer, buffer candidates,
 * manage connection state. Injected ports (BrowserPeer, SignalingSocket) —
 * pure logic, testable with fakes; browser runtime at S18.
 */

import type { PeerTransport, Unsubscribe } from '../../src/domain/interfaces.js';
import { parseMessage, serializeMessage, type IceCandidate } from './signaling-messages.js';

// Consumers (browser-peer.ts, tests) take IceCandidate from this module's
// BrowserPeer seam — re-export so the type gate holds.
export type { IceCandidate };
import { createViewerMultiplexer } from './protocol-bridge.js';
import type { StreamMultiplexer, Frame } from './protocol-bridge.js';
import { BrowserDataChannelAdapter } from './browser-datachannel.js';

export interface BrowserPeer {
  applyRemoteDescription(sdp: string): Promise<void>;
  createAnswer(): Promise<string>;
  setLocalDescription(sdp: string): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  onicecandidate(handler: (candidate: IceCandidate) => void): void;
  onconnectionstatechange(handler: (state: string) => void): void;
  ondatachannel(handler: (channel: unknown) => void): void;
  close(): void;
}

export interface SignalingSocket {
  send(text: string): Promise<void>;
  onmessage(handler: (text: string) => void): void;
  onclose(handler: () => void): void;
  close(): void;
}

export type ConnectionState = 'connecting' | 'connected' | 'failed';

export interface ViewerConnectionOptions {
  /**
   * Drop IPv6 ICE candidates on both sides — mirrors PeerConnectionTransport's
   * ipv4Only (src/infrastructure/peer-connection.ts). The host CLI's
   * --ipv4-only flag only filters the HOST's own candidates; without a
   * matching filter here, the viewer's browser-gathered IPv6 candidates (and
   * IPv6 candidates the host still forwards) can still be raced, undermining
   * the mitigation. Enabled via the `?ipv4=1` query param the CLI appends to
   * the viewer URL when --ipv4-only is set (see bootstrap.ts).
   */
  readonly ipv4Only?: boolean;
}

/**
 * True when the candidate's connection address (5th field) is an IPv6
 * literal. Duplicated from src/infrastructure/peer-connection.ts's
 * isIpv6Candidate: the viewer bundle cannot import Node-only host code.
 */
export function isIpv6Candidate(candidate: string): boolean {
  const fields = candidate.trim().split(/\s+/);
  const addr = fields[4];
  return addr !== undefined && addr.includes(':');
}

export class ViewerConnection {
  private remoteDescriptionApplied = false;
  private pendingCandidates: IceCandidate[] = [];
  private connectionState: ConnectionState = 'connecting';
  private stateHandlers: Array<(state: ConnectionState) => void> = [];
  private muxHandlers: Array<(mux: StreamMultiplexer) => void> = [];
  private closeHandlers: Array<(openStreamIds: number[]) => void> = [];
  private readonly ipv4Only: boolean;

  // C2: viewer-side open stream tracking (StreamMultiplexer.streams is private)
  private trackedStreamIds: Set<number> = new Set();
  private mux: StreamMultiplexer | null = null;
  private transport: PeerTransport | null = null;

  constructor(
    private peer: BrowserPeer,
    private socket: SignalingSocket,
    options: ViewerConnectionOptions = {},
  ) {
    this.ipv4Only = options.ipv4Only ?? false;
    this.setupPeerHandlers();
    this.setupSocketHandlers();
  }

  private setupPeerHandlers(): void {
    this.peer.onicecandidate((candidate) => {
      this.handleLocalCandidate(candidate);
    });
    this.peer.onconnectionstatechange((state) => {
      this.handleConnectionStateChange(state);
    });
    this.peer.ondatachannel((channel) => {
      this.handleDataChannel(channel as RTCDataChannel);
    });
  }

  private setupSocketHandlers(): void {
    this.socket.onmessage((text) => {
      this.handleSignalingMessage(text);
    });
    // Only close the peer if the DataChannel has not been established yet.
    // Once the DataChannel is open the signaling WS is no longer needed —
    // a WS idle-timeout or network blip should not terminate an active relay.
    this.socket.onclose(() => {
      if (this.mux === null) {
        this.peer.close();
      }
    });
  }

  private handleDataChannel(channel: RTCDataChannel): void {
// console.log('[VIEWER] ondatachannel fired');
    const transport: PeerTransport = new BrowserDataChannelAdapter(channel);
    this.transport = transport;
    const mux = createViewerMultiplexer(transport);
    this.mux = mux;

    // N3: on transport close, emit open stream IDs so bootstrap can send relay-errors
    transport.onClose(() => {
// console.log('[VIEWER] transport closed — firing close handlers');
      const openIds = [...this.trackedStreamIds];
      for (const handler of this.closeHandlers) {
        handler(openIds);
      }
      this.trackedStreamIds.clear();
    });

// console.log('[VIEWER] mux ready — firing mux handlers');
    for (const handler of this.muxHandlers) {
      handler(mux);
    }
  }

  private async handleSignalingMessage(text: string): Promise<void> {
// console.log(`[VIEWER] signaling message received len=${text.length}`);
    const msg = parseMessage(text);
    if (!msg) {
// console.log('[VIEWER] signaling message DROPPED (parse failed)');
      return;
    }
// console.log(`[VIEWER] signaling kind=${msg.kind}`);
    if (msg.kind === 'offer') {
      await this.handleOffer(msg.payload as string);
    } else if (msg.kind === 'ice-candidate') {
      await this.handleRemoteCandidate(msg.payload as IceCandidate);
    }
  }

  private async handleOffer(sdp: string): Promise<void> {
// console.log(`[VIEWER] handleOffer: applyRemoteDescription sdp.length=${sdp.length}`);
    await this.peer.applyRemoteDescription(sdp);
    this.remoteDescriptionApplied = true;
// console.log('[VIEWER] handleOffer: createAnswer');
    const answer = await this.peer.createAnswer();
// console.log(`[VIEWER] handleOffer: setLocalDescription answer.length=${answer.length}`);
    await this.peer.setLocalDescription(answer);
// console.log('[VIEWER] handleOffer: sending answer via signaling');
    await this.socket.send(serializeMessage('answer', answer));
// console.log('[VIEWER] handleOffer: flushing pending candidates');
    await this.flushPendingCandidates();
// console.log('[VIEWER] handleOffer: complete');
  }

  private async handleRemoteCandidate(candidate: IceCandidate): Promise<void> {
    if (this.ipv4Only && isIpv6Candidate(candidate.candidate)) {
// console.log('[VIEWER] handleRemoteCandidate SKIPPED (ipv4-only)');
      return;
    }
// console.log(`[VIEWER] handleRemoteCandidate buffered=${!this.remoteDescriptionApplied}`);
    if (!this.remoteDescriptionApplied) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peer.addIceCandidate(candidate);
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      await this.peer.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];
  }

  private handleLocalCandidate(candidate: IceCandidate): void {
    if (this.ipv4Only && isIpv6Candidate(candidate.candidate)) {
// console.log('[VIEWER] handleLocalCandidate SKIPPED (ipv4-only)');
      return;
    }
// console.log('[VIEWER] sending local ICE candidate');
    this.socket.send(serializeMessage('ice-candidate', candidate));
  }

  private handleConnectionStateChange(state: string): void {
// console.log(`[VIEWER] connectionstatechange: ${state}`);
    if (state === 'connected') {
      this.connectionState = 'connected';
      for (const handler of this.stateHandlers) handler('connected');
    } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      this.connectionState = 'failed';
      for (const handler of this.stateHandlers) handler('failed');
    }
  }

  /** C2: register a relay stream as open (called by bootstrap when relaying a request). */
  trackStream(streamId: number): void {
    this.trackedStreamIds.add(streamId);
  }

  /** C2: deregister a relay stream (called by bootstrap when response completes). */
  untrackStream(streamId: number): void {
    this.trackedStreamIds.delete(streamId);
  }

  /** C2: return open relay stream IDs. Used by bootstrap to emit relay-errors on disconnect. */
  openStreamIds(): number[] {
    return [...this.trackedStreamIds];
  }

  /**
   * Send a request frame directly over the DataChannel transport, bypassing
   * the mux's stream registry. The mux is only used for INBOUND response
   * frames (which auto-open via acceptInbound). Outbound request frames use
   * SW-assigned stream IDs that the mux has no record of, so writeFrame would
   * return StreamRejected. Direct send avoids that.
   */
  sendFrame(frame: Frame): void {
    this.transport?.send(frame);
  }

  onconnectionstate(handler: (state: ConnectionState) => void): Unsubscribe {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  /** B1: fires when the data channel is open and the mux is ready. */
  onmux(handler: (mux: StreamMultiplexer) => void): Unsubscribe {
    this.muxHandlers.push(handler);
    return () => {
      const idx = this.muxHandlers.indexOf(handler);
      if (idx >= 0) this.muxHandlers.splice(idx, 1);
    };
  }

  /** N3: fires with open streamIds on transport close, so bootstrap can emit relay-errors. */
  onclose(handler: (openStreamIds: number[]) => void): Unsubscribe {
    this.closeHandlers.push(handler);
    return () => {
      const idx = this.closeHandlers.indexOf(handler);
      if (idx >= 0) this.closeHandlers.splice(idx, 1);
    };
  }

  close(): void {
    this.socket.close();
    this.peer.close();
  }
}
