/**
 * CLI entry (design doc §10 S12, §A.3 consent). Presentation layer:
 * arg parsing + output formatting only; it composes via the composition root
 * and drives application use-cases — never infrastructure/domain concretes.
 *
 * NOTE: the live session start needs the signaling server (S14) to assign the
 * session code, and the end-to-end run is verified at S18. S12b delivers the
 * deterministic surface — arg parsing, the consent banner, composition wiring,
 * and SIGINT teardown — all unit-tested here without the network.
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

// The deployed signaling endpoint is finalized when S14/S17 land; a constant
// default keeps the CLI dependency- and env-free for now.
export const DEFAULT_SIGNALING_URL = 'wss://signal.beam.workers.dev';

export const USAGE = 'usage: beam <port> [--allowed-paths /a,/b] [--ttl <seconds>]';

export interface CliOptions {
  readonly port: number;
  readonly allowedPaths: string[];
  readonly ttlMs?: number;
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
      options: { 'allowed-paths': { type: 'string' }, ttl: { type: 'string' } },
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
  const base = { port: port.value, allowedPaths };
  return pOk(ttl.value === undefined ? base : { ...base, ttlMs: ttl.value });
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
 * Parse, warn, compose, and wire teardown. Returns a process exit code.
 * The live session start (awaiting a server-assigned code) is wired in at
 * S17 and verified end-to-end at S18.
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
  const baseOptions = { localPort: options.port, signalingUrl: DEFAULT_SIGNALING_URL, allowedPaths: options.allowedPaths };
  const hostOptions: HostOptions = options.ttlMs === undefined ? baseOptions : { ...baseOptions, ttlMs: options.ttlMs };
  const runtime = io.composeRuntime(hostOptions);
  io.onSigint(() => {
    void runtime.close('host interrupted (SIGINT)');
  });
  return 0;
}
