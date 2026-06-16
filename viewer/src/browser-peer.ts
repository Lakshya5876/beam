/**
 * Impure boundary: wraps real RTCPeerConnection into the BrowserPeer port.
 * NOT unit-tested here (live at S18); excluded from coverage gate.
 */

import type { BrowserPeer, IceCandidate } from './viewer-connection.js';

export class BrowserPeerAdapter implements BrowserPeer {
  constructor(private pc: RTCPeerConnection) {}

  async applyRemoteDescription(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
  }

  async createAnswer(): Promise<string> {
    const answer = await this.pc.createAnswer();
    return answer.sdp || '';
  }

  async setLocalDescription(sdp: string): Promise<void> {
    await this.pc.setLocalDescription({ type: 'answer', sdp });
  }

  async addIceCandidate(candidate: IceCandidate): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.mid,
    });
  }

  onicecandidate(handler: (candidate: IceCandidate) => void): void {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        handler({
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid,
        });
      }
    };
  }

  onconnectionstatechange(handler: () => void): void {
    this.pc.onconnectionstatechange = () => {
      handler();
    };
  }

  ondatachannel(handler: (channel: unknown) => void): void {
    this.pc.ondatachannel = (event) => {
      handler(event.channel);
    };
  }

  close(): void {
    this.pc.close();
  }
}
