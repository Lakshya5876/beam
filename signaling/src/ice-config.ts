/**
 * ICE configuration served to BOTH peers at GET /ice-config — the viewer's
 * browser (bootstrap.ts) and the host CLI (src/infrastructure/
 * ice-config-client.ts) fetch the same endpoint, so the two ends of a session
 * are configured from one source of truth.
 *
 * Composition, in the order ICE should prefer them:
 *   1. STUN — always present (deploy-time ICE_SERVERS, else a public default).
 *      Enough on its own for the direct P2P path, which is what most sessions
 *      use and what Beam prefers.
 *   2. TURN — appended when a TurnProvider is configured, carrying freshly
 *      minted, short-lived credentials. Adding relay candidates does NOT make
 *      traffic relayed: ICE runs its connectivity checks over all candidate
 *      pairs and nominates a relay pair only when no direct pair works.
 *
 * Degradation is deliberate: if TURN minting fails for any reason, the
 * response still carries STUN and the session still connects over direct P2P.
 * A TURN outage must never be a Beam outage.
 *
 * Exposure note: this endpoint is public by design (a peer needs it before
 * it can prove anything about a session). That is exactly why the credentials
 * it carries are short-lived and per-mint, and why the provider secret that
 * mints them never appears in the response — see turn-provider.ts.
 */

import type { IceServerEntry, TurnProvider } from './turn-provider.js';

export type { IceServerEntry };

export const DEFAULT_ICE_SERVERS: readonly IceServerEntry[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

function isValidEntry(value: unknown): value is IceServerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const urls = (value as { urls?: unknown }).urls;
  if (typeof urls === 'string') {
    return urls.length > 0;
  }
  return Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string' && u.length > 0);
}

/** Total: malformed input yields the default, never a throw. */
export function parseIceServersEnv(raw: string | undefined): readonly IceServerEntry[] {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ICE_SERVERS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isValidEntry)) {
    return DEFAULT_ICE_SERVERS;
  }
  return parsed as IceServerEntry[];
}

/** What the peers receive, plus what the Worker reports about this response. */
export interface IceConfigResult {
  /** JSON body for GET /ice-config. */
  readonly body: string;
  /** True when the body carries usable relay (TURN) servers. */
  readonly hasTurn: boolean;
  /** Set only when a configured provider failed to mint — for the response
   *  diagnostic header; never carries provider internals. */
  readonly turnFailure?: string;
}

/** The JSON body served at GET /ice-config — RTCPeerConnection-consumable. */
export function iceConfigBody(raw: string | undefined): string {
  return JSON.stringify({ iceServers: parseIceServersEnv(raw) });
}

/**
 * Build the /ice-config response: STUN always, TURN appended when a provider
 * is configured AND minting succeeds. `provider` is null on a STUN-only
 * deployment, which is a supported configuration rather than a failure.
 */
export async function resolveIceConfig(
  raw: string | undefined,
  provider: TurnProvider | null,
  nowMs: number,
): Promise<IceConfigResult> {
  const stun = parseIceServersEnv(raw);
  if (!provider) {
    return { body: JSON.stringify({ iceServers: stun }), hasTurn: false };
  }
  const minted = await provider.mint(nowMs);
  if (!minted.ok) {
    // STUN-only: direct P2P still works for the majority of networks.
    return { body: JSON.stringify({ iceServers: stun }), hasTurn: false, turnFailure: minted.failure };
  }
  const iceServers = [...stun, ...minted.value.iceServers];
  return { body: JSON.stringify({ iceServers }), hasTurn: minted.value.iceServers.length > 0 };
}
