/**
 * Viewer-side answerer orchestration: receive offer, answer, buffer candidates,
 * manage connection state. Injected ports (BrowserPeer, SignalingSocket) —
 * pure logic, testable with fakes; browser runtime at S18.
 */

import type { Unsubscribe } from '../../src/domain/interfaces.js';
import { parseMessage, serializeMessage, type IceCandidate } from './signaling-messages.js';

export interface BrowserPeer {
  applyRemoteDescription(sdp: string): Promise<void>;
  createAnswer(): Promise<string>;
  setLocalDescription(sdp: string): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
  onicecandidate(handler: (candidate: IceCandidate) => void): void;
  onconnectionstatechange(handler: () => void): void;
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

export class ViewerConnection {
  private remoteDescriptionApplied = false;
  private pendingCandidates: IceCandidate[] = [];
  private connectionState: ConnectionState = 'connecting';
  private stateHandlers: Array<(state: ConnectionState) => void> = [];

  constructor(
    private peer: BrowserPeer,
    private socket: SignalingSocket,
  ) {
    this.setupPeerHandlers();
    this.setupSocketHandlers();
  }

  private setupPeerHandlers(): void {
    this.peer.onicecandidate((candidate) => {
      this.handleLocalCandidate(candidate);
    });
    this.peer.onconnectionstatechange(() => {
      this.handleConnectionStateChange();
    });
    this.peer.ondatachannel(() => {
      // S16: data channel handling
    });
  }

  private setupSocketHandlers(): void {
    this.socket.onmessage((text) => {
      this.handleSignalingMessage(text);
    });
    this.socket.onclose(() => {
      this.peer.close();
    });
  }

  private async handleSignalingMessage(text: string): Promise<void> {
    const msg = parseMessage(text);
    if (!msg) return; // Malformed, dropped

    if (msg.kind === 'offer') {
      await this.handleOffer(msg.payload as string);
    } else if (msg.kind === 'ice-candidate') {
      await this.handleRemoteCandidate(msg.payload as IceCandidate);
    }
  }

  private async handleOffer(sdp: string): Promise<void> {
    await this.peer.applyRemoteDescription(sdp);
    this.remoteDescriptionApplied = true;
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    await this.socket.send(serializeMessage('answer', answer));
    await this.flushPendingCandidates();
  }

  private async handleRemoteCandidate(candidate: IceCandidate): Promise<void> {
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
    this.socket.send(serializeMessage('ice-candidate', candidate));
  }

  private handleConnectionStateChange(): void {
    // Inspect peer.connectionState (mapped to our ConnectionState)
    // Update this.connectionState
    // Emit via stateHandlers
  }

  onconnectionstate(handler: (state: ConnectionState) => void): Unsubscribe {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  close(): void {
    this.socket.close();
    this.peer.close();
  }
}
