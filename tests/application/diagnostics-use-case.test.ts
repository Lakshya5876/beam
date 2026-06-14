import { describe, expect, it } from 'vitest';
import { createStreamId, isInvalidStreamIdError, type StreamId } from '../../src/domain/frame.js';
import type { RequestLogRepository, RequestRecord } from '../../src/domain/interfaces.js';
import { QueryDiagnosticsUseCase, RecordRequestUseCase, type RequestObservation } from '../../src/application/diagnostics-use-case.js';

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  return id;
}

// Reuses the S3 FakeRequestLogRepository pattern (interfaces.test.ts):
// a class implementing RequestLogRepository, newest-first fetchRecent.
class FakeRequestLogRepository implements RequestLogRepository {
  public readonly records: RequestRecord[] = [];
  persistRecord(record: RequestRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
  fetchRecent(limit: number): Promise<readonly RequestRecord[]> {
    return Promise.resolve([...this.records].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, limit));
  }
  findByStreamId(streamId: StreamId): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.records.filter((r) => r.streamId === streamId));
  }
}

function observation(overrides: Partial<RequestObservation> = {}): RequestObservation {
  return {
    method: 'GET',
    path: '/api/x',
    status: 200,
    latencyMs: 12,
    responseSizeBytes: 348,
    streamId: sid(1),
    ...overrides,
  };
}

describe('RecordRequestUseCase', () => {
  it('stamps timestamp from the injected clock and persists a RequestRecord', async () => {
    const repo = new FakeRequestLogRepository();
    const useCase = new RecordRequestUseCase(repo, () => 1_725_000_000_000);
    await useCase.record(observation({ method: 'POST', path: '/submit', status: 201, latencyMs: 33, responseSizeBytes: 99, streamId: sid(7) }));
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]).toEqual({
      timestampMs: 1_725_000_000_000,
      method: 'POST',
      path: '/submit',
      status: 201,
      latencyMs: 33,
      responseSizeBytes: 99,
      streamId: sid(7),
    });
  });
});

describe('QueryDiagnosticsUseCase', () => {
  async function seed(): Promise<{ repo: FakeRequestLogRepository; query: QueryDiagnosticsUseCase }> {
    const repo = new FakeRequestLogRepository();
    const recorder = new RecordRequestUseCase(repo, () => 0);
    // Persist three records with distinct timestamps via direct repo writes.
    await repo.persistRecord({ timestampMs: 1000, method: 'GET', path: '/a', status: 200, latencyMs: 1, responseSizeBytes: 10, streamId: sid(1) });
    await repo.persistRecord({ timestampMs: 3000, method: 'GET', path: '/c', status: 200, latencyMs: 1, responseSizeBytes: 10, streamId: sid(2) });
    await repo.persistRecord({ timestampMs: 2000, method: 'GET', path: '/b', status: 200, latencyMs: 1, responseSizeBytes: 10, streamId: sid(1) });
    void recorder;
    return { repo, query: new QueryDiagnosticsUseCase(repo) };
  }

  it('recentRequests returns newest-first honoring the limit', async () => {
    const { query } = await seed();
    const recent = await query.recentRequests(2);
    expect(recent.map((r) => r.path)).toEqual(['/c', '/b']);
  });

  it('requestsForStream returns matching records and empty for an unknown id', async () => {
    const { query } = await seed();
    expect((await query.requestsForStream(sid(1))).map((r) => r.path)).toEqual(['/a', '/b']);
    expect(await query.requestsForStream(sid(99))).toEqual([]);
  });
});
