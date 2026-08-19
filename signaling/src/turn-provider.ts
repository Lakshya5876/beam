/**
 * TURN credential minting, behind a provider-neutral seam.
 *
 * Beam prefers direct P2P and uses TURN strictly as the ICE fallback: these
 * servers are added ALONGSIDE STUN in the list handed to each peer, and
 * standard ICE candidate prioritization picks a relay pair only when no
 * direct pair passes its connectivity checks. Nothing here routes traffic —
 * it only supplies credentials the peers may or may not end up using.
 *
 * Provider independence: `TurnProvider` is the whole contract. Metered's
 * two-call REST flow is one implementation of it (metered.ts); a coturn
 * deployment with a shared secret, or Cloudflare Realtime, plugs in the same
 * way without the Worker, the viewer, or the host CLI changing.
 *
 * Secret handling: the provider secret is read from the Worker environment
 * (a wrangler secret) and used only in outbound requests from the Worker.
 * `mint` returns ONLY short-lived, per-session credentials — the long-lived
 * secret never appears in a response body, a log line, or the client bundle.
 *
 * Pure module except for the injected `fetch` port: no Worker runtime types,
 * no ambient globals, so it unit-tests against a fake fetch.
 */

/** Minimal fetch surface used here — injected, never taken from globalThis. */
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** RTCIceServer-shaped entry, the format both peers ultimately consume. */
export interface IceServerEntry {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface MintedCredentials {
  /** ICE servers carrying the freshly minted, expiring credentials. */
  readonly iceServers: readonly IceServerEntry[];
  /** Absolute epoch ms at which these credentials stop working. */
  readonly expiresAtMs: number;
}

export type TurnMintFailure =
  | 'not-configured'
  | 'provider-rejected'
  | 'provider-unreachable'
  | 'malformed-response';

export type TurnMintResult =
  | { readonly ok: true; readonly value: MintedCredentials }
  | { readonly ok: false; readonly failure: TurnMintFailure };

/**
 * The seam. An implementation mints short-lived TURN credentials, or reports
 * a typed failure — it never throws, because a TURN outage must degrade the
 * session to STUN-only (direct P2P still works for most networks) rather
 * than failing the connection outright.
 */
export interface TurnProvider {
  mint(nowMs: number): Promise<TurnMintResult>;
}

export function mintOk(value: MintedCredentials): TurnMintResult {
  return { ok: true, value };
}

export function mintFailed(failure: TurnMintFailure): TurnMintResult {
  return { ok: false, failure };
}

/**
 * Wraps a provider with an in-memory TTL cache.
 *
 * Why: /ice-config is requested at least twice per session (host and viewer)
 * and minting costs two upstream round-trips. Caching one credential across
 * the sessions an isolate serves keeps that off the connection's critical
 * path. Credentials are refreshed well before expiry (see REFRESH_MARGIN_MS)
 * so a cached entry is never handed out with only seconds left on it.
 *
 * Scope note: a Worker isolate's module scope is per-isolate and evictable,
 * so this is a best-effort cache, never a correctness dependency — a miss
 * just mints again.
 */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export class CachingTurnProvider implements TurnProvider {
  private cached: MintedCredentials | null = null;
  private inflight: Promise<TurnMintResult> | null = null;

  constructor(
    private readonly inner: TurnProvider,
    private readonly refreshMarginMs: number = REFRESH_MARGIN_MS,
  ) {}

  async mint(nowMs: number): Promise<TurnMintResult> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - this.refreshMarginMs > nowMs) {
      return mintOk(cached);
    }
    // Collapse concurrent misses onto one upstream mint: the host and viewer
    // of the same session typically request /ice-config within milliseconds
    // of each other.
    this.inflight ??= this.inner.mint(nowMs).finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if (result.ok) {
      this.cached = result.value;
    }
    return result;
  }
}
