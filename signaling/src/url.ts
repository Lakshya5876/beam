/**
 * Session-code URL parsing (design §10 S14, S8<->S14 reconciliation).
 *
 * The code is the TRAILING path segment of the WS URL — byte-identical to S8's
 * WebSocketSignalingClient.buildUrl, which produces
 *   `${baseUrl.replace(/\/+$/, '')}/${code}`
 * i.e. the code appended as the last path segment of any base (with or without
 * its own path prefix). This parser is the server side of that contract; the
 * byte-identity is proven end-to-end against the real S8 client at S18.
 *
 * Total: malformed input yields null, never a throw.
 */

import { isValidSessionCode } from './session-code.js';

export function parseSessionCodeFromUrl(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined || !isValidSessionCode(last)) {
    return null;
  }
  return last;
}
