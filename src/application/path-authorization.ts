/**
 * Path authorization (design doc §A.3 --allowed-paths). Application layer
 * owns authorization rules (CLAUDE.md §1). Pure: no I/O, domain types only.
 *
 * Matching is PATH-SEGMENT prefix, not raw string prefix: an allow-list entry
 * "/api" permits "/api" and "/api/..." but NOT "/apifoo". An empty allow-list
 * means unrestricted (the default — every route on the port is exposed, which
 * the CLI's consent banner makes explicit).
 */

import type { ReplayResponse } from '../domain/interfaces.js';

function matchesSegment(pathname: string, entry: string): boolean {
  const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  if (normalized.length === 0) {
    return false;
  }
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function isPathAllowed(allowList: readonly string[], path: string): boolean {
  if (allowList.length === 0) {
    return true;
  }
  const pathname = path.split('?')[0] ?? path;
  return allowList.some((entry) => matchesSegment(pathname, entry));
}

/** The 403 a disallowed path yields BEFORE any localhost replay. */
export function forbiddenResponse(): ReplayResponse {
  return {
    status: 403,
    headers: { 'content-type': 'text/plain' },
    body: new TextEncoder().encode('Forbidden: path not in --allowed-paths'),
  };
}
