/**
 * Shared helpers for the LOCAL e2e harness scripts (e2e-smoke.mjs,
 * e2e-stress*.mjs, scripts/e2e-loop.sh). Everything binds 127.0.0.1 only —
 * no network egress. Kept in sync with the REAL CLI output format and the
 * viewer's PIN gate; if either changes, fix it here once.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browsers to drive the viewer with, per platform. Beam targets Windows and
 * macOS equally, so the harness must not hardcode either one's paths — the
 * previous macOS-only constant meant the suite could not run on Windows at
 * all. BEAM_E2E_CHROME still overrides everything, and BEAM_E2E_BROWSER picks
 * a specific channel by name ('chrome' | 'edge').
 */
const BROWSER_CANDIDATES = {
  win32: {
    chrome: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ],
    edge: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
  },
  darwin: {
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    edge: ['/usr/bin/microsoft-edge'],
  },
};

/** Resolve an installed browser executable, or throw with what was tried. */
export function resolveBrowser(channel = process.env.BEAM_E2E_BROWSER ?? 'chrome') {
  if (process.env.BEAM_E2E_CHROME) return process.env.BEAM_E2E_CHROME;
  const forPlatform = BROWSER_CANDIDATES[process.platform];
  if (!forPlatform) throw new Error(`unsupported platform for e2e: ${process.platform}`);
  const candidates = forPlatform[channel];
  if (!candidates) throw new Error(`unknown browser channel "${channel}" (expected: ${Object.keys(forPlatform).join(', ')})`);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no ${channel} found. Tried:\n  ${candidates.join('\n  ')}\nSet BEAM_E2E_CHROME to override.`);
}

/** Lazy so importing this module on a machine without Chrome does not throw. */
export const CHROME = process.env.BEAM_E2E_CHROME ?? (() => {
  try { return resolveBrowser(); } catch { return null; }
})();

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

/**
 * Reserve a free loopback port by binding one and releasing it.
 *
 * Fixed ports made the suite collide with anything else on the machine —
 * 8788 in particular is the Cloudflare Pages dev default, so an unrelated
 * project's `wrangler dev` makes Beam's E2E fail with EADDRINUSE before any
 * Beam code runs. There is an inherent race between release and re-bind, but
 * it is far smaller than the collision risk of well-known fixed ports.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Static server for viewer/dist with the Service-Worker-Allowed header. */
export function startViewerServer(port) {
  return new Promise((resolve, reject) => {
    const dist = path.join(ROOT, 'viewer', 'dist');
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(dist, urlPath);
      if (!filePath.startsWith(dist)) { res.writeHead(403); res.end(); return; }
      let data;
      try { data = fs.readFileSync(filePath); } catch { res.writeHead(404); res.end('not found'); return; }
      const headers = { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' };
      if (urlPath === '/__beam/sw.js') {
        headers['Service-Worker-Allowed'] = '/';
        headers['Cache-Control'] = 'no-cache';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Resolve a package-local binary. npm installs Windows shims as `.cmd`; the
 * extensionless file next to them is a shell script Windows cannot execute.
 */
export function binPath(relativeDir, name) {
  const base = path.join(ROOT, relativeDir, '.bin', name);
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

/** Local signaling worker via `wrangler dev --local` (no cloud resources). */
export function startSignaling(port, { log = () => {}, env: extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const wrangler = spawn(
      binPath('signaling/node_modules', 'wrangler'),
      ['dev', '--config', path.join(ROOT, 'signaling/wrangler.jsonc'), '--port', String(port), '--local', '--log-level', 'warn'],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', ...extraEnv }, shell: process.platform === 'win32' },
    );
    // `wrangler` is a shim that forks the real worker process. On Windows
    // ChildProcess.kill() reaps only the shim, leaving the worker LISTENING on
    // the port — later runs then die with EADDRINUSE and the machine collects
    // orphans. taskkill /T walks the whole child tree.
    if (process.platform === 'win32') {
      wrangler.kill = () => {
        try { spawn('taskkill', ['/pid', String(wrangler.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
        return true;
      };
    }
    let ready = false;
    const onData = (chunk) => {
      const line = String(chunk);
      log(line.trim());
      if (!ready && (line.includes(`localhost:${port}`) || line.includes('Ready on'))) {
        ready = true;
        resolve(wrangler);
      }
    };
    wrangler.stdout.on('data', onData);
    wrangler.stderr.on('data', onData);
    setTimeout(() => { if (!ready) { ready = true; resolve(wrangler); } }, 12000);
    wrangler.on('error', reject);
  });
}

/**
 * Parse the CLI's startup output. Current format (src/presentation/cli.ts):
 *   Viewer URL:   http://localhost:8788/?signaling=ws://localhost:8081/<code>
 *   Session code: 847 291
 * Returns { url, pin } once both have appeared, else null.
 */
export function parseHostStart(text) {
  const urlMatch = /Viewer URL:\s*(\S+)/.exec(text);
  const pinMatch = /Session code:\s*([\d ]{6,8})/.exec(text);
  if (!urlMatch || !pinMatch) return null;
  return { url: urlMatch[1], pin: pinMatch[1].replace(/\s/g, '') };
}

/**
 * Start the host CLI (tsx, so it runs from source). Resolves with
 * { proc, url, pin, logs } once the session URL and PIN are printed.
 */
export function startHost({ localPort, signalingPort, viewerPort, extraArgs = [], log = () => {}, timeoutMs = 25000, env: extraEnv = {} }) {
  // Ad-hoc host flags for experiments, e.g. BEAM_E2E_HOST_ARGS="--ipv4-only"
  const envArgs = (process.env.BEAM_E2E_HOST_ARGS ?? '').split(/\s+/).filter((a) => a.length > 0);
  extraArgs = [...extraArgs, ...envArgs];
  return new Promise((resolve, reject) => {
    const logs = [];
    const isWindows = process.platform === 'win32';
    // POSIX: detached → own process group. The tsx bin is a shim that forks
    // the real node process; killing only the shim orphans the CLI, and the
    // zombie hosts keep live ICE agents that make later runs flaky, so kill()
    // signals the WHOLE group (negative pid). Windows has no process groups
    // in that sense — taskkill /T walks the child tree instead.
    const proc = spawn(
      binPath('node_modules', 'tsx'),
      [
        'src/presentation/cli.ts', String(localPort),
        '--signaling', `ws://localhost:${signalingPort}`,
        '--viewer', `http://localhost:${viewerPort}`,
        '--debug',
        ...extraArgs,
      ],
      { cwd: ROOT, detached: !isWindows, shell: isWindows, env: { ...process.env, ...extraEnv } },
    );
    const killGroup = () => {
      if (isWindows) {
        try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
        return;
      }
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
    };
    let buffer = '';
    let settled = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      buffer += text;
      for (const line of text.split('\n')) {
        if (line.trim()) log(line.trim());
      }
      const parsed = parseHostStart(buffer);
      if (parsed && !settled) {
        settled = true;
        resolve({ proc, url: parsed.url, pin: parsed.pin, logs, kill: killGroup });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        killGroup();
        reject(new Error(`host: no session URL + PIN within ${timeoutMs}ms.\n--- host output ---\n${buffer}`));
      }
    }, timeoutMs);
    proc.on('error', reject);
  });
}

/** Submit the viewer PIN form (no wait for connection). */
export async function enterPin(page, pin, { timeoutMs = 10000 } = {}) {
  await page.waitForSelector('#beam-pin', { timeout: timeoutMs });
  await page.type('#beam-pin', pin);
  await page.click('#beam-pin-form button[type=submit]');
}

/**
 * Drive the viewer page through the PIN gate and wait for the relay to be
 * ready. Assumes page.goto() already ran.
 *
 * Readiness is taken from window.__beamConnection (see viewer bootstrap.ts),
 * NOT from page text. The previous text probe looked for "Connected" in the
 * body, which the iframe shell removed — once connected, the body IS the
 * tunneled app, so the probe could never match and every run reported a
 * failed connection even while the relay was demonstrably working.
 */
export async function enterPinAndConnect(page, pin, { pinTimeoutMs = 10000, connectTimeoutMs = 20000 } = {}) {
  await enterPin(page, pin, { timeoutMs: pinTimeoutMs });
  return page
    .waitForFunction(() => window.__beamConnection?.reachedStage === 'relay-ready', {
      timeout: connectTimeoutMs,
      polling: 250,
    })
    .then(() => true)
    .catch(() => false);
}
