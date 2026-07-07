import nodeDataChannel from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
  candidateTypeOf,
  classifyConnectionFailure,
  extractMdnsHost,
  formatSelectedPair,
  isIpv6Candidate,
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
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.localCandidateCbs.push(cb);
  }
  private localCandidateCbs: Array<(candidate: string, mid: string) => void> = [];
  emitLocalCandidate(candidate: string, mid: string): void {
    for (const cb of this.localCandidateCbs) {
      cb(candidate, mid);
    }
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

  it('close() before connect cancels the timer and resolves awaitConnected immediately', async () => {
    const fake = new FakePeerConnection();
    const transport = offerTransport(fake, 60_000); // very long timeout — would hang without explicit cancel
    transport.start();

    // close() before channel opens
    transport.close();

    const result = await transport.awaitConnected();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('closed-before-open');
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

// ---- mDNS candidate resolution (Chrome hides local IPs with UUID.local) ----

const MDNS_CANDIDATE = 'candidate:12345678 1 udp 2113937151 ecc498da-5eba-41f1-870c-e7d9d7285d94.local 52256 typ host generation 0';
const PLAIN_CANDIDATE = 'candidate:12345678 1 udp 2113937151 192.168.1.5 52256 typ host generation 0';

describe('extractMdnsHost', () => {
  it('extracts UUID.local hostname from a Chrome mDNS candidate', () => {
    expect(extractMdnsHost(MDNS_CANDIDATE)).toBe('ecc498da-5eba-41f1-870c-e7d9d7285d94.local');
  });

  it('returns null for a plain-IP candidate', () => {
    expect(extractMdnsHost(PLAIN_CANDIDATE)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractMdnsHost('')).toBeNull();
  });
});

describe('PeerConnectionTransport mDNS resolution', () => {
  it('mDNS candidate: resolves hostname before calling native addRemoteCandidate', async () => {
    const fake = new FakePeerConnection();
    const resolveMdns = vi.fn().mockResolvedValue('192.168.1.5');
    const transport = new PeerConnectionTransport({ role: 'answer', factory: () => fake, resolveMdns });

    transport.applyRemoteDescription('v=0\r\n', 'offer');
    transport.addRemoteCandidate(MDNS_CANDIDATE, '0');

    await Promise.resolve(); // flush microtask queue for the async resolution

    expect(resolveMdns).toHaveBeenCalledWith('ecc498da-5eba-41f1-870c-e7d9d7285d94.local');
    expect(fake.addedCandidates).toHaveLength(1);
    expect(fake.addedCandidates[0]?.candidate).toContain('192.168.1.5');
    expect(fake.addedCandidates[0]?.candidate).not.toContain('.local');
  });

  it('regular candidate bypasses the mDNS resolver and is passed immediately', () => {
    const fake = new FakePeerConnection();
    const resolveMdns = vi.fn();
    const transport = new PeerConnectionTransport({ role: 'answer', factory: () => fake, resolveMdns });

    transport.applyRemoteDescription('v=0\r\n', 'offer');
    transport.addRemoteCandidate(PLAIN_CANDIDATE, '0');

    expect(resolveMdns).not.toHaveBeenCalled();
    expect(fake.addedCandidates).toHaveLength(1);
    expect(fake.addedCandidates[0]?.candidate).toBe(PLAIN_CANDIDATE);
  });

  it('mDNS resolution failure skips the candidate without throwing', async () => {
    const fake = new FakePeerConnection();
    const resolveMdns = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const transport = new PeerConnectionTransport({ role: 'answer', factory: () => fake, resolveMdns });

    transport.applyRemoteDescription('v=0\r\n', 'offer');
    transport.addRemoteCandidate(MDNS_CANDIDATE, '0');

    await Promise.resolve();

    expect(fake.addedCandidates).toHaveLength(0); // skipped, not crashed
  });

  it('buffered mDNS candidate is resolved after remote description is applied', async () => {
    const fake = new FakePeerConnection();
    const resolveMdns = vi.fn().mockResolvedValue('10.0.0.42');
    const transport = new PeerConnectionTransport({ role: 'answer', factory: () => fake, resolveMdns });

    // Add candidate BEFORE remote description (triggers buffering path)
    transport.addRemoteCandidate(MDNS_CANDIDATE, '0');
    expect(fake.addedCandidates).toHaveLength(0); // still buffered

    transport.applyRemoteDescription('v=0\r\n', 'offer');
    await Promise.resolve();

    expect(resolveMdns).toHaveBeenCalledWith('ecc498da-5eba-41f1-870c-e7d9d7285d94.local');
    expect(fake.addedCandidates[0]?.candidate).toContain('10.0.0.42');
  });
});

describe('candidateTypeOf / formatSelectedPair — diagnostics', () => {
  it('extracts the ICE candidate type', () => {
    expect(candidateTypeOf('candidate:1 1 UDP 212 192.168.1.5 54400 typ host')).toBe('host');
    expect(candidateTypeOf('candidate:2 1 UDP 168 203.0.113.9 54400 typ srflx raddr 0.0.0.0')).toBe('srflx');
    expect(candidateTypeOf('candidate:4 1 UDP 41 198.51.100.4 3478 typ relay')).toBe('relay');
    expect(candidateTypeOf('garbage')).toBeNull();
  });

  it('formats a direct path when neither side is relayed', () => {
    expect(formatSelectedPair({ local: { type: 'srflx' }, remote: { type: 'host' } }))
      .toBe('path=DIRECT local=srflx remote=host');
  });

  it('formats a TURN path when either side is relayed', () => {
    expect(formatSelectedPair({ local: { type: 'relay' }, remote: { type: 'srflx' } }))
      .toContain('path=RELAY (TURN)');
  });

  it('degrades to ? for missing endpoint info', () => {
    expect(formatSelectedPair({})).toBe('path=DIRECT local=? remote=?');
  });
});

describe('isIpv6Candidate / ipv4-only filtering', () => {
  it('classifies candidate address family from the 5th field', () => {
    expect(isIpv6Candidate('a=candidate:1 1 UDP 2114977791 192.168.1.21 61781 typ host')).toBe(false);
    expect(isIpv6Candidate('a=candidate:2 1 UDP 2116026111 2401:4900:1cb5::a921 61781 typ host')).toBe(true);
    expect(isIpv6Candidate('candidate:3 1 UDP 2116025855 fddd:dddd:1000:0:8755:19e9:31b5:143b 61781 typ host')).toBe(true);
  });

  it('ipv4Only drops remote IPv6 candidates before the native layer', () => {
    const fake = new FakePeerConnection();
    const transport = new PeerConnectionTransport({ role: 'offer', factory: () => fake, ipv4Only: true });
    transport.applyRemoteDescription('v=0', 'answer');
    const v6 = transport.addRemoteCandidate('candidate:2 1 UDP 211 2401:4900::1 599 typ host', '0');
    const v4 = transport.addRemoteCandidate('candidate:1 1 UDP 211 192.168.1.21 599 typ host', '0');
    expect(v6.ok).toBe(true);
    expect(v4.ok).toBe(true);
    expect(fake.addedCandidates).toEqual([{ candidate: 'candidate:1 1 UDP 211 192.168.1.21 599 typ host', mid: '0' }]);
  });

  it('ipv4Only suppresses local IPv6 candidates from signaling handlers', () => {
    const fake = new FakePeerConnection();
    const transport = new PeerConnectionTransport({ role: 'offer', factory: () => fake, ipv4Only: true });
    const seen: string[] = [];
    transport.onLocalCandidate((candidate) => seen.push(candidate));
    fake.emitLocalCandidate('a=candidate:2 1 UDP 211 2401:4900::1 599 typ host', '0');
    fake.emitLocalCandidate('a=candidate:1 1 UDP 211 192.168.1.21 599 typ host', '0');
    expect(seen).toEqual(['a=candidate:1 1 UDP 211 192.168.1.21 599 typ host']);
  });
});
