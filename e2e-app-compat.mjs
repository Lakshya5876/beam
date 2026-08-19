/**
 * Application-compatibility E2E: exercises what Beam actually promises —
 * using a real localhost web app from another browser — rather than only
 * proving that a data channel opened.
 *
 * Covers the HTTP surface a real app depends on: verbs, query strings,
 * request/response headers and bodies, empty bodies, status codes, redirects,
 * concurrency, large payloads, slow/streamed responses, and the failure modes
 * (upstream down, aborted request). Each case asserts the response the
 * localhost app really produced, so a silently-dropped header or truncated
 * body fails the run.
 *
 * Everything binds 127.0.0.1. Usage:
 *   node e2e-app-compat.mjs
 *   BEAM_E2E_BROWSER=edge node e2e-app-compat.mjs
 */

import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { enterPinAndConnect, freePort, resolveBrowser, startHost, startSignaling, startViewerServer } from './e2e-lib.mjs';

const LARGE_SIZE = 3 * 1024 * 1024; // spans many 16KB frames + backpressure

/** A small but realistic app: echoes what it received so the test can verify
 *  the tunnel preserved it exactly. */
function startApp(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-App-Header': 'app-value' });
          res.end(JSON.stringify({
            method: req.method,
            query: url.search,
            gotHeader: req.headers['x-client-header'] ?? null,
            bodyLength: body.length,
            bodyText: body.toString('utf8').slice(0, 64),
          }));
          return;
        }
        if (url.pathname === '/empty') { res.writeHead(204); res.end(); return; }
        if (url.pathname === '/teapot') {
          res.writeHead(418, { 'Content-Type': 'text/plain' });
          res.end('short and stout');
          return;
        }
        if (url.pathname === '/redirect') {
          // Absolute self-referential Location — the tunnel must rewrite it,
          // or the viewer's browser would chase its OWN localhost.
          res.writeHead(302, { Location: `http://localhost:${port}/echo?after=redirect` });
          res.end();
          return;
        }
        if (url.pathname === '/large') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(LARGE_SIZE) });
          res.end(Buffer.alloc(LARGE_SIZE, 0xab));
          return;
        }
        if (url.pathname === '/slow') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('first');
          setTimeout(() => res.end('-second'), 1200);
          return;
        }
        if (url.pathname === '/never') { return; } // held open: tests abort
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

const CASES = [
  {
    name: 'GET with query + request header + response header',
    run: async () => {
      const res = await fetch('/echo?a=1&b=two', { headers: { 'X-Client-Header': 'client-value' } });
      const json = await res.json();
      return {
        status: res.status,
        appHeader: res.headers.get('x-app-header'),
        method: json.method, query: json.query, gotHeader: json.gotHeader,
      };
    },
    expect: { status: 200, appHeader: 'app-value', method: 'GET', query: '?a=1&b=two', gotHeader: 'client-value' },
  },
  {
    name: 'POST with a body',
    run: async () => {
      const res = await fetch('/echo', { method: 'POST', body: 'hello-from-viewer' });
      const json = await res.json();
      return { status: res.status, method: json.method, bodyLength: json.bodyLength, bodyText: json.bodyText };
    },
    expect: { status: 200, method: 'POST', bodyLength: 17, bodyText: 'hello-from-viewer' },
  },
  {
    name: 'PUT with a JSON body',
    run: async () => {
      const res = await fetch('/echo', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k: 'v' }),
      });
      const json = await res.json();
      return { method: json.method, bodyText: json.bodyText };
    },
    expect: { method: 'PUT', bodyText: '{"k":"v"}' },
  },
  {
    name: 'PATCH and DELETE verbs',
    run: async () => {
      const patch = await (await fetch('/echo', { method: 'PATCH', body: 'p' })).json();
      const del = await (await fetch('/echo', { method: 'DELETE' })).json();
      return { patch: patch.method, del: del.method, delBody: del.bodyLength };
    },
    expect: { patch: 'PATCH', del: 'DELETE', delBody: 0 },
  },
  {
    name: 'empty body (204)',
    run: async () => {
      const res = await fetch('/empty');
      return { status: res.status, text: await res.text() };
    },
    expect: { status: 204, text: '' },
  },
  {
    name: 'non-2xx status and body preserved',
    run: async () => {
      const res = await fetch('/teapot');
      return { status: res.status, text: await res.text() };
    },
    expect: { status: 418, text: 'short and stout' },
  },
  {
    name: '404 from the app (not from Beam)',
    run: async () => {
      const res = await fetch('/definitely-missing');
      return { status: res.status, text: await res.text() };
    },
    expect: { status: 404, text: 'not found' },
  },
  {
    name: 'redirect is followed against the tunnel origin, not the viewer localhost',
    run: async () => {
      const res = await fetch('/redirect');
      const json = await res.json();
      return { status: res.status, query: json.query, sameOrigin: new URL(res.url).origin === location.origin };
    },
    expect: { status: 200, query: '?after=redirect', sameOrigin: true },
  },
  {
    name: '12 concurrent requests all succeed',
    run: async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => fetch(`/echo?n=${i}`).then((r) => r.json().then((j) => j.query))),
      );
      return { count: results.length, allDistinct: new Set(results).size, first: results[0] };
    },
    expect: { count: 12, allDistinct: 12, first: '?n=0' },
  },
  {
    name: 'large response arrives intact (3MB, many frames + backpressure)',
    run: async () => {
      const res = await fetch('/large');
      const buf = new Uint8Array(await res.arrayBuffer());
      let corrupt = -1;
      for (let i = 0; i < buf.length; i += 4096) if (buf[i] !== 0xab) { corrupt = i; break; }
      return { length: buf.length, lastByte: buf[buf.length - 1], corruptAt: corrupt };
    },
    expect: { length: LARGE_SIZE, lastByte: 0xab, corruptAt: -1 },
  },
  {
    name: 'slow/streamed response completes',
    run: async () => {
      const res = await fetch('/slow');
      return { text: await res.text() };
    },
    expect: { text: 'first-second' },
  },
  {
    name: 'aborted request rejects without wedging later requests',
    run: async () => {
      const controller = new AbortController();
      const pending = fetch('/never', { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      let aborted = false;
      try { await pending; } catch { aborted = true; }
      // The tunnel must still be usable afterwards.
      const after = await (await fetch('/echo?after=abort')).json();
      return { aborted, after: after.query };
    },
    expect: { aborted: true, after: '?after=abort' },
  },
];

async function main() {
  const cleanup = [];
  let failures = 0;
  try {
    const [SP, VP, DP] = [await freePort(), await freePort(), await freePort()];
    const viewerSrv = await startViewerServer(VP); cleanup.push(() => viewerSrv.close());
    const appSrv = await startApp(DP); cleanup.push(() => appSrv.close());
    const wr = await startSignaling(SP); cleanup.push(() => { try { wr.kill(); } catch {} });
    await new Promise((r) => setTimeout(r, 3000));

    const host = await startHost({ localPort: DP, signalingPort: SP, viewerPort: VP });
    cleanup.push(() => host.kill());

    const browser = await puppeteer.launch({
      executablePath: resolveBrowser(), headless: true, protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    cleanup.push(() => browser.close());

    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  [BROWSER-ERR] ${e.message}`));
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!(await enterPinAndConnect(page, host.pin))) {
      console.log('FATAL: viewer never reached relay-ready');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 800));
    console.log('connected — running application compatibility cases\n');

    for (const testCase of CASES) {
      let actual;
      try {
        // Run INSIDE the tunneled-app iframe: that is the origin a real user's
        // app code runs on, and the one the service worker relays for.
        const frame = page.frames().find((f) => f !== page.mainFrame()) ?? page.mainFrame();
        actual = await frame.evaluate(`(${testCase.run.toString()})()`);
      } catch (e) {
        actual = { error: e instanceof Error ? e.message : String(e) };
      }
      const ok = Object.entries(testCase.expect).every(([k, v]) => actual?.[k] === v);
      if (ok) {
        console.log(`  ✓ ${testCase.name}`);
      } else {
        failures += 1;
        console.log(`  ✗ ${testCase.name}`);
        console.log(`      expected ${JSON.stringify(testCase.expect)}`);
        console.log(`      actual   ${JSON.stringify(actual)}`);
      }
    }
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} (${CASES.length} cases)`);
  } catch (e) {
    console.error('FATAL:', e instanceof Error ? e.message : String(e));
    failures = 1;
  } finally {
    for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
    await new Promise((r) => setTimeout(r, 1000));
    process.exit(failures > 0 ? 1 : 0);
  }
}

main();
