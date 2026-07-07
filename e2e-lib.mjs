/**
 * Shared helpers for the LOCAL e2e harness scripts (e2e-smoke.mjs,
 * e2e-stress*.mjs, scripts/e2e-loop.sh). Everything binds 127.0.0.1 only —
 * no network egress. Kept in sync with the REAL CLI output format and the
 * viewer's PIN gate; if either changes, fix it here once.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CHROME = process.env.BEAM_E2E_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

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

/** Local signaling worker via `wrangler dev --local` (no cloud resources). */
export function startSignaling(port, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const wrangler = spawn(
      path.join(ROOT, 'signaling/node_modules/.bin/wrangler'),
      ['dev', '--config', path.join(ROOT, 'signaling/wrangler.jsonc'), '--port', String(port), '--local', '--log-level', 'warn'],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } },
    );
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
export function startHost({ localPort, signalingPort, viewerPort, extraArgs = [], log = () => {}, timeoutMs = 25000 }) {
  // Ad-hoc host flags for experiments, e.g. BEAM_E2E_HOST_ARGS="--ipv4-only"
  const envArgs = (process.env.BEAM_E2E_HOST_ARGS ?? '').split(/\s+/).filter((a) => a.length > 0);
  extraArgs = [...extraArgs, ...envArgs];
  return new Promise((resolve, reject) => {
    const logs = [];
    // detached → own process group. The tsx bin is a shim that forks the real
    // node process; killing only the shim orphans the CLI, and the zombie
    // hosts keep live ICE agents that make later runs flaky. kill() below
    // signals the WHOLE group (negative pid).
    const proc = spawn(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      [
        'src/presentation/cli.ts', String(localPort),
        '--signaling', `ws://localhost:${signalingPort}`,
        '--viewer', `http://localhost:${viewerPort}`,
        '--debug',
        ...extraArgs,
      ],
      { cwd: ROOT, detached: true },
    );
    const killGroup = () => {
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
 * ready ("Connected — ready to relay."). Assumes page.goto() already ran.
 */
export async function enterPinAndConnect(page, pin, { pinTimeoutMs = 10000, connectTimeoutMs = 20000 } = {}) {
  await enterPin(page, pin, { timeoutMs: pinTimeoutMs });
  const connected = await page
    .waitForFunction(() => document.body?.innerText?.includes('Connected'), { timeout: connectTimeoutMs })
    .then(() => true)
    .catch(() => false);
  return connected;
}
