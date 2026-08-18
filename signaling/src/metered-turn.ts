/**
 * Metered Open Relay as a TurnProvider (see turn-provider.ts for the seam
 * this implements and why it exists). Beam uses Metered ONLY as a standards
 * -compliant TURN service — none of its SDK, signalling, or session
 * machinery is involved, and swapping in coturn or another provider means
 * writing one more TurnProvider, not touching Beam's WebRTC path.
 *
 * Metered's documented flow is two calls:
 *   1. POST /api/v1/turn/credential  {expiryInSeconds, label}, authenticated
 *      with the long-term provider secret -> mints an EXPIRING credential and
 *      returns a HANDLE for it. The secret never leaves the Worker.
 *   2. GET  /api/v1/turn/credentials  authenticated with that handle
 *      -> [{urls, username, credential}, …]  (the ICE server list for that
 *         credential, geo-selected by the provider)
 *
 * Only step 2's output reaches a peer. The step-1 handle is an internal
 * detail and is deliberately NOT forwarded to clients — Metered calls it an
 * "apiKey" in its response, but it is a per-mint handle, not the account
 * credential, and this module keeps that distinction explicit.
 */

import {
  mintFailed,
  mintOk,
  type FetchLike,
  type IceServerEntry,
  type MintedCredentials,
  type TurnMintResult,
  type TurnProvider,
} from './turn-provider.js';

/**
 * Metered app names form a DNS label of the account's subdomain. Validated
 * strictly before interpolation so a malformed env value cannot redirect the
 * outbound request to another host (the secret travels in that request).
 */
const APP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** 4h: comfortably longer than Beam's own 4h session TTL cap is reached in
 *  practice, while still expiring on its own if a credential ever leaks. */
export const DEFAULT_TTL_SECONDS = 4 * 60 * 60;

/** Provider query-parameter names, kept as constants so the request shape is
 *  in one place and reads as configuration rather than inline credentials. */
const SECRET_PARAM = 'secretKey';
const CREDENTIAL_HANDLE_PARAM = 'apiKey';

export interface MeteredConfig {
  /** Account subdomain — the `<app>` in https://<app>.metered.live. */
  readonly appName: string;
  /** Long-lived provider secret. Worker secret only; never sent to a client. */
  readonly secretKey: string;
  readonly ttlSeconds?: number;
}

/**
 * Read Metered configuration from a plain env record. Returns null when TURN
 * is not configured — an explicitly supported deployment (STUN-only, direct
 * P2P), not an error.
 */
export function readMeteredConfig(env: {
  METERED_APP_NAME?: string;
  METERED_SECRET_KEY?: string;
  TURN_TTL_SECONDS?: string;
}): MeteredConfig | null {
  const appName = env.METERED_APP_NAME?.trim();
  const secretKey = env.METERED_SECRET_KEY?.trim();
  if (!appName || !secretKey || !APP_NAME_PATTERN.test(appName)) {
    return null;
  }
  const ttl = Number(env.TURN_TTL_SECONDS);
  return {
    appName,
    secretKey,
    ...(Number.isInteger(ttl) && ttl > 0 && { ttlSeconds: ttl }),
  };
}

interface MintedCredentialResponse {
  /** Per-mint handle used to resolve the ICE server list in step 2. */
  readonly handle: string;
  readonly expiryInSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Total parser for step 1's body. */
export function parseCredentialResponse(value: unknown, fallbackTtlSeconds: number): MintedCredentialResponse | null {
  const handle = isRecord(value) ? value['apiKey'] : undefined;
  if (typeof handle !== 'string' || handle.length === 0) {
    return null;
  }
  const expiry = isRecord(value) ? value['expiryInSeconds'] : undefined;
  return {
    handle,
    expiryInSeconds: typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0 ? expiry : fallbackTtlSeconds,
  };
}

/**
 * Total parser for step 2's body: keeps only entries with a usable `urls`,
 * and drops any field the peers do not need. Anything unrecognized yields an
 * empty list, so a provider format change degrades to STUN-only rather than
 * shipping malformed ICE config to a peer.
 */
export function parseIceServersResponse(value: unknown): IceServerEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: IceServerEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }
    const urls = raw['urls'];
    if (typeof urls !== 'string' || urls.length === 0) {
      continue;
    }
    const username = raw['username'];
    const credential = raw['credential'];
    out.push({
      urls,
      ...(typeof username === 'string' && { username }),
      ...(typeof credential === 'string' && { credential }),
    });
  }
  return out;
}

export class MeteredTurnProvider implements TurnProvider {
  private readonly ttlSeconds: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: MeteredConfig,
    fetchImpl: FetchLike,
  ) {
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    // Deliberately NOT `this.fetchImpl = fetchImpl` as a parameter property:
    // every call site below invokes this as `this.fetchImpl(...)`, which is a
    // METHOD call — the receiver (this MeteredTurnProvider instance) becomes
    // fetch's `this`. Cloudflare Workers' real fetch (unlike Node's) rejects
    // that with an illegal-invocation-style failure, which this file's own
    // catch-all then reported as 'provider-unreachable' — indistinguishable
    // from a genuine network failure, so a live Worker never worked while
    // this same code passed every unit test (Node's fetch does not enforce
    // the receiver). Wrapping here makes every call site a bare invocation
    // regardless of what was passed in, so this can never regress silently.
    this.fetchImpl = (url, init) => fetchImpl(url, init);
  }

  private get baseUrl(): string {
    return `https://${this.config.appName}.metered.live/api/v1/turn`;
  }

  async mint(nowMs: number): Promise<TurnMintResult> {
    const credential = await this.mintCredential();
    if (!credential.ok) {
      return credential.result;
    }
    const iceServers = await this.fetchIceServers(credential.value.handle);
    if (!iceServers.ok) {
      return iceServers.result;
    }
    const value: MintedCredentials = {
      iceServers: iceServers.value,
      expiresAtMs: nowMs + credential.value.expiryInSeconds * 1000,
    };
    return mintOk(value);
  }

  /** Step 1 — mint an expiring credential. The secret is used here only. */
  private async mintCredential(): Promise<
    { ok: true; value: MintedCredentialResponse } | { ok: false; result: TurnMintResult }
  > {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/credential?${SECRET_PARAM}=${encodeURIComponent(this.config.secretKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expiryInSeconds: this.ttlSeconds, label: 'beam' }),
        },
      );
    } catch {
      // Network-level failure reaching the provider. Deliberately does not
      // carry the underlying error outward: it can quote the request URL,
      // which contains the secret.
      return { ok: false, result: mintFailed('provider-unreachable') };
    }
    if (!response.ok) {
      return { ok: false, result: mintFailed('provider-rejected') };
    }
    const parsed = parseCredentialResponse(await this.readJson(response), this.ttlSeconds);
    return parsed ? { ok: true, value: parsed } : { ok: false, result: mintFailed('malformed-response') };
  }

  /** Step 2 — resolve that credential to a geo-selected ICE server list. */
  private async fetchIceServers(
    handle: string,
  ): Promise<{ ok: true; value: IceServerEntry[] } | { ok: false; result: TurnMintResult }> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      const query = `${CREDENTIAL_HANDLE_PARAM}=${encodeURIComponent(handle)}`;
      response = await this.fetchImpl(`${this.baseUrl}/credentials?${query}`);
    } catch {
      return { ok: false, result: mintFailed('provider-unreachable') };
    }
    if (!response.ok) {
      return { ok: false, result: mintFailed('provider-rejected') };
    }
    const servers = parseIceServersResponse(await this.readJson(response));
    return servers.length > 0
      ? { ok: true, value: servers }
      : { ok: false, result: mintFailed('malformed-response') };
  }

  private async readJson(response: { json(): Promise<unknown> }): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

/** Build the configured provider, or null when TURN is not configured. */
export function createMeteredProvider(
  env: { METERED_APP_NAME?: string; METERED_SECRET_KEY?: string; TURN_TTL_SECONDS?: string },
  fetchImpl: FetchLike,
): TurnProvider | null {
  const config = readMeteredConfig(env);
  return config ? new MeteredTurnProvider(config, fetchImpl) : null;
}
