import { describe, expect, it } from 'vitest';
import { createStreamId, isInvalidStreamIdError, type StreamId } from '../../src/domain/frame.js';
import type { RequestRecord } from '../../src/domain/interfaces.js';
import { InMemoryRequestLogStore, MAX_REQUEST_LOG_RECORDS } from '../../src/infrastructure/request-log-store.js';

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: invalid stream id');
  }
  return id;
}

function record(streamId: number, timestampMs: number, path = '/x'): RequestRecord {
  return {
    timestampMs,
    method: 'GET',
    path,
    status: 200,
    latencyMs: 5,
    responseSizeBytes: 100,
    streamId: sid(streamId),
  };
}

describe('InMemoryRequestLogStore — fetchRecent', () => {
  it('returns persisted records newest-first', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(1, 1000, '/a'));
    await store.persistRecord(record(2, 2000, '/b'));
    await store.persistRecord(record(3, 3000, '/c'));
    const recent = await store.fetchRecent(10);
    expect(recent.map((r) => r.path)).toEqual(['/c', '/b', '/a']);
  });

  it('respects an explicit limit', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(1, 1000, '/a'));
    await store.persistRecord(record(2, 2000, '/b'));
    await store.persistRecord(record(3, 3000, '/c'));
    expect((await store.fetchRecent(2)).map((r) => r.path)).toEqual(['/c', '/b']);
  });

  it('returns all retained when limit exceeds size', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(1, 1000, '/a'));
    expect(await store.fetchRecent(50)).toHaveLength(1);
  });

  it('returns empty for limit 0 and negative limits', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(1, 1000));
    expect(await store.fetchRecent(0)).toEqual([]);
    expect(await store.fetchRecent(-3)).toEqual([]);
  });
});

describe('InMemoryRequestLogStore — bounded ring buffer', () => {
  it('evicts the oldest and never exceeds capacity', async () => {
    const store = new InMemoryRequestLogStore(3);
    for (let i = 1; i <= 5; i += 1) {
      await store.persistRecord(record(i, i * 1000, `/p${String(i)}`));
    }
    const all = await store.fetchRecent(100);
    expect(all).toHaveLength(3);
    // Newest-first; oldest two (/p1, /p2) evicted.
    expect(all.map((r) => r.path)).toEqual(['/p5', '/p4', '/p3']);
  });

  it('findByStreamId no longer returns an evicted record', async () => {
    const store = new InMemoryRequestLogStore(2);
    await store.persistRecord(record(7, 1000, '/old'));
    await store.persistRecord(record(8, 2000, '/mid'));
    await store.persistRecord(record(9, 3000, '/new'));
    expect(await store.findByStreamId(sid(7))).toEqual([]);
    expect((await store.findByStreamId(sid(9))).map((r) => r.path)).toEqual(['/new']);
  });
});

describe('InMemoryRequestLogStore — findByStreamId', () => {
  it('returns matching records in chronological order', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(5, 1000, '/x'));
    await store.persistRecord(record(6, 1500, '/other'));
    await store.persistRecord(record(5, 2000, '/y'));
    expect((await store.findByStreamId(sid(5))).map((r) => r.path)).toEqual(['/x', '/y']);
  });

  it('returns empty for an unknown StreamId', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(5, 1000));
    expect(await store.findByStreamId(sid(99))).toEqual([]);
  });
});

describe('InMemoryRequestLogStore — isolation and construction', () => {
  it('returned arrays do not alias internal state', async () => {
    const store = new InMemoryRequestLogStore();
    await store.persistRecord(record(1, 1000, '/a'));
    const snapshot = await store.fetchRecent(10);
    await store.persistRecord(record(2, 2000, '/b'));
    // The previously returned array is unaffected by the later persist.
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.path).toBe('/a');
  });

  it('defaults capacity to MAX_REQUEST_LOG_RECORDS', async () => {
    const store = new InMemoryRequestLogStore();
    for (let i = 0; i < MAX_REQUEST_LOG_RECORDS + 10; i += 1) {
      await store.persistRecord(record(1, i));
    }
    expect(await store.fetchRecent(MAX_REQUEST_LOG_RECORDS + 100)).toHaveLength(MAX_REQUEST_LOG_RECORDS);
  });

  it('throws RangeError on zero, negative, or non-integer capacity', () => {
    expect(() => new InMemoryRequestLogStore(0)).toThrow(RangeError);
    expect(() => new InMemoryRequestLogStore(-1)).toThrow(RangeError);
    expect(() => new InMemoryRequestLogStore(2.5)).toThrow(RangeError);
  });
});
