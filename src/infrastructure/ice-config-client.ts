/**
 * Fetches ICE configuration for the HOST peer from GET /ice-config on the
 * signaling origin — the same endpoint and the same response the viewer's
 * browser reads (viewer/src/bootstrap.ts fetchIceServers).
 *
 * Why the host needs this at all: TURN credentials are minted server-side and
 * expire, so they cannot be compiled into the CLI or shipped in a config file.
 * Before this existed the host only ever saw BEAM_ICE_SERVERS, so a deployment
 * with TURN configured gave relay candidates to the viewer alone. ICE can
 * often still succeed with one relay-capable side, but the pairing is
 * needlessly fragile — both ends offering relay candidates is what makes the
 * fallback dependable on symmetric-NAT/CGNAT networks.
 *
 * Failure is never fatal: the caller keeps its configured/default STUN and
 * still attempts a direct connection, which is what most networks use anyway.
 */

import { parseIceServerList } from '../application/ice-servers.js';
import {
  err,
  ok,
  type IceConfigClient,
  type IceConfigFetchError,
  type IceServerConfig,
  type Result,
} from '../domain/interfaces.js';

export const DEFAULT_ICE_CONFIG_TIMEOUT_MS = 5000;

/** Cap on a response body: the legitimate one is a few hundred bytes. */
export const MAX_ICE_CONFIG_BYTES = 64 * 1024;

/**
 * Derive the /ice-config URL from the signaling URL the host is already
 * given: same origin, ws/wss mapped to http/https, any session-code path
 * dropped (the endpoint lives at the origin root).
 */
export function iceConfigUrlFor(signalingUrl: string): string | null {
  const httpish = signalingUrl.trim().replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  try {
    const url = new URL(httpish);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return new URL('/ice-config', url.origin).href;
  } catch {
    return null;
  }
}

function fetchFailed(reason: string): IceConfigFetchError {
  return { error: 'IceConfigFetchFailed', reason };
}

/** The subset of the global fetch this adapter uses; injectable for tests. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export class HttpIceConfigClient implements IceConfigClient {
  constructor(
    private readonly timeoutMs: number = DEFAULT_ICE_CONFIG_TIMEOUT_MS,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly log: (msg: string) => void = () => { /* noop */ },
  ) {}

  async fetchIceServers(signalingUrl: string): Promise<Result<readonly IceServerConfig[], IceConfigFetchError>> {
    const url = iceConfigUrlFor(signalingUrl);
    if (!url) {
      return err(fetchFailed('signaling url is not http(s)/ws(s)'));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return err(fetchFailed(`ice-config responded ${String(response.status)}`));
      }
      // The worker reports TURN availability out-of-band so a connection
      // failure can be attributed without reading server logs.
      const turnState = response.headers.get('x-beam-turn');
      if (turnState !== null) {
        this.log(`[HOST-ICE] ice-config turn=${turnState}`);
      }
      const body = await response.text();
      if (body.length > MAX_ICE_CONFIG_BYTES) {
        return err(fetchFailed('ice-config body exceeds cap'));
      }
      const servers = parseIceServerList(safeJson(body));
      if (servers.length === 0) {
        return err(fetchFailed('ice-config contained no usable servers'));
      }
      return ok(servers);
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return err(fetchFailed(aborted ? 'ice-config timed out' : 'ice-config request failed'));
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy/captive portal serving HTML here is expected in the wild —
    // a parse failure must degrade to "no servers", not crash the host.
    return null;
  }
}
