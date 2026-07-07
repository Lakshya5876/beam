#!/usr/bin/env node
/**
 * CLI entry (design doc §10 S12, §A.3 consent). Presentation layer:
 * arg parsing + output formatting only; it composes via the composition root
 * and drives application use-cases — never infrastructure/domain concretes.
 *
 * run() prompts for the local URL interactively, generates a 6-digit CSPRNG
 * PIN, mints a session, and prints the viewer URL + PIN side-by-side.
 * The async session-start work (mint → start → print) is verified live at S18.
 */

import { parseArgs } from 'node:util';
import { randomInt, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { composeHost, type HostOptions, type HostRuntime } from '../composition.js';
import { loadConfig, type BeamConfig } from '../config.js';
import { createTimestampedLogger, describeSessionEvent } from './debug-log.js';

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CliUsageError };

function pOk<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function pErr<T>(error: CliUsageError): Parsed<T> {
  return { ok: false, error };
}

export type CliParseResult = Parsed<CliOptions>;

/**
 * Compiled-in fallbacks. PLACEHOLDER-DEFAULT: these are NOT live endpoints —
 * the release checklist (docs/deploy/RELEASE_CHECKLIST.md) requires replacing
 * them with the real deployed URLs before `npm publish`. Resolution order at
 * runtime: CLI flag > BEAM_SIGNALING_URL / BEAM_VIEWER_URL env > these.
 */
export const DEFAULT_SIGNALING_URL = 'wss://signal.beam.workers.dev';
export const DEFAULT_VIEWER_URL = 'https://beam-viewer.pages.dev';

export const USAGE =
  'usage: bm [<local-url>] [--allowed-paths /a,/b] [--ttl <seconds>] [--signaling <url>] [--viewer <url>] [--ice <urls>] [--ipv4-only] [--debug]';

export interface CliOptions {
  readonly allowedPaths: string[];
  readonly localUrl?: string;
  readonly ttlMs?: number;
  readonly signalingUrl?: string;
  readonly viewerUrl?: string;
  readonly iceServers?: readonly string[];
  readonly ipv4Only?: boolean;
  readonly debug?: boolean;
}

export interface CliUsageError {
  readonly error: 'CliUsage';
  readonly message: string;
}

function usage(message: string): CliUsageError {
  return { error: 'CliUsage', message };
}

function parseTtl(raw: string | undefined): Parsed<number | undefined> {
  if (raw === undefined) {
    return pOk(undefined);
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    return pErr(usage(`invalid --ttl "${raw}" — expected a positive integer (seconds)`));
  }
  return pOk(seconds * 1000);
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        'allowed-paths': { type: 'string' },
        ttl: { type: 'string' },
        signaling: { type: 'string' },
        viewer: { type: 'string' },
        ice: { type: 'string' },
        'ipv4-only': { type: 'boolean' },
        debug: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch {
    return pErr(usage('unrecognized arguments'));
  }
  if (parsed.positionals.length > 1) {
    return pErr(usage('at most one positional argument (local URL or port) is allowed'));
  }
  const ttl = parseTtl(parsed.values.ttl);
  if (!ttl.ok) {
    return ttl;
  }
  return pOk(assembleOptions(parsed.positionals[0], parsed.values, ttl.value));
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function assembleOptions(
  localUrl: string | undefined,
  values: { readonly 'allowed-paths'?: string; readonly signaling?: string; readonly viewer?: string; readonly ice?: string; readonly 'ipv4-only'?: boolean; readonly debug?: boolean },
  ttlMs: number | undefined,
): CliOptions {
  const iceServers = splitList(values.ice);
  return {
    allowedPaths: splitList(values['allowed-paths']) ?? [],
    ...(localUrl !== undefined && { localUrl }),
    ...(ttlMs !== undefined && { ttlMs }),
    ...(values.signaling !== undefined && { signalingUrl: values.signaling }),
    ...(values.viewer !== undefined && { viewerUrl: values.viewer }),
    ...(iceServers !== undefined && { iceServers }),
    ...(values['ipv4-only'] === true && { ipv4Only: true }),
    ...(values.debug === true && { debug: true }),
  };
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Parse a user-typed local URL string → port number. Accepts a bare port
 *  ("3000"), bare host:port, or a full URL. */
export function parseLocalUrl(raw: string): Parsed<number> {
  const trimmed = raw.trim();
  // Bare port first: new URL('http://3000') parses "3000" as an IPv4 integer
  // ADDRESS (0.0.11.184) with no port — `bm 3000` silently relayed to :80.
  // Caught by the local e2e harness (host replied ECONNREFUSED).
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    return validPort(port) ? pOk(port) : pErr(usage(`invalid port "${trimmed}" — expected 1-65535`));
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    return pErr(usage(`invalid URL "${raw}" — expected e.g. http://localhost:3000`));
  }
  const portStr = url.port;
  const port = portStr ? Number(portStr) : (url.protocol === 'https:' ? 443 : 80);
  if (!validPort(port)) {
    return pErr(usage(`no valid port in "${raw}"`));
  }
  return pOk(port);
}

export function securityBanner(localUrl: string, allowedPaths: string[]): string {
  const scope =
    allowedPaths.length > 0
      ? `Only these paths are exposed: ${allowedPaths.join(', ')}`
      : `Every route on ${localUrl} is reachable by anyone with the link.`;
  return [
    'WARNING: Beam is about to expose your local server.',
    `   Target: ${localUrl}`,
    `   ${scope}`,
    '   Anyone holding the session link + code can send requests for the life of the session.',
    '   Press Ctrl-C to stop.',
  ].join('\n');
}

export interface CliIO {
  write(line: string): void;
  error(line: string): void;
  onSigint(handler: () => void): void;
  composeRuntime(options: HostOptions): HostRuntime;
  promptLocalUrl(): Promise<string>;
  generatePin(): string;
}

function defaultIO(): CliIO {
  return {
    write: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    onSigint: (handler) => process.on('SIGINT', handler),
    composeRuntime: (options) => composeHost(options),
    promptLocalUrl(): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise<string>((resolve) => {
        rl.question('  Enter local URL (e.g. http://localhost:3000): ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    },
    generatePin: () => String(randomInt(100_000, 1_000_000)),
  };
}

function computePinHash(pin: string, sessionCode: string): string {
  return createHash('sha256').update(`${pin}:${sessionCode}`).digest('hex');
}

/**
 * Mint a session code, start the runtime, and print the viewer URL + PIN.
 * Errors are written to io.error, never thrown to the caller.
 */
async function startSession(
  runtime: HostRuntime,
  signalingUrl: string,
  viewerUrl: string,
  pin: string,
  io: CliIO,
  mintTimeoutMs: number,
  ipv4Only: boolean,
): Promise<void> {
  const baseUrl = signalingUrl.replace(/^ws(s?):\/\//, 'http$1://');
  const mintUrl = new URL('/new', baseUrl).href;
  let code: string;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), mintTimeoutMs);
    try {
      const resp = await fetch(mintUrl, { method: 'POST', signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        io.error(`mint failed: ${String(resp.status)} ${resp.statusText}`);
        return;
      }
      const body = await resp.json() as { code?: unknown };
      if (typeof body.code !== 'string') {
        io.error('mint returned unexpected response (no code field)');
        return;
      }
      code = body.code;
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      throw fetchErr;
    }
  } catch (err) {
    io.error(`signaling unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const started = await runtime.start(code);
  if (!started.ok) {
    io.error(`session start failed: ${JSON.stringify(started.error)}`);
    return;
  }

  // Register the PIN hash with the DO so the viewer must verify before WebRTC starts.
  const pinHash = computePinHash(pin, code);
  const pinResult = await runtime.registerPin(pinHash);
  if (!pinResult.ok) {
    io.error('pin registration failed: signaling disconnected');
    return;
  }

  const sessionUrl = `${viewerUrl}/?signaling=${signalingUrl}/${code}${ipv4Only ? '&ipv4=1' : ''}`;
  const formattedPin = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  io.write('');
  io.write(`  Viewer URL:   ${sessionUrl}`);
  io.write(`  Session code: ${formattedPin}`);
  io.write('');
  io.write('  Share both with your viewer. Press Ctrl-C to end the session.');
  io.write('');
}

/**
 * Resolve effective endpoint/ICE settings: CLI flag > env (BeamConfig) >
 * compiled default. Exported for tests.
 */
export interface ResolvedEndpoints {
  readonly signalingUrl: string;
  readonly viewerUrl: string;
  readonly iceServers?: readonly string[];
  readonly mintTimeoutMs: number;
  readonly nativeLogLevel?: string;
}

export function resolveEndpoints(options: CliOptions, config: BeamConfig): ResolvedEndpoints {
  const iceServers = options.iceServers ?? config.iceServers;
  return {
    signalingUrl: options.signalingUrl ?? config.signalingUrl ?? DEFAULT_SIGNALING_URL,
    viewerUrl: options.viewerUrl ?? config.viewerUrl ?? DEFAULT_VIEWER_URL,
    ...(iceServers !== undefined && { iceServers }),
    mintTimeoutMs: config.mintTimeoutMs,
    ...(config.nativeLogLevel !== undefined && { nativeLogLevel: config.nativeLogLevel }),
  };
}

function buildHostOptions(port: number, options: CliOptions, resolved: ResolvedEndpoints, io: CliIO): HostOptions {
  const base = {
    localPort: port,
    signalingUrl: resolved.signalingUrl,
    allowedPaths: options.allowedPaths,
    ...(resolved.iceServers !== undefined && { iceServers: resolved.iceServers }),
    ...(resolved.nativeLogLevel !== undefined && { nativeLogLevel: resolved.nativeLogLevel }),
    ...(options.ipv4Only === true && { ipv4Only: true }),
    ...(options.debug === true && { debug: true, log: createTimestampedLogger((line) => { io.error(line); }) }),
  };
  return options.ttlMs === undefined ? base : { ...base, ttlMs: options.ttlMs };
}

/**
 * Parse flags, prompt for local URL, generate PIN, compose runtime, start session.
 */
export async function run(argv: readonly string[], io: CliIO = defaultIO(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error.message);
    io.error(USAGE);
    return 2;
  }
  const options = parsed.value;

  const rawUrl = options.localUrl !== undefined ? options.localUrl : await io.promptLocalUrl();
  const portResult = parseLocalUrl(rawUrl);
  if (!portResult.ok) {
    io.error(portResult.error.message);
    io.error(USAGE);
    return 2;
  }
  const port = portResult.value;

  io.write(securityBanner(rawUrl, options.allowedPaths));

  const pin = io.generatePin();
  const resolved = resolveEndpoints(options, loadConfig(env));
  const runtime = io.composeRuntime(buildHostOptions(port, options, resolved, io));
  // Connection status lines: connecting is implicit; established/failed/closed
  // print as they happen instead of leaving the user staring at silence.
  runtime.session.onEvent((event) => {
    const line = describeSessionEvent(event);
    if (line !== null) {
      io.write(line);
    }
  });
  io.onSigint(() => {
    void runtime.close('host interrupted (SIGINT)');
  });
  await startSession(runtime, resolved.signalingUrl, resolved.viewerUrl, pin, io, resolved.mintTimeoutMs, options.ipv4Only === true);
  return 0;
}

// Entry point: only run when this module is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error('Fatal error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
