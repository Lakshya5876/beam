/**
 * Shared request-validation guards for anything relaying viewer-supplied
 * paths/headers to the developer's loopback app (HTTP via replay-client.ts,
 * WebSocket via ws-relay-client.ts). Pure predicates — no I/O.
 */

/** The one loopback address every relay client connects to — never a viewer-supplied host. */
export const LOOPBACK_HOST = '127.0.0.1';

export function containsControlChars(value: string): boolean {
  // Block CR, LF (request splitting) and NUL (path truncation on vulnerable servers).
  return /[\r\n\0]/.test(value);
}

/**
 * Detect path traversal patterns in the path-only portion of a request path
 * (before the query string). Blocks `..` segments, percent-encoded double
 * dots (`%2e%2e`, `.%2e`, `%2e.`), and encoded slashes (`%2f`) which could
 * combine with dots to form traversal sequences across decode boundaries.
 */
export function containsPathTraversal(rawPath: string): boolean {
  const pathOnly = rawPath.split('?')[0] ?? rawPath;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(pathOnly)) return true;
  if (/%2e%2e|%2e\.|\.%2e|%2f/i.test(pathOnly)) return true;
  return false;
}
