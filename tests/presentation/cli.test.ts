import { describe, expect, it } from 'vitest';
import { ok, type Result, type SignalingNotConnectedError } from '../../src/domain/interfaces.js';
import type { HostOptions, HostRuntime } from '../../src/composition.js';
import type { StartSessionError } from '../../src/application/session-use-case.js';
import { ExecuteSessionUseCase } from '../../src/application/session-use-case.js';
import { QueryDiagnosticsUseCase } from '../../src/application/diagnostics-use-case.js';
import {
  type CliIO,
  parseCliArgs,
  parseLocalUrl,
  run,
  securityBanner,
  USAGE,
} from '../../src/presentation/cli.js';

describe('parseCliArgs', () => {
  it('parses with no arguments (URL is prompted separately)', () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedPaths).toEqual([]);
      expect(result.value.ttlMs).toBeUndefined();
    }
  });

  it('parses --allowed-paths into a trimmed list', () => {
    const result = parseCliArgs(['--allowed-paths', '/api, /demo']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedPaths).toEqual(['/api', '/demo']);
    }
  });

  it('parses --ttl seconds into milliseconds', () => {
    const result = parseCliArgs(['--ttl', '60']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ttlMs).toBe(60_000);
    }
  });

  it('rejects an invalid --ttl', () => {
    expect(parseCliArgs(['--ttl', 'soon']).ok).toBe(false);
    expect(parseCliArgs(['--ttl', '0']).ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    expect(parseCliArgs(['--bogus']).ok).toBe(false);
  });
});

describe('parseLocalUrl', () => {
  it('extracts port from a full http URL', () => {
    const r = parseLocalUrl('http://localhost:3000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3000);
  });

  it('extracts port from a bare host:port string', () => {
    const r = parseLocalUrl('localhost:8080');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(8080);
  });

  it('defaults to port 443 for https with no explicit port', () => {
    const r = parseLocalUrl('https://localhost');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(443);
  });

  it('defaults to port 80 for http with no explicit port', () => {
    const r = parseLocalUrl('http://localhost');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(80);
  });

  it('rejects a completely invalid string', () => {
    expect(parseLocalUrl('not a url at all!!!').ok).toBe(false);
  });
});

describe('securityBanner', () => {
  it('warns that every route is reachable when no allow-list is set', () => {
    const banner = securityBanner('http://localhost:3000', []);
    expect(banner).toContain('http://localhost:3000');
    expect(banner).toContain('Every route');
    expect(banner).toContain('Ctrl-C');
  });

  it('lists the allowed paths when --allowed-paths is set', () => {
    const banner = securityBanner('http://localhost:8080', ['/api', '/demo']);
    expect(banner).toContain('Only these paths are exposed: /api, /demo');
    expect(banner).not.toContain('Every route');
  });
});

function fakeRuntime(): { runtime: HostRuntime; closedWith: string[]; pinHashes: string[] } {
  const closedWith: string[] = [];
  const pinHashes: string[] = [];
  const runtime: HostRuntime = {
    start(): Promise<Result<undefined, StartSessionError>> {
      return Promise.resolve(ok());
    },
    close(reason: string): Promise<void> {
      closedWith.push(reason);
      return Promise.resolve();
    },
    registerPin(hash: string): Promise<Result<undefined, SignalingNotConnectedError>> {
      pinHashes.push(hash);
      return Promise.resolve(ok());
    },
    session: new ExecuteSessionUseCase(
      { connect: () => Promise.resolve(ok()), sendMessage: () => Promise.resolve(ok()), onMessage: () => () => undefined, disconnect: () => Promise.resolve(), registerPin: () => Promise.resolve(ok()) },
      () => 0,
    ),
    diagnostics: new QueryDiagnosticsUseCase({
      persistRecord: () => Promise.resolve(),
      fetchRecent: () => Promise.resolve([]),
      findByStreamId: () => Promise.resolve([]),
    }),
  };
  return { runtime, closedWith, pinHashes };
}

function fakeIO(promptUrl = 'http://localhost:3000'): {
  io: CliIO;
  out: string[];
  errs: string[];
  composedWith: HostOptions[];
  fireSigint: () => void;
  closedWith: string[];
  pinHashes: string[];
} {
  const out: string[] = [];
  const errs: string[] = [];
  const composedWith: HostOptions[] = [];
  const sigintHandlers: Array<() => void> = [];
  const { runtime, closedWith, pinHashes } = fakeRuntime();
  const io: CliIO = {
    write: (line) => out.push(line),
    error: (line) => errs.push(line),
    onSigint: (handler) => sigintHandlers.push(handler),
    composeRuntime: (options) => {
      composedWith.push(options);
      return runtime;
    },
    promptLocalUrl: () => Promise.resolve(promptUrl),
    generatePin: () => '847291',
  };
  return { io, out, errs, composedWith, fireSigint: () => sigintHandlers.forEach((h) => h()), closedWith, pinHashes };
}

describe('run', () => {
  it('prints usage to stderr and returns exit code 2 on unrecognized flags, never composing', async () => {
    const { io, errs, composedWith } = fakeIO();
    const code = await run(['--bogus'], io);
    expect(code).toBe(2);
    expect(errs).toContain(USAGE);
    expect(composedWith).toHaveLength(0);
  });

  it('returns exit code 2 and prints usage when the prompted URL is invalid', async () => {
    // '://invalid' contains '://' so parseLocalUrl passes it directly to new URL(), which throws
    const { io, errs, composedWith } = fakeIO('://invalid');
    const code = await run([], io);
    expect(code).toBe(2);
    expect(errs.some((e) => e.includes('invalid URL'))).toBe(true);
    expect(composedWith).toHaveLength(0);
  });

  it('prints the banner, composes with parsed options, registers SIGINT, returns 0', async () => {
    const { io, out, composedWith } = fakeIO();
    const code = await run(['--allowed-paths', '/api', '--ttl', '120'], io);
    expect(code).toBe(0);
    expect(out.some((l) => l.includes('http://localhost:3000'))).toBe(true);
    expect(composedWith).toHaveLength(1);
    expect(composedWith[0]).toMatchObject({ localPort: 3000, allowedPaths: ['/api'], ttlMs: 120_000 });
  });

  it('SIGINT triggers runtime.close', async () => {
    const { io, fireSigint, closedWith } = fakeIO();
    const runPromise = run([], io);
    // promptLocalUrl() is async even with Promise.resolve(); one microtask yield
    // lets run() advance past the await and register the SIGINT handler.
    await Promise.resolve();
    fireSigint();
    await runPromise;
    expect(closedWith).toEqual(['host interrupted (SIGINT)']);
  });
});
