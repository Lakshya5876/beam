/**
 * Pure URL construction for the viewer signaling WebSocket.
 * Achieves byte-identity with S8's buildUrl and S14's parser (URL triangle).
 */

export function buildViewerSignalingUrl(baseUrl: string, sessionCode: string): string {
  // S8 replica: strip trailing slashes, append code
  return `${baseUrl.replace(/\/+$/, '')}/${sessionCode}`;
}

/**
 * Extract a Beam session code from a URL's query string. Shared by two
 * callers that both need the SAME parsing rule applied to two different
 * URLs:
 *   - bootstrap.ts reads its own `window.location.search` to find which
 *     session this outer tab belongs to.
 *   - sw-session-registry.ts reads a fetch event's `Request.referrer` (the
 *     outer document's own URL) to identify which session a brand-new
 *     tunneled-app iframe navigation belongs to, BEFORE that iframe's own
 *     client has had a chance to announce itself — see that file's doc for
 *     why this is the one case where no other signal is available yet, and
 *     SECURITY_AUDIT_20-08.md finding #1 for why guessing instead is unsafe.
 *
 * Checks `?session=<code>` first, then the last path segment of
 * `?signaling=<url>/<code>` — mirrors the CLI's printed viewer URL shape.
 */
export function extractSessionCodeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);

  const direct = params.get('session');
  if (direct && direct.length > 0) return direct;

  const signalingUrl = params.get('signaling');
  if (signalingUrl) {
    const segments = signalingUrl.split('/').filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last && /^[a-z0-9]{4,}$/.test(last)) return last;
  }

  return null;
}

/**
 * As extractSessionCodeFromSearch, but takes a full URL string (e.g. a
 * `Request.referrer`) rather than an already-isolated query string. Total:
 * an unparseable URL yields null rather than throwing — a fetch event's
 * referrer can legitimately be an empty string (e.g. a `no-referrer` policy
 * upstream), which `new URL('')` rejects.
 */
export function extractSessionCodeFromUrl(url: string): string | null {
  try {
    return extractSessionCodeFromSearch(new URL(url).search);
  } catch {
    return null;
  }
}
