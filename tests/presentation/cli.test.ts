import { describe, expect, it } from 'vitest';
import { ok, type Result, type SignalingNotConnectedError } from '../../src/domain/interfaces.js';
import type { HostOptions, HostRuntime } from '../../src/composition.js';
import type { StartSessionError } from '../../src/application/session-use-case.js';
import { ExecuteSessionUseCase } from '../../src/application/session-use-case.js';
import { QueryDiagnosticsUseCase } from '../../src/application/diagnostics-use-case.js';
import {
  type CliIO,
  DEFAULT_SIGNALING_URL,
  DEFAULT_VIEWER_URL,
  parseCliArgs,
  parseLocalUrl,
  resolveEndpoints,
  run,
  securityBanner,
  USAGE,
} from '../../src/presentation/cli.js';
import { loadConfig } from '../../src/config.js';

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

  it('accepts a local URL as a positional argument', () => {
    const result = parseCliArgs(['http://localhost:3000']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.localUrl).toBe('http://localhost:3000');
    }
  });

  it('accepts a bare port as a positional argument', () => {
    const result = parseCliArgs(['3000']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.localUrl).toBe('3000');
    }
  });

  it('accepts a positional URL alongside other flags', () => {
    const result = parseCliArgs(['localhost:4000', '--ttl', '120', '--allowed-paths', '/api']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.localUrl).toBe('localhost:4000');
      expect(result.value.ttlMs).toBe(120_000);
      expect(result.value.allowedPaths).toEqual(['/api']);
    }
  });

  it('rejects more than one positional argument', () => {
    expect(parseCliArgs(['3000', '4000']).ok).toBe(false);
  });

  it('sets localUrl undefined when no positional given', () => {
    const result = parseCliArgs(['--ttl', '10']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.localUrl).toBeUndefined();
    }
  });

  it('sets debug true when --debug is passed', () => {
    const result = parseCliArgs(['--debug']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.debug).toBe(true);
    }
  });

  it('parses --ice as a comma-separated server list', () => {
    const result = parseCliArgs(['--ice', 'stun:s.example.com:3478,turn:u:p@t.example.com:3478']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.iceServers).toEqual(['stun:s.example.com:3478', 'turn:u:p@t.example.com:3478']);
    }
  });

  it('omits iceServers when --ice is not passed', () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.iceServers).toBeUndefined();
    }
  });

  it('sets ipv4Only true when --ipv4-only is passed', () => {
    const result = parseCliArgs(['--ipv4-only']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ipv4Only).toBe(true);
    }
  });

  it('ipv4Only is absent when --ipv4-only is not passed', () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ipv4Only).toBeUndefined();
    }
  });

  it('debug is absent when --debug is not passed', () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.debug).toBeUndefined();
    }
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

  it('treats a bare numeric string as a PORT, not an IPv4 integer address', () => {
    // Regression: new URL('http://3000') is host 0.0.11.184 port 80 —
    // `bm 3000` relayed to :80. The bare-port form must mean port 3000.
    const r = parseLocalUrl('3000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3000);
  });

  it('rejects a bare numeric port out of range', () => {
    expect(parseLocalUrl('0').ok).toBe(false);
    expect(parseLocalUrl('65536').ok).toBe(false);
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

describe('resolveEndpoints — flag > env > compiled default', () => {
  const noFlags = { allowedPaths: [] };

  it('falls back to compiled defaults when neither flag nor env is set', () => {
    const resolved = resolveEndpoints(noFlags, loadConfig({}));
    expect(resolved.signalingUrl).toBe(DEFAULT_SIGNALING_URL);
    expect(resolved.viewerUrl).toBe(DEFAULT_VIEWER_URL);
    expect(resolved.iceServers).toBeUndefined();
    expect(resolved.mintTimeoutMs).toBe(5000);
  });

  it('env overrides compiled defaults', () => {
    const resolved = resolveEndpoints(
      noFlags,
      loadConfig({
        BEAM_SIGNALING_URL: 'wss://env.example.com',
        BEAM_VIEWER_URL: 'https://env-view.example.com',
        BEAM_ICE_SERVERS: 'stun:env.example.com:3478',
      }),
    );
    expect(resolved.signalingUrl).toBe('wss://env.example.com');
    expect(resolved.viewerUrl).toBe('https://env-view.example.com');
    expect(resolved.iceServers).toEqual(['stun:env.example.com:3478']);
  });

  it('CLI flags override env', () => {
    const resolved = resolveEndpoints(
      {
        allowedPaths: [],
        signalingUrl: 'wss://flag.example.com',
        viewerUrl: 'https://flag-view.example.com',
        iceServers: ['stun:flag.example.com:3478'],
      },
      loadConfig({
        BEAM_SIGNALING_URL: 'wss://env.example.com',
        BEAM_VIEWER_URL: 'https://env-view.example.com',
        BEAM_ICE_SERVERS: 'stun:env.example.com:3478',
      }),
    );
    expect(resolved.signalingUrl).toBe('wss://flag.example.com');
    expect(resolved.viewerUrl).toBe('https://flag-view.example.com');
    expect(resolved.iceServers).toEqual(['stun:flag.example.com:3478']);
  });
});
