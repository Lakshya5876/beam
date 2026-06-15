import { describe, expect, it } from 'vitest';
import { createStreamId, isInvalidStreamIdError, type StreamId } from '../../src/domain/frame.js';
import type { RequestLogRepository, RequestRecord } from '../../src/domain/interfaces.js';
import { QueryDiagnosticsUseCase } from '../../src/application/diagnostics-use-case.js';
import {
  DiagnosticsView,
  formatRequestLog,
  formatRequestRow,
  formatSessionStatus,
  type RequestRow,
} from '../../src/presentation/diagnostics-view.js';

function sid(value: number): StreamId {
  const id = createStreamId(value);
  if (isInvalidStreamIdError(id)) {
    throw new Error('test setup: stream id');
  }
  return id;
}

function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return { timestampMs: 1000, method: 'GET', path: '/api/x', status: 200, latencyMs: 12, responseSizeBytes: 348, streamId: 1, ...overrides };
}

describe('formatRequestRow', () => {
  it('renders method, path, status, latency, size, and stream id on one line', () => {
    const line = formatRequestRow(row({ method: 'POST', path: '/submit', status: 201, latencyMs: 33, responseSizeBytes: 99, streamId: 7 }));
    expect(line).toContain('POST');
    expect(line).toContain('/submit');
    expect(line).toContain('201');
    expect(line).toContain('33ms');
    expect(line).toContain('99B');
    expect(line).toContain('7');
    expect(line.includes('\n')).toBe(false);
  });
});

describe('formatRequestLog', () => {
  it('renders the placeholder for an empty log', () => {
    expect(formatRequestLog([])).toBe('(no requests yet)');
  });

  it('renders a header plus one line per row, preserving order', () => {
    const out = formatRequestLog([row({ path: '/first' }), row({ path: '/second' })]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain('METHOD');
    expect(lines[1]).toContain('/first');
    expect(lines[2]).toContain('/second');
  });

  it('tolerates odd data without throwing (status 0, empty path, zero size)', () => {
    expect(() => formatRequestLog([row({ status: 0, path: '', responseSizeBytes: 0, latencyMs: 0 })])).not.toThrow();
  });
});

describe('formatSessionStatus', () => {
  it('renders distinct lines per state and includes the failure reason', () => {
    expect(formatSessionStatus('pending')).toContain('pending');
    expect(formatSessionStatus('established')).toContain('established');
    expect(formatSessionStatus('closed')).toContain('closed');
    const failed = formatSessionStatus('failed', 'no viable candidate');
    expect(failed).toContain('failed');
    expect(failed).toContain('no viable candidate');
  });
});

class FakeRequestLogRepository implements RequestLogRepository {
  constructor(private readonly seeded: RequestRecord[]) {}
  persistRecord(): Promise<void> {
    return Promise.resolve();
  }
  fetchRecent(limit: number): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.seeded.slice(0, limit));
  }
  findByStreamId(): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.seeded);
  }
}

describe('DiagnosticsView.renderRecent', () => {
  it('queries the read use-case and renders the records, honoring the limit', async () => {
    const records: RequestRecord[] = [
      { timestampMs: 3000, method: 'GET', path: '/c', status: 200, latencyMs: 5, responseSizeBytes: 10, streamId: sid(3) },
      { timestampMs: 2000, method: 'GET', path: '/b', status: 200, latencyMs: 5, responseSizeBytes: 10, streamId: sid(2) },
      { timestampMs: 1000, method: 'GET', path: '/a', status: 200, latencyMs: 5, responseSizeBytes: 10, streamId: sid(1) },
    ];
    const view = new DiagnosticsView(new QueryDiagnosticsUseCase(new FakeRequestLogRepository(records)));
    const rendered = await view.renderRecent(2);
    expect(rendered).toContain('/c');
    expect(rendered).toContain('/b');
    expect(rendered).not.toContain('/a');
  });

  it('renders the placeholder when the log is empty', async () => {
    const view = new DiagnosticsView(new QueryDiagnosticsUseCase(new FakeRequestLogRepository([])));
    expect(await view.renderRecent(10)).toBe('(no requests yet)');
  });
});
