/**
 * Single source of truth for environment access. Feature code never reads
 * process.env directly — it receives a BeamConfig.
 *
 * Deployment-facing keys (all optional; CLI flags override env, env
 * overrides compiled defaults):
 *   BEAM_SIGNALING_URL  — signaling worker endpoint (wss://... or ws://...)
 *   BEAM_VIEWER_URL     — viewer Pages base URL (https://...)
 *   BEAM_ICE_SERVERS    — comma-separated ICE URLs for the HOST peer
 *                         (stun:host:port, turn:user:pass@host:port).
 *                         TURN credentials live ONLY in the shell env —
 *                         never written to disk (§3). Normally unnecessary:
 *                         the host fetches ICE servers (including minted
 *                         TURN credentials) from the signaling origin's
 *                         /ice-config. Set this to pin a self-hosted STUN or
 *                         coturn instead; the two are merged, env first.
 *   BEAM_MINT_TIMEOUT_MS— session-mint HTTP timeout (default 5000)
 *   BEAM_NATIVE_LOG     — libdatachannel log level (Verbose|Debug|Info|
 *                         Warning|Error); unset = native logging off.
 *                         The deep-diagnosis knob when --debug isn't enough.
 *   BEAM_ICE_TRANSPORT_POLICY — 'all' (default) or 'relay'. 'relay' forces
 *                         the connection through TURN, suppressing direct
 *                         candidates. Verification/diagnosis only: it proves
 *                         the relay path works (or that a network needs it),
 *                         and is never how normal sessions connect.
 */

import type { IceServerConfig } from './domain/interfaces.js';
import { parseIceServersEnv } from './application/ice-servers.js';

export type IceTransportPolicy = 'all' | 'relay';

export interface BeamConfig {
  readonly logLevel: string;
  readonly appPort: number;
  readonly signalingUrl?: string;
  readonly viewerUrl?: string;
  readonly iceServers?: readonly IceServerConfig[];
  readonly mintTimeoutMs: number;
  readonly nativeLogLevel?: string;
  readonly iceTransportPolicy?: IceTransportPolicy;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseIceServers(raw: string | undefined): readonly IceServerConfig[] | undefined {
  const servers = parseIceServersEnv(raw);
  return servers.length > 0 ? servers : undefined;
}

const NATIVE_LOG_LEVELS: ReadonlySet<string> = new Set(['Verbose', 'Debug', 'Info', 'Warning', 'Error']);

/** Non-empty env string, else undefined — keeps loadConfig's spread simple. */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function parseNativeLogLevel(raw: string | undefined): string | undefined {
  return raw !== undefined && NATIVE_LOG_LEVELS.has(raw) ? raw : undefined;
}

/**
 * Anything other than an explicit 'relay' means the normal policy: try direct
 * first, fall back to relay. An unrecognized value is never treated as a
 * request to force relaying.
 */
function parseIceTransportPolicy(raw: string | undefined): IceTransportPolicy | undefined {
  return raw?.trim().toLowerCase() === 'relay' ? 'relay' : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BeamConfig {
  const signalingUrl = nonEmpty(env['BEAM_SIGNALING_URL']);
  const viewerUrl = nonEmpty(env['BEAM_VIEWER_URL']);
  const iceServers = parseIceServers(env['BEAM_ICE_SERVERS']);
  const nativeLogLevel = parseNativeLogLevel(env['BEAM_NATIVE_LOG']);
  const iceTransportPolicy = parseIceTransportPolicy(env['BEAM_ICE_TRANSPORT_POLICY']);
  return {
    logLevel: env['BEAM_LOG_LEVEL'] ?? 'info',
    appPort: Number(env['APP_PORT'] ?? '8080'),
    ...(signalingUrl !== undefined && { signalingUrl }),
    ...(viewerUrl !== undefined && { viewerUrl }),
    ...(iceServers !== undefined && { iceServers }),
    mintTimeoutMs: parsePositiveInt(env['BEAM_MINT_TIMEOUT_MS'], 5000),
    ...(nativeLogLevel !== undefined && { nativeLogLevel }),
    ...(iceTransportPolicy !== undefined && { iceTransportPolicy }),
  };
}
