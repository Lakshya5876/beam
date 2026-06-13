/**
 * Bounded in-memory request-log store (design doc §7, S6).
 * Implements the domain RequestLogRepository as a fixed-capacity ring buffer:
 * once full, the oldest record is evicted so memory never grows unbounded.
 *
 * Pure in-memory, no I/O — depends only on domain types. All read/write
 * methods are total (never throw); only construction validates its capacity.
 */

import type { StreamId } from '../domain/frame.js';
import type { RequestLogRepository, RequestRecord } from '../domain/interfaces.js';

export const MAX_REQUEST_LOG_RECORDS = 1000;

export class InMemoryRequestLogStore implements RequestLogRepository {
  private readonly records: RequestRecord[] = [];
  private readonly capacity: number;

  constructor(capacity: number = MAX_REQUEST_LOG_RECORDS) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('request-log capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  persistRecord(record: RequestRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.shift();
    }
    return Promise.resolve();
  }

  fetchRecent(limit: number): Promise<readonly RequestRecord[]> {
    if (limit <= 0) {
      return Promise.resolve([]);
    }
    const count = Math.min(limit, this.records.length);
    const recent: RequestRecord[] = [];
    for (let i = this.records.length - 1; i >= this.records.length - count; i -= 1) {
      recent.push(this.records[i] as RequestRecord);
    }
    return Promise.resolve(recent);
  }

  findByStreamId(streamId: StreamId): Promise<readonly RequestRecord[]> {
    return Promise.resolve(this.records.filter((record) => record.streamId === streamId));
  }
}
