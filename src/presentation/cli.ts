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
  'usage: bm [--allowed-paths /a,/b] [--ttl <seconds>] [--signaling <url>] [--viewer <url>]';

export interface CliOptions {
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
      allowPositionals: false,
    });
  } catch {
    return pErr(usage('unrecognized arguments'));
  }
  const ttl = parseTtl(parsed.values.ttl);
  if (!ttl.ok) {
    return ttl;
  }
  const allowedRaw = parsed.values['allowed-paths'];
  const allowedPaths = allowedRaw ? allowedRaw.split(',').map((p) => p.trim()).filter((p) => p.length > 0) : [];
  const base: CliOptions = {
    allowedPaths,
    ...(ttl.value !== undefined && { ttlMs: ttl.value }),
    ...(parsed.values.signaling !== undefined && { signalingUrl: parsed.values.signaling }),
    ...(parsed.values.viewer !== undefined && { viewerUrl: parsed.values.viewer }),
  };
  return pOk(base);
}

/** Parse a user-typed local URL string → port number. Accepts bare host:port too. */
export function parseLocalUrl(raw: string): Parsed<number> {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return pErr(usage(`invalid URL "${raw}" — expected e.g. http://localhost:3000`));
  }
  const portStr = url.port;
  const port = portStr ? Number(portStr) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
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
): Promise<void> {
  const baseUrl = signalingUrl.replace(/^ws(s?):\/\//, 'http$1://');
  const mintUrl = new URL('/new', baseUrl).href;
  let code: string;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
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

  const sessionUrl = `${viewerUrl}/?signaling=${signalingUrl}/${code}`;
  const formattedPin = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  io.write('');
  io.write(`  Viewer URL:   ${sessionUrl}`);
  io.write(`  Session code: ${formattedPin}`);
  io.write('');
  io.write('  Share both with your viewer. Press Ctrl-C to end the session.');
  io.write('');
}

/**
 * Parse flags, prompt for local URL, generate PIN, compose runtime, start session.
 */
export async function run(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error.message);
    io.error(USAGE);
    return 2;
  }
  const options = parsed.value;

  const rawUrl = await io.promptLocalUrl();
  const portResult = parseLocalUrl(rawUrl);
  if (!portResult.ok) {
    io.error(portResult.error.message);
    io.error(USAGE);
    return 2;
  }
  const port = portResult.value;

  io.write(securityBanner(rawUrl, options.allowedPaths));

  const pin = io.generatePin();
  const signalingUrl = options.signalingUrl ?? DEFAULT_SIGNALING_URL;
  const viewerUrl = options.viewerUrl ?? DEFAULT_VIEWER_URL;
  const baseOptions = { localPort: port, signalingUrl, allowedPaths: options.allowedPaths };
  const hostOptions: HostOptions = options.ttlMs === undefined ? baseOptions : { ...baseOptions, ttlMs: options.ttlMs };
  const runtime = io.composeRuntime(hostOptions);
  io.onSigint(() => {
    void runtime.close('host interrupted (SIGINT)');
  });
  await startSession(runtime, signalingUrl, viewerUrl, pin, io);
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
