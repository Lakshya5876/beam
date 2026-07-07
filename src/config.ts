/**
 * Single source of truth for environment access (CLAUDE.md §3 SECURITY
 * INVARIANTS). Feature code never reads process.env directly — it receives
 * a BeamConfig. CORE_FILES member: editing semantics is a hard stop.
 *
 * Deployment-facing keys (all optional; CLI flags override env, env
 * overrides compiled defaults):
 *   BEAM_SIGNALING_URL  — signaling worker endpoint (wss://... or ws://...)
 *   BEAM_VIEWER_URL     — viewer Pages base URL (https://...)
 *   BEAM_ICE_SERVERS    — comma-separated ICE URLs for the HOST peer
 *                         (stun:host:port, turn:user:pass@host:port).
 *                         TURN credentials live ONLY in the shell env —
 *                         never written to disk (§3).
 *   BEAM_MINT_TIMEOUT_MS— session-mint HTTP timeout (default 5000)
 *   BEAM_NATIVE_LOG     — libdatachannel log level (Verbose|Debug|Info|
 *                         Warning|Error); unset = native logging off.
 *                         The deep-diagnosis knob when --debug isn't enough.
 */
export interface BeamConfig {
  readonly logLevel: string;
  readonly appPort: number;
  readonly signalingUrl?: string;
  readonly viewerUrl?: string;
  readonly iceServers?: readonly string[];
  readonly mintTimeoutMs: number;
  readonly nativeLogLevel?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseIceServers(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const servers = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return servers.length > 0 ? servers : undefined;
}

const NATIVE_LOG_LEVELS: ReadonlySet<string> = new Set(['Verbose', 'Debug', 'Info', 'Warning', 'Error']);

/** Non-empty env string, else undefined — keeps loadConfig's spread simple. */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BeamConfig {
  const signalingUrl = nonEmpty(env['BEAM_SIGNALING_URL']);
  const viewerUrl = nonEmpty(env['BEAM_VIEWER_URL']);
  const iceServers = parseIceServers(env['BEAM_ICE_SERVERS']);
  const rawNativeLog = env['BEAM_NATIVE_LOG'];
  const nativeLogLevel = rawNativeLog !== undefined && NATIVE_LOG_LEVELS.has(rawNativeLog) ? rawNativeLog : undefined;
  return {
    logLevel: env['BEAM_LOG_LEVEL'] ?? 'info',
    appPort: Number(env['APP_PORT'] ?? '8080'),
    ...(signalingUrl !== undefined && { signalingUrl }),
    ...(viewerUrl !== undefined && { viewerUrl }),
    ...(iceServers !== undefined && { iceServers }),
    mintTimeoutMs: parsePositiveInt(env['BEAM_MINT_TIMEOUT_MS'], 5000),
    ...(nativeLogLevel !== undefined && { nativeLogLevel }),
  };
}
