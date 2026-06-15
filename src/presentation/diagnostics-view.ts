/**
 * Diagnostics view (design doc §7, §10 S13): renders the live request log and
 * session status as plain text for the host's terminal.
 *
 * Presentation layer: formatting only; imports Application ONLY (the read
 * use-case). It does NOT import domain — formatters take a presentation-local
 * RequestRow that a domain RequestRecord satisfies structurally (CLAUDE.md §1).
 *
 * DEFERRED (design §7): richer connection diagnostics — winning ICE candidate
 * type, RTT, peer browser/OS — are not exposed through the current seams; out
 * of S13 scope until the transport surfaces them.
 */

import type { QueryDiagnosticsUseCase } from '../application/diagnostics-use-case.js';

/** Primitive-only row shape; a domain RequestRecord is assignable to it. */
export interface RequestRow {
  readonly timestampMs: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly responseSizeBytes: number;
  readonly streamId: number;
}

const EMPTY_LOG_PLACEHOLDER = '(no requests yet)';
const LOG_HEADER = 'TIME(ms)        METHOD  STATUS  LATENCY  SIZE      STREAM  PATH';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatRequestRow(row: RequestRow): string {
  return [
    pad(String(row.timestampMs), 15),
    pad(row.method, 7),
    pad(String(row.status), 7),
    pad(`${String(row.latencyMs)}ms`, 8),
    pad(`${String(row.responseSizeBytes)}B`, 9),
    pad(String(row.streamId), 7),
    row.path,
  ].join(' ');
}

export function formatRequestLog(rows: readonly RequestRow[]): string {
  if (rows.length === 0) {
    return EMPTY_LOG_PLACEHOLDER;
  }
  return [LOG_HEADER, ...rows.map((row) => formatRequestRow(row))].join('\n');
}

export function formatSessionStatus(state: string, reason?: string): string {
  switch (state) {
    case 'established':
      return '● session established — relaying requests';
    case 'pending':
      return '○ session pending — waiting for a viewer to connect';
    case 'closed':
      return '× session closed';
    case 'failed':
      return `✕ session failed${reason ? `: ${reason}` : ''}`;
    default:
      return `? session ${state}`;
  }
}

export class DiagnosticsView {
  constructor(private readonly query: QueryDiagnosticsUseCase) {}

  async renderRecent(limit: number): Promise<string> {
    const records = await this.query.recentRequests(limit);
    return formatRequestLog(records);
  }
}
