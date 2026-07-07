import { describe, it, expect, beforeEach } from 'vitest';
import { isIpv6Candidate, ViewerConnection, type BrowserPeer, type SignalingSocket, type IceCandidate } from '../src/viewer-connection.js';
import { serializeMessage } from '../src/signaling-messages.js';

class FakeBrowserPeer implements BrowserPeer {
  public applyRemoteDescriptionCalls: string[] = [];
  public createAnswerCalls = 0;
  public setLocalDescriptionCalls: string[] = [];
  public addIceCandidateCalls: IceCandidate[] = [];
  public closeCalls = 0;

  private icecandidateHandlers: Array<(candidate: IceCandidate) => void> = [];
  private connectionStateChangeHandlers: Array<(state: string) => void> = [];

  async applyRemoteDescription(sdp: string): Promise<void> {
    this.applyRemoteDescriptionCalls.push(sdp);
  }

  async createAnswer(): Promise<string> {
    this.createAnswerCalls++;
    return 'answer-sdp';
  }

  async setLocalDescription(sdp: string): Promise<void> {
    this.setLocalDescriptionCalls.push(sdp);
  }

  async addIceCandidate(candidate: IceCandidate): Promise<void> {
    this.addIceCandidateCalls.push(candidate);
  }

  onicecandidate(handler: (candidate: IceCandidate) => void): void {
    this.icecandidateHandlers.push(handler);
  }

  onconnectionstatechange(handler: (state: string) => void): void {
    this.connectionStateChangeHandlers.push(handler);
  }

  ondatachannel(): void {
    // no-op for test
  }

  close(): void {
    this.closeCalls++;
  }

  // Test helpers
  sendIceCandidate(candidate: IceCandidate): void {
    for (const handler of this.icecandidateHandlers) {
      handler(candidate);
    }
  }

  triggerConnectionStateChange(state: string): void {
    for (const handler of this.connectionStateChangeHandlers) {
      handler(state);
    }
  }
}

class FakeSignalingSocket implements SignalingSocket {
  public sentMessages: string[] = [];
  public closeCalls = 0;

  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  async send(text: string): Promise<void> {
    this.sentMessages.push(text);
  }

  onmessage(handler: (text: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onclose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.closeCalls++;
  }

  // Test helpers
  receiveMessage(text: string): void {
    for (const handler of this.messageHandlers) {
      handler(text);
    }
  }

  triggerClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

describe('ViewerConnection (orchestration + candidate buffering)', () => {
  let peer: FakeBrowserPeer;
  let socket: FakeSignalingSocket;
  let conn: ViewerConnection;

  beforeEach(() => {
    peer = new FakeBrowserPeer();
    socket = new FakeSignalingSocket();
    conn = new ViewerConnection(peer, socket);
  });

  it('inbound offer triggers applyRemoteDescription → createAnswer → answer sent', async () => {
    const offerSdp = 'offer-sdp';
    socket.receiveMessage(serializeMessage('offer', offerSdp));

    // Yield to allow async handlers to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(peer.applyRemoteDescriptionCalls).toContain(offerSdp);
    expect(peer.createAnswerCalls).toBe(1);
    expect(socket.sentMessages).toContainEqual(serializeMessage('answer', 'answer-sdp'));
  });

  it('CANDIDATE BUFFERING: remote candidate before description is buffered, not passed to peer', async () => {
    const candidate: IceCandidate = { candidate: 'candidate:...', mid: '0' };

    // Send candidate BEFORE offer (remote description not applied)
    socket.receiveMessage(serializeMessage('ice-candidate', candidate));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // CRITICAL: addIceCandidate must NOT have been called
    expect(peer.addIceCandidateCalls).toHaveLength(0);

    // Now send offer to apply remote description
    socket.receiveMessage(serializeMessage('offer', 'offer-sdp'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // AFTER description is applied, the buffered candidate is flushed
    expect(peer.addIceCandidateCalls).toContainEqual(candidate);
  });

  it('candidates are flushed in order after description applies', async () => {
    const cand1: IceCandidate = { candidate: 'candidate:1' };
    const cand2: IceCandidate = { candidate: 'candidate:2' };

    // Buffer two candidates
    socket.receiveMessage(serializeMessage('ice-candidate', cand1));
    socket.receiveMessage(serializeMessage('ice-candidate', cand2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peer.addIceCandidateCalls).toHaveLength(0);

    // Apply description
    socket.receiveMessage(serializeMessage('offer', 'offer-sdp'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Both candidates flushed in order
    expect(peer.addIceCandidateCalls).toEqual([cand1, cand2]);
  });

  it('local candidate is sent via socket', () => {
    const candidate: IceCandidate = { candidate: 'local-candidate', mid: '0' };
    peer.sendIceCandidate(candidate);

    expect(socket.sentMessages).toContainEqual(serializeMessage('ice-candidate', candidate));
  });

  it('socket close triggers peer close', () => {
    socket.triggerClose();
    expect(peer.closeCalls).toBe(1);
  });

  it('connection state transitions are emitted', () => {
    const states: Array<'connecting' | 'connected' | 'failed'> = [];
    conn.onconnectionstate((state) => states.push(state));

    peer.triggerConnectionStateChange('connected');
    expect(states).toEqual(['connected']);

    peer.triggerConnectionStateChange('failed');
    expect(states).toEqual(['connected', 'failed']);

    peer.triggerConnectionStateChange('disconnected');
    expect(states).toEqual(['connected', 'failed', 'failed']);
  });
});

describe('ViewerConnection — ipv4Only candidate filtering', () => {
  it('drops outbound IPv6 local candidates when ipv4Only is set', () => {
    const peer = new FakeBrowserPeer();
    const socket = new FakeSignalingSocket();
    new ViewerConnection(peer, socket, { ipv4Only: true });

    peer.sendIceCandidate({ candidate: 'candidate:1 1 UDP 211 2401:4900::1 599 typ host', mid: '0' });
    peer.sendIceCandidate({ candidate: 'candidate:2 1 UDP 211 192.168.1.5 599 typ host', mid: '0' });

    expect(socket.sentMessages).toHaveLength(1);
    expect(socket.sentMessages[0]).toContain('192.168.1.5');
  });

  it('drops inbound IPv6 remote candidates when ipv4Only is set (post-offer, unbuffered path)', async () => {
    const peer = new FakeBrowserPeer();
    const socket = new FakeSignalingSocket();
    new ViewerConnection(peer, socket, { ipv4Only: true });

    socket.receiveMessage(serializeMessage('offer', 'offer-sdp'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    socket.receiveMessage(serializeMessage('ice-candidate', { candidate: 'candidate:1 1 UDP 211 2401:4900::1 599 typ host', mid: '0' }));
    socket.receiveMessage(serializeMessage('ice-candidate', { candidate: 'candidate:2 1 UDP 211 192.168.1.5 599 typ host', mid: '0' }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(peer.addIceCandidateCalls).toHaveLength(1);
    expect(peer.addIceCandidateCalls[0]?.candidate).toContain('192.168.1.5');
  });

  it('without ipv4Only, IPv6 candidates pass through as before', () => {
    const peer = new FakeBrowserPeer();
    const socket = new FakeSignalingSocket();
    new ViewerConnection(peer, socket);

    peer.sendIceCandidate({ candidate: 'candidate:1 1 UDP 211 2401:4900::1 599 typ host', mid: '0' });

    expect(socket.sentMessages).toHaveLength(1);
  });
});

describe('isIpv6Candidate', () => {
  it('classifies candidate address family from the 5th field', () => {
    expect(isIpv6Candidate('candidate:1 1 UDP 211 192.168.1.5 599 typ host')).toBe(false);
    expect(isIpv6Candidate('candidate:2 1 UDP 211 2401:4900::1 599 typ host')).toBe(true);
  });
});
