/**
 * Diagnostics use-cases (design doc §7, §10 S11): the request-log surface.
 * RecordRequestUseCase turns a relayed-request observation into a
 * RequestRecord (stamping time from the injected clock) and persists it —
 * this is where S10 relay results become RequestRecords with timing.
 * QueryDiagnosticsUseCase reads the bounded log back.
 *
 * Application layer: orchestrates the RequestLogRepository INTERFACE only;
 * time is injected (no Date.now); no transport/HTTP/CLI concepts.
 */

import type { StreamId } from '../domain/frame.js';
import type { RequestLogRepository, RequestRecord } from '../domain/interfaces.js';

export interface RequestObservation {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly responseSizeBytes: number;
  readonly streamId: StreamId;
}

export class RecordRequestUseCase {
  constructor(
    private readonly repository: RequestLogRepository,
    private readonly now: () => number,
  ) {}

  record(observation: RequestObservation): Promise<void> {
    const record: RequestRecord = {
      timestampMs: this.now(),
      method: observation.method,
      path: observation.path,
      status: observation.status,
      latencyMs: observation.latencyMs,
      responseSizeBytes: observation.responseSizeBytes,
      streamId: observation.streamId,
    };
    return this.repository.persistRecord(record);
  }
}

export class QueryDiagnosticsUseCase {
  constructor(private readonly repository: RequestLogRepository) {}

  recentRequests(limit: number): Promise<readonly RequestRecord[]> {
    return this.repository.fetchRecent(limit);
  }

  requestsForStream(streamId: StreamId): Promise<readonly RequestRecord[]> {
    return this.repository.findByStreamId(streamId);
  }
}
