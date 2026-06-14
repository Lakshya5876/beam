import nodeDataChannel from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createFramePayload,
  createStreamId,
  decodeFrame,
  encodeFrame,
  FrameType,
  isFrameDecodeError,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
  type Frame,
} from '../../src/domain/frame.js';
import {
  classifyConnectionFailure,
  isPeerSignalingError,
  PeerConnectionTransport,
  type NativeDataChannel,
  type NativePeerConnection,
} from '../../src/infrastructure/peer-connection.js';

function frame(streamId: number, bytes = new Uint8Array([1, 2, 3])): Frame {
  const id = createStreamId(streamId);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  const payload = createFramePayload(bytes);
  if (isPayloadTooLargeError(payload)) {
    throw new Error('test setup: payload');
  }
  return { type: FrameType.REQUEST_BODY_CHUNK, streamId: id, payload };
}

// ---- Fakes at the native port (the lowest seam, N3) -----------------------

class FakeDataChannel implements NativeDataChannel {
  public readonly sent: Uint8Array[] = [];
  public buffered = 0;
  public throwOnSend = false;
  private open = false;
  private openCbs: Array<() => void> = [];
  private closedCbs: Array<() => void> = [];
  private errorCbs: Array<(err: string) => void> = [];
  private messageCbs: Array<(msg: string | Buffer | ArrayBuffer) => void> = [];

  sendMessageBinary(buffer: Uint8Array): boolean {
    if (this.throwOnSend) {
      throw new Error('native send failed');
    }
    this.sent.push(buffer);
    return true;
  }
  isOpen(): boolean {
    return this.open;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(): void {
    this.open = false;
    for (const cb of this.closedCbs) {
      cb();
    }
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onClosed(cb: () => void): void {
    this.closedCbs.push(cb);
  }
  onError(cb: (err: string) => void): void {
    this.errorCbs.push(cb);
  }
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.messageCbs.push(cb);
  }
  // Test drivers:
  triggerOpen(): void {
    this.open = true;
    for (const cb of this.openCbs) {
      cb();
    }
  }
  emit(bytes: Uint8Array): void {
    for (const cb of this.messageCbs) {
      cb(Buffer.from(bytes));
    }
  }
  triggerError(reason: string): void {
    for (const cb of this.errorCbs) {
      cb(reason);
    }
  }
}

class FakePeerConnection implements NativePeerConnection {
  public readonly channel = new FakeDataChannel();
  public readonly addedCandidates: Array<{ candidate: string; mid: string }> = [];
  public remoteDescriptions: Array<{ sdp: string; type: string }> = [];
  public throwOnSetRemote = false;
  public throwOnAddCandidate = false;
  private stateCbs: Array<(state: string) => void> = [];
  private dataChannelCbs: Array<(channel: NativeDataChannel) => void> = [];

  createDataChannel(): NativeDataChannel {
    return this.channel;
  }
  setRemoteDescription(sdp: string, type: string): void {
    if (this.throwOnSetRemote) {
      throw new Error('native setRemoteDescription failed');
    }
    this.remoteDescriptions.push({ sdp, type });
  }
  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.throwOnAddCandidate) {
      throw new Error('native addRemoteCandidate failed');
    }
    this.addedCandidates.push({ candidate, mid });
  }
  state(): string {
    return 'new';
  }
  onLocalDescription(): void {
    /* not exercised by the deterministic suite */
  }
  onLocalCandidate(): void {
    /* not exercised by the deterministic suite */
  }
  onStateChange(cb: (state: string) => void): void {
    this.stateCbs.push(cb);
  }
  onDataChannel(cb: (channel: NativeDataChannel) => void): void {
    this.dataChannelCbs.push(cb);
  }
  close(): void {
    /* no-op */
  }
  triggerState(state: string): void {
    for (const cb of this.stateCbs) {
      cb(state);
    }
  }
}

function offerTransport(fake: FakePeerConnection, connectTimeoutMs = 10_000): PeerConnectionTransport {
  return new PeerConnectionTransport({ role: 'offer', connectTimeoutMs, factory: () => fake });
}

// ---- Deterministic logic over fakes ---------------------------------------

describe('PeerConnectionTransport — PeerTransport conformance (fake channel)', () => {
  it('send before the channel opens returns TransportClosedError', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    const result = transport.send(frame(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'TransportClosed' });
    }
  });

  it('send after close returns TransportClosedError', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    fake.channel.triggerOpen();
    expect(transport.send(frame(1)).ok).toBe(true);
    transport.close();
    const result = transport.send(frame(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ error: 'TransportClosed' });
    }
  });

  it('encodes a Frame and writes it to the channel; it decodes back equal', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    fake.channel.triggerOpen();
    const f = frame(7, new Uint8Array([9, 8, 7, 6]));
    expect(transport.send(f).ok).toBe(true);
    expect(fake.channel.sent).toHaveLength(1);
    const decoded = decodeFrame(fake.channel.sent[0] as Uint8Array);
    expect(isFrameDecodeError(decoded)).toBe(false);
    expect(decoded).toEqual(f);
  });

  it('delivers an inbound Frame and drops undecodable bytes', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    const received: Frame[] = [];
    transport.onFrame((f) => received.push(f));
    transport.start();
    fake.channel.triggerOpen();
    const f = frame(3);
    fake.channel.emit(encodeFrame(f));
    fake.channel.emit(new Uint8Array([0xff, 0x00, 0x01])); // garbage -> dropped
    expect(received).toEqual([f]);
  });

  it('bufferedAmount passes through the open channel and is 0 otherwise', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    expect(transport.bufferedAmount()).toBe(0);
    fake.channel.triggerOpen();
    fake.channel.buffered = 4096;
    expect(transport.bufferedAmount()).toBe(4096);
  });

  it('onClose fires once with a reason when the channel closes', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    const reasons: string[] = [];
    transport.onClose((r) => reasons.push(r));
    transport.start();
    fake.channel.triggerOpen();
    fake.channel.close();
    expect(reasons).toEqual(['data channel closed']);
  });

  it('onFrame unsubscribe stops delivery', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    const received: Frame[] = [];
    const unsubscribe = transport.onFrame((f) => received.push(f));
    transport.start();
    fake.channel.triggerOpen();
    unsubscribe();
    fake.channel.emit(encodeFrame(frame(1)));
    expect(received).toEqual([]);
  });

  it('send surfaces a native send throw as TransportClosedError', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    fake.channel.triggerOpen();
    fake.channel.throwOnSend = true;
    const result = transport.send(frame(1));
    expect(result.ok).toBe(false);
  });
});

describe('PeerConnectionTransport — candidate buffering and native guards', () => {
  it('buffers a remote candidate before the remote description, then flushes in order', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    // Two candidates arrive before any remote description.
    expect(transport.addRemoteCandidate('cand-A', '0').ok).toBe(true);
    expect(transport.addRemoteCandidate('cand-B', '0').ok).toBe(true);
    // Native addRemoteCandidate must NOT have been called yet (would abort).
    expect(fake.addedCandidates).toEqual([]);
    // Apply the remote description -> buffered candidates flush in order.
    expect(transport.applyRemoteDescription('sdp', 'offer').ok).toBe(true);
    expect(fake.addedCandidates).toEqual([
      { candidate: 'cand-A', mid: '0' },
      { candidate: 'cand-B', mid: '0' },
    ]);
  });

  it('passes a post-description candidate straight through', () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    transport.applyRemoteDescription('sdp', 'offer');
    expect(transport.addRemoteCandidate('cand-C', '0').ok).toBe(true);
    expect(fake.addedCandidates).toEqual([{ candidate: 'cand-C', mid: '0' }]);
  });

  it('a throwing native setRemoteDescription becomes a typed PeerSignalingError', () => {
    const fake = new FakePeerConnection();
    fake.throwOnSetRemote = true;
    const transport = offerTransport(fake);
    transport.start();
    const result = transport.applyRemoteDescription('garbage', 'offer');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isPeerSignalingError(result.error)).toBe(true);
    }
  });

  it('a throwing native addRemoteCandidate (post-description) becomes a typed PeerSignalingError', () => {
    const fake = new FakePeerConnection();
    fake.throwOnAddCandidate = true;
    const transport = offerTransport(fake);
    transport.start();
    transport.applyRemoteDescription('sdp', 'offer');
    const result = transport.addRemoteCandidate('cand', '0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('add-remote-candidate-failed');
    }
  });
});

describe('PeerConnectionTransport — honest-failure path', () => {
  it('awaitConnected resolves ok when the channel opens', async () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    fake.channel.triggerOpen();
    expect((await transport.awaitConnected()).ok).toBe(true);
  });

  it('awaitConnected resolves no-viable-candidate on state failed', async () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake);
    transport.start();
    fake.triggerState('failed');
    const result = await transport.awaitConnected();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('no-viable-candidate');
    }
  });

  it('awaitConnected resolves connect-timeout via the bounded timer', async () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake, 30);
    transport.start();
    const result = await transport.awaitConnected();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('connect-timeout');
    }
  });

  it('classifyConnectionFailure maps states to typed reasons', () => {
    expect(classifyConnectionFailure('failed')).toBe('no-viable-candidate');
    expect(classifyConnectionFailure('disconnected')).toBe('closed-before-open');
    expect(classifyConnectionFailure('closed')).toBe('closed-before-open');
    expect(classifyConnectionFailure('connecting')).toBeNull();
    expect(classifyConnectionFailure('connected')).toBeNull();
  });
});

// ---- Real node-datachannel, no completed-ICE required ----------------------

describe('PeerConnectionTransport — real node-datachannel (no ICE pairing)', () => {
  const transports: PeerConnectionTransport[] = [];
  function realOffer(): PeerConnectionTransport {
    const t = new PeerConnectionTransport({ role: 'offer', iceServers: [] });
    transports.push(t);
    return t;
  }

  afterEach(() => {
    for (const t of transports) {
      t.close();
    }
    transports.length = 0;
  });

  afterAll(() => {
    nodeDataChannel.cleanup();
  });

  it('a real offerer emits an opaque SDP offer via onLocalDescription', async () => {
    const transport = realOffer();
    const offer = await new Promise<{ sdp: string; type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no local description')), 3000);
      transport.onLocalDescription((sdp, type) => {
        clearTimeout(timer);
        resolve({ sdp, type });
      });
      transport.start();
    });
    expect(offer.type).toBe('offer');
    expect(typeof offer.sdp).toBe('string');
    expect(offer.sdp.length).toBeGreaterThan(0);
  });

  it('applyRemoteDescription with garbage returns a typed PeerSignalingError (no abort)', () => {
    const transport = realOffer();
    transport.start();
    const result = transport.applyRemoteDescription('this is not sdp', 'offer');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isPeerSignalingError(result.error)).toBe(true);
    }
  });
});
