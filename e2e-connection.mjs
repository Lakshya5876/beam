/**
 * Connection-path E2E: proves WHICH ICE path a Beam session actually used,
 * not merely that it connected. Three scenarios, matching the three ways a
 * real session can go:
 *
 *   direct   — normal network. Must connect AND report path=direct, proving
 *              TURN is a fallback rather than the default transport.
 *   relay    — direct connectivity suppressed on BOTH ends
 *              (iceTransportPolicy:'relay'). Must connect, report path=relay,
 *              and carry a real HTTP request to the localhost app through the
 *              relay. Requires a reachable TURN server (see BEAM_E2E_TURN_*).
 *   failure  — relay-only with NO TURN server. Must fail deterministically,
 *              quickly, with a diagnostic that names the stage — and must not
 *              hang or leak.
 *
 * Everything except the TURN server itself runs on 127.0.0.1.
 *
 * Usage:
 *   node e2e-connection.mjs                 # direct + failure
 *   node e2e-connection.mjs --all           # adds the relay scenario
 *   BEAM_E2E_BROWSER=edge node e2e-connection.mjs
 *
 * The relay scenario needs a TURN server Beam can mint from. Point the local
 * signaling worker at one:
 *   BEAM_E2E_TURN_APP=<metered-app> BEAM_E2E_TURN_SECRET=<secret> \
 *     node e2e-connection.mjs --all
 */

import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { enterPin, freePort, resolveBrowser, startHost, startSignaling, startViewerServer } from './e2e-lib.mjs';

const MAGIC = 'BEAM_CONNECTION_OK';

function startDummy(DP) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(MAGIC.length) });
      res.end(MAGIC);
    });
    server.listen(DP, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Wait for a TERMINAL outcome, then read the viewer's own connection facts
 * (window.__beamConnection, a live view — see bootstrap.ts). Terminal means
 * either the relay came up, or a failure was rendered; the failure message
 * always carries a "[stage: …]" tag, which is what makes it detectable.
 */
async function readFacts(page, { timeoutMs = 25000 } = {}) {
  return page
    .waitForFunction(
      () => window.__beamConnection?.reachedStage === 'relay-ready' || /\[stage: /.test(document.body.innerText),
      { timeout: timeoutMs, polling: 250 },
    )
    .then(() => page.evaluate(() => window.__beamConnection))
    .catch(() => page.evaluate(() => window.__beamConnection ?? null));
}

async function runScenario({ name, relayOnly, turnEnv, expect: expected, log }) {
  const cleanup = [];
  const fail = (msg) => { console.log(`  ✗ ${msg}`); return false; };
  try {
    // Fresh ports per scenario: fixed ones collide with unrelated local
    // servers and with the previous scenario's sockets still in TIME_WAIT.
    const [SP, VP, DP] = [await freePort(), await freePort(), await freePort()];
    const viewerSrv = await startViewerServer(VP); cleanup.push(() => viewerSrv.close());
    const dummySrv = await startDummy(DP); cleanup.push(() => dummySrv.close());
    const wr = await startSignaling(SP, { env: turnEnv }); cleanup.push(() => { try { wr.kill(); } catch {} });
    await new Promise((r) => setTimeout(r, 3000));

    const host = await startHost({
      localPort: DP,
      signalingPort: SP,
      viewerPort: VP,
      log,
      // The host must suppress direct candidates too — forcing only the
      // browser would still let ICE nominate a direct pair from the host side.
      env: relayOnly ? { BEAM_ICE_TRANSPORT_POLICY: 'relay' } : {},
    });
    cleanup.push(() => host.kill());

    const browser = await puppeteer.launch({
      executablePath: resolveBrowser(),
      headless: true,
      protocolTimeout: 60000,
      args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    cleanup.push(() => browser.close());

    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  [BROWSER-ERR] ${e.message}`));
    const url = relayOnly ? `${host.url}&relay=1` : host.url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await enterPin(page, host.pin);

    // The failure path must wait past the viewer's own connect timeout
    // (CONNECT_TIMEOUT_MS) — that bound is precisely what is under test.
    const facts = await readFacts(page, { timeoutMs: expected.connects ? 30000 : 60000 });
    if (!facts) return fail('viewer never published connection facts (hung?)');
    console.log(`  facts: stage=${facts.reachedStage} path=${facts.selectedPath} turn=${facts.turnDiagnostic ?? 'n/a'} relayOnly=${facts.relayOnlyRequested}`);

    if (!expected.connects) {
      // Failure path: must be a clean, attributed failure — not a hang.
      const body = await page.evaluate(() => document.body.innerText);
      if (facts.reachedStage === 'relay-ready') return fail('expected failure, but the relay came up');
      if (!/\[stage: /.test(body)) return fail(`failure message lacks a stage tag: "${body.slice(0, 140)}"`);
      console.log(`  ✓ ${name}: deterministic failure — "${body.slice(0, 120)}"`);
      return true;
    }

    if (facts.reachedStage !== 'relay-ready') return fail(`stalled at stage=${facts.reachedStage}`);
    if (facts.selectedPath !== expected.path) return fail(`expected path=${expected.path}, got ${facts.selectedPath}`);

    // Prove the tunnel actually carries traffic over whichever path won.
    await new Promise((r) => setTimeout(r, 800));
    const relayed = await page.evaluate(async () => {
      try {
        const res = await fetch('/connection-probe', { cache: 'no-store' });
        return { ok: res.ok, body: await res.text() };
      } catch (e) {
        return { ok: false, body: String(e) };
      }
    });
    if (!relayed.ok || relayed.body !== MAGIC) return fail(`relayed request failed: ${JSON.stringify(relayed).slice(0, 160)}`);

    console.log(`  ✓ ${name}: path=${facts.selectedPath}, HTTP relayed through it`);
    return true;
  } catch (e) {
    return fail(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function main() {
  const runAll = process.argv.includes('--all');
  const verbose = process.argv.includes('--verbose');
  const log = verbose ? (line) => console.log(`  [HOST] ${line}`) : () => {};
  const turnApp = process.env.BEAM_E2E_TURN_APP;
  const turnSecret = process.env.BEAM_E2E_TURN_SECRET;

  const results = [];

  console.log('\n[1/3] DIRECT — a normal network must NOT be relayed');
  results.push(['direct', await runScenario({
    name: 'direct', relayOnly: false, turnEnv: {}, log,
    expect: { connects: true, path: 'direct' },
  })]);

  console.log('\n[2/3] FAILURE — relay-only with no TURN server must fail cleanly');
  results.push(['failure', await runScenario({
    name: 'failure', relayOnly: true, turnEnv: {}, log,
    expect: { connects: false },
  })]);

  console.log('\n[3/3] RELAY — TURN must carry a real Beam session');
  if (!runAll) {
    console.log('  ⊘ skipped (pass --all to run)');
  } else if (!turnApp || !turnSecret) {
    console.log('  ⊘ SKIPPED: needs a real TURN server.');
    console.log('    BEAM_E2E_TURN_APP=<metered-app> BEAM_E2E_TURN_SECRET=<secret> node e2e-connection.mjs --all');
    console.log('    Without it this scenario is NOT proven — do not report TURN as verified.');
    results.push(['relay', null]);
  } else {
    results.push(['relay', await runScenario({
      name: 'relay', relayOnly: true, log,
      turnEnv: { METERED_APP_NAME: turnApp, METERED_SECRET_KEY: turnSecret },
      expect: { connects: true, path: 'relay' },
    })]);
  }

  console.log('\n--- summary ---');
  let failed = 0;
  for (const [name, ok] of results) {
    console.log(`  ${ok === null ? '⊘ SKIP' : ok ? '✓ PASS' : '✗ FAIL'}  ${name}`);
    if (ok === false) failed += 1;
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
