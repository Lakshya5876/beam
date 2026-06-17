/**
 * CLI entry (design doc §10 S12, §A.3 consent). Presentation layer:
 * arg parsing + output formatting only; it composes via the composition root
 * and drives application use-cases — never infrastructure/domain concretes.
 *
 * run() stays synchronous and returns an exit code — existing tests cover the
 * sync surface (parse errors, banner, SIGINT). The async session-start work
 * (mint → start → print URL) is fired with `void` and verified live at S18.
 */

import { parseArgs } from 'node:util';
import { composeHost, type HostOptions, type HostRuntime } from '../composition.js';

// Presentation-local result type: the layer imports Application/composition
// ONLY (CLAUDE.md §1), so it does not reach into the domain Result.
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CliUsageError };

function pOk<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function pErr<T>(error: CliUsageError): Parsed<T> {
  return { ok: false, error };
}

export type CliParseResult = Parsed<CliOptions>;

export const DEFAULT_SIGNALING_URL = 'wss://signal.beam.workers.dev';
export const DEFAULT_VIEWER_URL = 'https://beam-viewer.pages.dev';

export const USAGE =
  'usage: beam <port> [--allowed-paths /a,/b] [--ttl <seconds>] [--signaling <url>] [--viewer <url>]';

export interface CliOptions {
  readonly port: number;
  readonly allowedPaths: string[];
  readonly ttlMs?: number;
  readonly signalingUrl?: string;
  readonly viewerUrl?: string;
}

export interface CliUsageError {
  readonly error: 'CliUsage';
  readonly message: string;
}

function usage(message: string): CliUsageError {
  return { error: 'CliUsage', message };
}

function parsePort(raw: string | undefined): Parsed<number> {
  if (raw === undefined) {
    return pErr(usage('missing required <port> argument'));
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return pErr(usage(`invalid port "${raw}" — expected an integer 1..65535`));
  }
  return pOk(port);
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
      },
      allowPositionals: true,
    });
  } catch {
    return pErr(usage('unrecognized arguments'));
  }
  const port = parsePort(parsed.positionals[0]);
  if (!port.ok) {
    return port;
  }
  const ttl = parseTtl(parsed.values.ttl);
  if (!ttl.ok) {
    return ttl;
  }
  const allowedRaw = parsed.values['allowed-paths'];
  const allowedPaths = allowedRaw ? allowedRaw.split(',').map((p) => p.trim()).filter((p) => p.length > 0) : [];
  const base: CliOptions = {
    port: port.value,
    allowedPaths,
    ...(ttl.value !== undefined && { ttlMs: ttl.value }),
    ...(parsed.values.signaling !== undefined && { signalingUrl: parsed.values.signaling }),
    ...(parsed.values.viewer !== undefined && { viewerUrl: parsed.values.viewer }),
  };
  return pOk(base);
}

export function securityBanner(options: CliOptions): string {
  const scope =
    options.allowedPaths.length > 0
      ? `Only these paths are exposed: ${options.allowedPaths.join(', ')}`
      : `Every route on port ${String(options.port)} is reachable by anyone with the link.`;
  return [
    '⚠  Beam is about to expose your local server.',
    `   Port: localhost:${String(options.port)}`,
    `   ${scope}`,
    '   Anyone holding the session link can send requests for the life of the session.',
    '   Press Ctrl-C to stop.',
  ].join('\n');
}

export interface CliIO {
  write(line: string): void;
  error(line: string): void;
  onSigint(handler: () => void): void;
  composeRuntime(options: HostOptions): HostRuntime;
}

function defaultIO(): CliIO {
  return {
    write: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    onSigint: (handler) => process.on('SIGINT', handler),
    composeRuntime: (options) => composeHost(options),
  };
}

/**
 * Mint a session code, start the runtime, and print the viewer URL.
 * Runs asynchronously after run() returns — errors are written to io.error,
 * never thrown to the caller.
 */
async function startSession(runtime: HostRuntime, signalingUrl: string, viewerUrl: string, io: CliIO): Promise<void> {
  // ws:// → http://, wss:// → https:// (signaling DO's mint endpoint is HTTP)
  const mintUrl = signalingUrl.replace(/^ws(s?):\/\//, 'http$1://');
  let code: string;
  try {
    const resp = await fetch(mintUrl, { method: 'POST' });
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
  } catch (err) {
    io.error(`signaling unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const started = await runtime.start(code);
  if (!started.ok) {
    io.error(`session start failed: ${JSON.stringify(started.error)}`);
    return;
  }

  io.write(`\nSession: ${viewerUrl}/?signaling=${signalingUrl}/${code}`);
  io.write('Open the URL above in Chrome. Press Ctrl-C to stop.');
}

/**
 * Parse, warn, compose, wire teardown, and fire the async session-start.
 * Returns a synchronous exit code — the session-start runs in the background
 * (void) and is verified end-to-end at S18.
 */
export function run(argv: readonly string[], io: CliIO = defaultIO()): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error.message);
    io.error(USAGE);
    return 2;
  }
  const options = parsed.value;
  io.write(securityBanner(options));
  const signalingUrl = options.signalingUrl ?? DEFAULT_SIGNALING_URL;
  const viewerUrl = options.viewerUrl ?? DEFAULT_VIEWER_URL;
  const baseOptions = { localPort: options.port, signalingUrl, allowedPaths: options.allowedPaths };
  const hostOptions: HostOptions = options.ttlMs === undefined ? baseOptions : { ...baseOptions, ttlMs: options.ttlMs };
  const runtime = io.composeRuntime(hostOptions);
  io.onSigint(() => {
    void runtime.close('host interrupted (SIGINT)');
  });
  void startSession(runtime, signalingUrl, viewerUrl, io);
  return 0;
}
