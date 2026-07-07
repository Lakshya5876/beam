/**
 * ICE configuration served to viewers at GET /ice-config. Pure: parses the
 * ICE_SERVERS env value (a JSON array of RTCIceServer-shaped objects) and
 * falls back to the public Google STUN server when unset or malformed.
 *
 * Why served, not bundled: the viewer is a static Pages bundle — baking ICE
 * servers in means redeploying the viewer to rotate a TURN host. Serving it
 * from the worker makes ICE a deploy-time `wrangler.jsonc` var (or a secret,
 * for TURN credentials) with no rebuild.
 *
 * NOTE: whatever is returned here is public — anyone can GET it. Long-lived
 * TURN credentials placed in ICE_SERVERS are therefore exposed; use
 * short-lived credentials or a separate auth layer before adding TURN
 * (documented in docs/deploy/CLOUDFLARE_SETUP.md).
 */

export const DEFAULT_ICE_SERVERS: readonly IceServerEntry[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export interface IceServerEntry {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

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

/** The JSON body served at GET /ice-config — RTCPeerConnection-consumable. */
export function iceConfigBody(raw: string | undefined): string {
  return JSON.stringify({ iceServers: parseIceServersEnv(raw) });
}
