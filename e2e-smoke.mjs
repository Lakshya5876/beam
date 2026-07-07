/**
 * Lightweight E2E smoke test: confirm a SW-intercepted fetch() makes the
 * full round-trip through the Beam relay (SW → bootstrap → mux → host →
 * localhost) — including the PIN gate the viewer shows before connecting.
 *
 * Everything runs on 127.0.0.1 (wrangler dev --local, static viewer server,
 * dummy target, host CLI, headless Chrome). No network egress.
 *
 * Usage: node e2e-smoke.mjs
 * Loop:  bash scripts/e2e-loop.sh [iterations]
 */

import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { CHROME, enterPinAndConnect, startHost, startSignaling, startViewerServer } from './e2e-lib.mjs';

const SP = 8081; const VP = 8788; const DP = 3000;
const MAGIC = 'BEAM_SMOKE_OK_1234';

function startDummy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      console.log(`  [DUMMY] ${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(MAGIC.length) });
      res.end(MAGIC);
    });
    server.listen(DP, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function main() {
  const cleanup = [];

  try {
    console.log('[SMOKE] starting stack…');
    const viewerSrv = await startViewerServer(VP); cleanup.push(() => viewerSrv.close());
    const dummySrv = await startDummy();           cleanup.push(() => dummySrv.close());
    const wr = await startSignaling(SP);           cleanup.push(() => { try { wr.kill(); } catch {} });
    await new Promise((r) => setTimeout(r, 3000)); // wrangler DO warm-up

    const host = await startHost({
      localPort: DP,
      signalingPort: SP,
      viewerPort: VP,
      log: (line) => console.log(`  [HOST] ${line}`),
    });
    cleanup.push(() => host.kill());
    console.log(`[SMOKE] session URL: ${host.url} pin: ${host.pin}`);

    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      protocolTimeout: 60000,
      args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    cleanup.push(() => browser.close());

    const page = await browser.newPage();
    page.on('console', (m) => console.log(`  [BROWSER] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`  [BROWSER-ERR] ${e.message}`));

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // PIN gate, then wait for DC open + mux ready
    const connected = await enterPinAndConnect(page, host.pin);
    if (!connected) {
      console.log('[SMOKE] FAIL — viewer did not reach Connected state after PIN');
      process.exitCode = 1;
      return;
    }
    console.log('[SMOKE] viewer Connected ✓ — waiting for SW to activate…');

    // Give the SW a moment to claim the page after mux-ready
    await new Promise((r) => setTimeout(r, 800));

    // Issue a fetch() — intercepted by the SW and relayed through the DataChannel
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/smoke-test', { cache: 'no-store' });
        const text = await res.text();
        return { status: res.status, body: text, ok: res.ok };
      } catch (e) {
        return { status: 0, body: '', ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    });

    if (result.ok && result.body === MAGIC) {
      console.log(`[SMOKE] PASS ✓ — fetch /smoke-test → HTTP ${result.status} body="${result.body}"`);
    } else {
      console.log(`[SMOKE] FAIL ✗ — status=${result.status} ok=${String(result.ok)} body="${result.body}" error=${result.error ?? ''}`);
      process.exitCode = 1;
    }

  } catch (e) {
    // Without this, a setup throw would hit finally's process.exit(0) and
    // report success — the exact failure-swallowing this harness hunts for.
    console.error('[SMOKE] FATAL:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
    await new Promise((r) => setTimeout(r, 500));
    process.exit(process.exitCode ?? 0);
  }
}

main();
