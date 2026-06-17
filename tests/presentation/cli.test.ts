import { describe, expect, it } from 'vitest';
import { ok, type Result } from '../../src/domain/interfaces.js';
import type { HostOptions, HostRuntime } from '../../src/composition.js';
import type { StartSessionError } from '../../src/application/session-use-case.js';
import { ExecuteSessionUseCase } from '../../src/application/session-use-case.js';
import { QueryDiagnosticsUseCase } from '../../src/application/diagnostics-use-case.js';
import {
  type CliIO,
  type CliParseResult,
  type CliUsageError,
  parseCliArgs,
  run,
  securityBanner,
  USAGE,
} from '../../src/presentation/cli.js';

function unwrapErr(result: CliParseResult): CliUsageError | undefined {
  return result.ok ? undefined : result.error;
}

describe('parseCliArgs', () => {
  it('parses a valid port', () => {
    const result = parseCliArgs(['3000']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.port).toBe(3000);
      expect(result.value.allowedPaths).toEqual([]);
      expect(result.value.ttlMs).toBeUndefined();
    }
  });

  it('parses --allowed-paths into a trimmed list', () => {
    const result = parseCliArgs(['3000', '--allowed-paths', '/api, /demo']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedPaths).toEqual(['/api', '/demo']);
    }
  });

  it('parses --ttl seconds into milliseconds', () => {
    const result = parseCliArgs(['3000', '--ttl', '60']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ttlMs).toBe(60_000);
    }
  });

  it('rejects a missing port', () => {
    expect(unwrapErr(parseCliArgs([]))?.error).toBe('CliUsage');
  });

  it('rejects a non-integer / out-of-range port', () => {
    expect(parseCliArgs(['notaport']).ok).toBe(false);
    expect(parseCliArgs(['0']).ok).toBe(false);
    expect(parseCliArgs(['70000']).ok).toBe(false);
  });

  it('rejects an invalid --ttl', () => {
    expect(parseCliArgs(['3000', '--ttl', 'soon']).ok).toBe(false);
    expect(parseCliArgs(['3000', '--ttl', '0']).ok).toBe(false);
  });

  it('rejects an unrecognized flag', () => {
    expect(parseCliArgs(['3000', '--bogus']).ok).toBe(false);
  });
});

describe('securityBanner', () => {
  it('warns that every route is reachable when no allow-list is set', () => {
    const banner = securityBanner({ port: 3000, allowedPaths: [] });
    expect(banner).toContain('localhost:3000');
    expect(banner).toContain('Every route');
    expect(banner).toContain('Ctrl-C');
  });

  it('lists the allowed paths when --allowed-paths is set', () => {
    const banner = securityBanner({ port: 8080, allowedPaths: ['/api', '/demo'] });
    expect(banner).toContain('Only these paths are exposed: /api, /demo');
    expect(banner).not.toContain('Every route');
  });
});

function fakeRuntime(): { runtime: HostRuntime; closedWith: string[] } {
  const closedWith: string[] = [];
  const runtime: HostRuntime = {
    start(): Promise<Result<undefined, StartSessionError>> {
      return Promise.resolve(ok());
    },
    close(reason: string): Promise<void> {
      closedWith.push(reason);
      return Promise.resolve();
    },
    session: new ExecuteSessionUseCase(
      { connect: () => Promise.resolve(ok()), sendMessage: () => Promise.resolve(ok()), onMessage: () => () => undefined, disconnect: () => Promise.resolve() },
      () => 0,
    ),
    diagnostics: new QueryDiagnosticsUseCase({
      persistRecord: () => Promise.resolve(),
      fetchRecent: () => Promise.resolve([]),
      findByStreamId: () => Promise.resolve([]),
    }),
  };
  return { runtime, closedWith };
}

function fakeIO(): {
  io: CliIO;
  out: string[];
  errs: string[];
  composedWith: HostOptions[];
  fireSigint: () => void;
  closedWith: string[];
} {
  const out: string[] = [];
  const errs: string[] = [];
  const composedWith: HostOptions[] = [];
  const sigintHandlers: Array<() => void> = [];
  const { runtime, closedWith } = fakeRuntime();
  const io: CliIO = {
    write: (line) => out.push(line),
    error: (line) => errs.push(line),
    onSigint: (handler) => sigintHandlers.push(handler),
    composeRuntime: (options) => {
      composedWith.push(options);
      return runtime;
    },
  };
  return { io, out, errs, composedWith, fireSigint: () => sigintHandlers.forEach((h) => h()), closedWith };
}

describe('run', () => {
  it('prints usage to stderr and returns exit code 2 on bad args, never composing', async () => {
    const { io, errs, composedWith } = fakeIO();
    const code = await run([], io);
    expect(code).toBe(2);
    expect(errs).toContain(USAGE);
    expect(composedWith).toHaveLength(0);
  });

  it('prints the banner, composes with parsed options, registers SIGINT, returns 0', async () => {
    const { io, out, composedWith } = fakeIO();
    const code = await run(['3000', '--allowed-paths', '/api', '--ttl', '120'], io);
    expect(code).toBe(0);
    expect(out[0]).toContain('localhost:3000');
    expect(composedWith).toHaveLength(1);
    expect(composedWith[0]).toMatchObject({ localPort: 3000, allowedPaths: ['/api'], ttlMs: 120_000 });
  });

  it('SIGINT triggers runtime.close', async () => {
    const { io, fireSigint, closedWith } = fakeIO();
    const runPromise = run(['3000'], io);
    fireSigint();
    await runPromise;
    expect(closedWith).toEqual(['host interrupted (SIGINT)']);
  });
});
