import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createFetchGate,
  enqueue,
  nextStreamId,
  onMuxGone,
  onMuxReady,
  trackStreamClose,
  trackStreamOpen,
  MAX_CONCURRENT_STREAMS,
  RELAY_TIMEOUT_MS,
  type FetchGate,
} from '../src/sw-fetch-gate.js';

// Fake WindowClient-like source
const FAKE_SOURCE = { id: 'client-abc', postMessage: () => undefined };

describe('sw-fetch-gate', () => {
  let gate: FetchGate;

  beforeEach(() => {
    vi.useFakeTimers();
    gate = createFetchGate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('createFetchGate initializes with ready=false', () => {
    expect(gate.ready).toBe(false);
    expect(gate.sessionCode).toBeNull();
    expect(gate.openStreams.size).toBe(0);
    expect(gate.pending).toHaveLength(0);
  });

  it('nextStreamId returns monotonically increasing ids', () => {
    expect(nextStreamId(gate)).toBe(1);
    expect(nextStreamId(gate)).toBe(2);
    expect(nextStreamId(gate)).toBe(3);
  });

  it('enqueue while not ready → queued, resolve deferred', async () => {
    const streamId = nextStreamId(gate);
    const promise = enqueue(streamId, RELAY_TIMEOUT_MS, gate);
    expect(gate.pending).toHaveLength(1);

    // onMuxReady flushes
    const unflushed = onMuxReady(FAKE_SOURCE, 'testcode', gate as FetchGate & { source: typeof FAKE_SOURCE | null });
    expect(unflushed).toHaveLength(1);
    unflushed[0]?.resolve({ ok: true });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it('enqueue after ready resolves immediately with ok:true', async () => {
    onMuxReady(FAKE_SOURCE, 'testcode', gate as FetchGate & { source: typeof FAKE_SOURCE | null });
    const streamId = nextStreamId(gate);
    const result = await enqueue(streamId, RELAY_TIMEOUT_MS, gate);
    expect(result.ok).toBe(true);
    expect(gate.openStreams.has(streamId)).toBe(true);
  });

  it('B3: timeout fires → ok:false with a real 504 Response (never rejects)', async () => {
    const streamId = nextStreamId(gate);
    const promise = enqueue(streamId, 5000, gate);

    // Advance time past timeout
    vi.advanceTimersByTime(5001);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response).toBeInstanceOf(Response);
      expect(result.response.status).toBe(504);
    }
  });

  it('N6: enqueue at MAX_CONCURRENT_STREAMS cap → ok:false 504 stream-cap-exceeded', async () => {
    onMuxReady(FAKE_SOURCE, 'testcode', gate as FetchGate & { source: typeof FAKE_SOURCE | null });

    // Fill up to cap
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
      const id = nextStreamId(gate);
      trackStreamOpen(id, gate);
    }
    expect(gate.openStreams.size).toBe(MAX_CONCURRENT_STREAMS);

    // One more should be rejected immediately
    const overCapId = nextStreamId(gate);
    const result = await enqueue(overCapId, RELAY_TIMEOUT_MS, gate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(504);
    }
  });

  it('N8: onMuxGone during partial flush → remaining pending resolved ok:false', async () => {
    const streamId1 = nextStreamId(gate);
    const streamId2 = nextStreamId(gate);
    const p1 = enqueue(streamId1, RELAY_TIMEOUT_MS, gate);
    const p2 = enqueue(streamId2, RELAY_TIMEOUT_MS, gate);
    expect(gate.pending).toHaveLength(2);

    // onMuxReady returns all items (still in gate.pending as flushing=true)
    const toFlush = onMuxReady(FAKE_SOURCE, 'testcode', gate as FetchGate & { source: typeof FAKE_SOURCE | null });
    expect(toFlush).toHaveLength(2);

    // Flush only the first — manually resolve and remove from gate.pending
    const first = toFlush[0]!;
    first.resolve({ ok: true });
    gate.pending.splice(gate.pending.indexOf(first), 1);

    // mux goes away before second is flushed — gate.pending still has the second
    expect(gate.pending).toHaveLength(1);
    const { pending: remaining } = onMuxGone(gate);
    expect(remaining).toHaveLength(1);
    remaining[0]?.resolve({ ok: false, response: new Response('', { status: 504 }) });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
  });

  it('onMuxGone after fully-ready (no pending) returns open stream ids', () => {
    onMuxReady(FAKE_SOURCE, 'testcode', gate as FetchGate & { source: typeof FAKE_SOURCE | null });
    trackStreamOpen(5, gate);
    trackStreamOpen(7, gate);
    const { pending, openStreamIds } = onMuxGone(gate);
    expect(pending).toHaveLength(0);
    expect(openStreamIds).toContain(5);
    expect(openStreamIds).toContain(7);
    expect(gate.ready).toBe(false);
    expect(gate.openStreams.size).toBe(0);
  });

  it('trackStreamOpen/Close maintains the openStreams set', () => {
    trackStreamOpen(10, gate);
    trackStreamOpen(11, gate);
    expect(gate.openStreams.has(10)).toBe(true);
    trackStreamClose(10, gate);
    expect(gate.openStreams.has(10)).toBe(false);
    expect(gate.openStreams.has(11)).toBe(true);
  });
});
