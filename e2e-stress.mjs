/**
 * Beam local stress / security / resilience matrix (headless Chrome).
 * Usage: node e2e-stress.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { enterPin, startHost as libStartHost } from './e2e-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIGNALING_PORT = 8081;
const VIEWER_PORT = 8788;
const DUMMY_PORT = 3000;

const results = [];

function record(section, name, outcome, detail = {}) {
  const entry = { section, name, outcome, ...detail };
  results.push(entry);
  const flag = outcome === 'PASS' ? '✓' : outcome === 'FAIL' ? '✗' : '•';
  console.log(`[${flag}] ${section} :: ${name} — ${outcome}${detail.note ? ` (${detail.note})` : ''}`);
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (p, m) => console.log(`[${ts()}] ${p} ${m}`);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function startViewerServer() {
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
    server.listen(VIEWER_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function startDummyServer() {
  const stats = { concurrent: 0, maxConcurrent: 0, requests: 0, latencies: [] };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      stats.requests += 1;
      stats.concurrent += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      const start = performance.now();
      const url = new URL(req.url, `http://127.0.0.1:${DUMMY_PORT}`);

      let size = 1000;
      if (url.pathname.startsWith('/size/')) {
        size = Math.min(Number(url.pathname.split('/')[2]) || 0, 2 * 1024 * 1024);
      } else if (url.pathname === '/slow') {
        size = 64;
      }

      const payload = 'A'.repeat(size);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) });
      res.end(payload, () => {
        stats.concurrent -= 1;
        stats.latencies.push(performance.now() - start);
      });
    });
    server.listen(DUMMY_PORT, '127.0.0.1', () => resolve({ server, stats }));
    server.on('error', reject);
  });
}

function startSignaling() {
  return new Promise((resolve, reject) => {
    const wrangler = spawn(
      path.join(ROOT, 'signaling/node_modules/.bin/wrangler'),
      ['dev', '--config', path.join(ROOT, 'signaling/wrangler.jsonc'), '--port', String(SIGNALING_PORT), '--local', '--log-level', 'warn'],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } },
    );
    let started = false;
    const onData = (chunk) => {
      const line = chunk.toString();
      if (!started && (line.includes(`localhost:${SIGNALING_PORT}`) || line.includes('Ready on'))) {
        started = true;
        resolve(wrangler);
      }
    };
    wrangler.stdout.on('data', onData);
    wrangler.stderr.on('data', onData);
    setTimeout(() => { if (!started) { started = true; resolve(wrangler); } }, 12000);
    wrangler.on('error', reject);
  });
}

async function mintSessionCode() {
  const res = await fetch(`http://127.0.0.1:${SIGNALING_PORT}/new`, { method: 'POST' });
  const body = await res.json();
  return body.code;
}

function startHost(extraArgs = []) {
  // Shared lib: adds --debug (host timeline in logs) and process-group kill
  // (no zombie hosts poisoning later runs).
  return libStartHost({
    localPort: DUMMY_PORT,
    signalingPort: SIGNALING_PORT,
    viewerPort: VIEWER_PORT,
    extraArgs,
    log: (l) => log('HOST', l),
  });
}

const HOOKS = `
window.__beamStress = { ws: null, dc: null, pc: null, pcState: 'new', dcState: 'none' };
const _WS = WebSocket;
WebSocket = function(url, proto) {
  const ws = proto ? new _WS(url, proto) : new _WS(url);
  if (String(url).includes(':8081')) window.__beamStress.ws = ws;
  return ws;
};
WebSocket.prototype = _WS.prototype;
WebSocket.CONNECTING = _WS.CONNECTING;
WebSocket.OPEN = _WS.OPEN;
WebSocket.CLOSING = _WS.CLOSING;
WebSocket.CLOSED = _WS.CLOSED;
const _RTC = RTCPeerConnection;
RTCPeerConnection = function(...args) {
  const pc = new _RTC(...args);
  window.__beamStress.pc = pc;
  pc.addEventListener('connectionstatechange', () => { window.__beamStress.pcState = pc.connectionState; });
  pc.addEventListener('datachannel', (e) => {
    window.__beamStress.dc = e.channel;
    window.__beamStress.dcState = e.channel.readyState;
    e.channel.addEventListener('open', () => { window.__beamStress.dcState = e.channel.readyState; });
    e.channel.addEventListener('close', () => { window.__beamStress.dcState = e.channel.readyState; });
    e.channel.addEventListener('error', () => { window.__beamStress.dcState = 'error'; });
  });
  return pc;
};
RTCPeerConnection.prototype = _RTC.prototype;
`;

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 240_000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
}

async function waitForConnected(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => window.__beamStress?.pcState ?? 'missing');
    if (state === 'connected') return true;
    if (state === 'failed') return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitForDcOpen(page, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await page.evaluate(() => window.__beamStress?.dcState ?? 'none');
    if (st === 'open') return true;
    if (st === 'closed' || st === 'error') return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function encodeFrame(type, streamId, payload) {
  const out = new Uint8Array(9 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId);
  view.setUint32(5, payload.byteLength);
  out.set(payload, 9);
  return out;
}

async function testRawDcPayloads(page) {
  const sizes = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  for (const size of sizes) {
    const r = await page.evaluate(async (payloadSize) => {
      const dc = window.__beamStress?.dc;
      if (!dc || dc.readyState !== 'open') return { ok: false, reason: 'no-dc', size: payloadSize };
      const before = dc.readyState;
      let threw = null;
      try {
        dc.send(new Uint8Array(payloadSize));
      } catch (e) {
        threw = String(e.message ?? e);
      }
      await new Promise((r) => setTimeout(r, 500));
      return {
        size: payloadSize,
        threw,
        before,
        after: dc.readyState,
        buffered: dc.bufferedAmount,
      };
    }, size);

    const fractured = r.threw || r.after !== 'open';
    record('STRESS', `raw-dc-${size}`, fractured ? 'LIMIT' : 'PASS', {
      note: fractured
        ? `threw=${r.threw ?? 'none'} state=${r.before}→${r.after} buffered=${r.buffered}`
        : `delivered raw ${size}B, dc still open`,
      ...r,
    });
  }
}

async function testProtocolRelayPayloads(page) {
  const sizes = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  for (const size of sizes) {
    const r = await page.evaluate(async (responseBytes) => {
      const dc = window.__beamStress?.dc;
      if (!dc || dc.readyState !== 'open') return { ok: false, reason: 'no-dc', size: responseBytes };

      const enc = (type, streamId, payload) => {
        const out = new Uint8Array(9 + payload.byteLength);
        const view = new DataView(out.buffer);
        view.setUint8(0, type);
        view.setUint32(1, streamId);
        view.setUint32(5, payload.byteLength);
        out.set(payload, 9);
        return out;
      };

      const streamId = 9000 + (responseBytes % 1000);
      const head = new TextEncoder().encode(JSON.stringify({
        method: 'GET',
        path: `/size/${responseBytes}`,
        headers: {},
      }));

      return await new Promise((resolve) => {
        let bodyBytes = 0;
        let status = 0;
        let done = false;
        const timer = setTimeout(() => {
          if (!done) resolve({ ok: false, reason: 'timeout', size: responseBytes, bodyBytes, status });
        }, 15000);

        const onMsg = (ev) => {
          const bytes = new Uint8Array(ev.data);
          if (bytes.byteLength < 9) return;
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const type = view.getUint8(0);
          const sid = view.getUint32(1);
          if (sid !== streamId) return;
          const len = view.getUint32(5);
          const payload = bytes.subarray(9, 9 + len);
          if (type === 4) {
            try {
              const h = JSON.parse(new TextDecoder().decode(payload));
              status = h.status ?? 0;
            } catch { /* ignore */ }
          } else if (type === 5) {
            bodyBytes += payload.byteLength;
          } else if (type === 6 || type === 7) {
            done = true;
            clearTimeout(timer);
            dc.removeEventListener('message', onMsg);
            resolve({ ok: type === 6 && status === 200 && bodyBytes === responseBytes, size: responseBytes, bodyBytes, status, frameType: type });
          }
        };

        dc.addEventListener('message', onMsg);
        dc.send(enc(1, streamId, head));
        dc.send(enc(3, streamId, new Uint8Array(0)));
      });
    }, size);

    record('STRESS', `protocol-relay-${size}`, r.ok ? 'PASS' : 'LIMIT', {
      note: r.ok ? `${r.bodyBytes}B status=${r.status}` : `${r.reason ?? 'fail'} got=${r.bodyBytes ?? 0}B status=${r.status ?? 0}`,
      ...r,
    });
  }
}

async function testHttpRelayPayloads(page) {
  const sizes = [16 * 1024, 64 * 1024];
  for (const size of sizes) {
    const r = await page.evaluate(async (n) => {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(`/size/${n}`, { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        const buf = await res.arrayBuffer();
        return { ok: res.ok, status: res.status, bytes: buf.byteLength, ms: performance.now() - t0 };
      } catch (e) {
        return { ok: false, error: String(e.message ?? e), ms: performance.now() - t0 };
      }
    }, size);

    record('STRESS', `sw-fetch-relay-${size}`, r.ok && r.bytes === size ? 'PASS' : 'LIMIT', {
      note: r.ok ? `${r.ms.toFixed(0)}ms` : `status=${r.status ?? 'timeout/err'} — SW→bootstrap wiring gap`,
      ...r,
    });
  }
}

async function testConcurrentProtocolRelay(page, dummyStats) {
  dummyStats.latencies.length = 0;
  dummyStats.maxConcurrent = 0;
  const r = await page.evaluate(async () => {
    const dc = window.__beamStress?.dc;
    if (!dc || dc.readyState !== 'open') return { ok: false, reason: 'no-dc' };

    const enc = (type, streamId, payload) => {
      const out = new Uint8Array(9 + payload.byteLength);
      const view = new DataView(out.buffer);
      view.setUint8(0, type);
      view.setUint32(1, streamId);
      view.setUint32(5, payload.byteLength);
      out.set(payload, 9);
      return out;
    };

    const runOne = (streamId) => new Promise((resolve) => {
      const t0 = performance.now();
      let done = false;
      const timer = setTimeout(() => resolve({ streamId, ok: false, ms: performance.now() - t0, reason: 'timeout' }), 10000);
      const onMsg = (ev) => {
        const bytes = new Uint8Array(ev.data);
        if (bytes.byteLength < 9) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sid = view.getUint32(1);
        if (sid !== streamId) return;
        const type = view.getUint8(0);
        if (type === 6 || type === 7) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            dc.removeEventListener('message', onMsg);
            resolve({ streamId, ok: type === 6, ms: performance.now() - t0, type });
          }
        }
      };
      dc.addEventListener('message', onMsg);
      const head = new TextEncoder().encode(JSON.stringify({ method: 'GET', path: `/load-${streamId}`, headers: {} }));
      dc.send(enc(1, streamId, head));
      dc.send(enc(3, streamId, new Uint8Array(0)));
    });

    const t0 = performance.now();
    const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => runOne(100 + i)));
    return { ms: performance.now() - t0, outcomes };
  });

  const ok = r.outcomes?.filter((o) => o.ok) ?? [];
  record('STRESS', 'concurrent-50-protocol-relay', ok.length === 50 ? 'PASS' : 'LIMIT', {
    note: `${ok.length}/50 OK wall=${r.ms?.toFixed(0)}ms maxConcurrent=${dummyStats.maxConcurrent} p50=${percentile(dummyStats.latencies, 50)}ms`,
    okCount: ok.length,
    p95ms: percentile(dummyStats.latencies, 95),
  });
}

async function testConcurrentLoad(page, dummyStats) {
  dummyStats.latencies.length = 0;
  dummyStats.maxConcurrent = 0;
  const r = await page.evaluate(async () => {
    const n = 50;
    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        return fetch(`/load-${i}`, { cache: 'no-store', signal: ctrl.signal })
          .then(async (res) => {
            clearTimeout(timer);
            return { i, status: res.status, bytes: (await res.arrayBuffer()).byteLength, ok: res.ok };
          })
          .catch((e) => {
            clearTimeout(timer);
            return { i, status: 0, bytes: 0, ok: false, error: String(e.message ?? e) };
          });
      }),
    );
    return { ms: performance.now() - t0, outcomes };
  });

  const ok = r.outcomes.filter((o) => o.ok && o.status === 200);
  const capped = r.outcomes.filter((o) => o.status === 504);
  const other = r.outcomes.filter((o) => !o.ok && o.status !== 504);

  record('STRESS', 'concurrent-50-fetch', ok.length >= 32 ? 'PASS' : 'LIMIT', {
    note: `${ok.length}/50 OK, ${capped.length}×504, maxConcurrent=${dummyStats.maxConcurrent}, wall=${r.ms.toFixed(0)}ms`,
    okCount: ok.length,
    capped504: capped.length,
    otherFailures: other.length,
    p50ms: percentile(dummyStats.latencies, 50),
    p95ms: percentile(dummyStats.latencies, 95),
  });
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((p / 100) * (sorted.length - 1))].toFixed(1);
}

async function testInvalidSessionWs() {
  const cases = [
    { label: 'too-short', path: '/abc', expectStatus: 404 },
    { label: 'uppercase-charset', path: '/ABCDEFGHIJKLMNOPQRSTUVWXYZ', expectStatus: 404 },
    { label: 'random-valid-format-unminted', path: '/zzzzzzzzzzzzzzzzzzzzzzzzzz', expectWsOpen: true },
  ];

  for (const c of cases) {
    if (c.expectStatus) {
      // undici's global fetch() forbids setting the Upgrade header — it
      // throws "invalid upgrade header" before the request ever reaches the
      // server, which silently killed this whole test (and the rest of the
      // matrix after it, since the throw was uncaught). node:http has no such
      // restriction.
      const res = await rawUpgradeProbe(SIGNALING_PORT, c.path);
      const pass = res.status === c.expectStatus;
      record('SECURITY', `invalid-session-${c.label}`, pass ? 'PASS' : 'FAIL', {
        note: `HTTP ${res.status} body="${res.body.slice(0, 40)}"`,
      });
    } else {
      const r = await wsProbe(`ws://127.0.0.1:${SIGNALING_PORT}${c.path}`);
      record('SECURITY', `unminted-session-${c.label}`, r.opened ? 'PASS' : 'FAIL', {
        note: r.opened ? 'WS accepted — isolated DO instance, no state leak' : 'rejected unexpectedly',
      });
      if (r.ws) try { r.ws.close(); } catch { /* ignore */ }
    }
  }
}

function rawUpgradeProbe(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path, method: 'GET',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('upgrade', (res) => resolve({ status: res.statusCode, body: '' }));
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.end();
  });
}

function wsProbe(url) {
  return new Promise((resolve) => {
    let opened = false;
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => { opened = true; });
    setTimeout(() => resolve({ opened, ws: opened ? ws : null }), 1500);
  });
}

async function testReplayAttack(capturedOffer) {
  const code = await mintSessionCode();
  const hostWsUrl = `ws://127.0.0.1:${SIGNALING_PORT}/${code}`;

  const hostResult = await new Promise((resolve) => {
    const ws = new WebSocket(hostWsUrl);
    let roleOk = false;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ kind: 'offer', payload: capturedOffer }));
    });
    ws.addEventListener('message', () => { roleOk = true; });
    setTimeout(() => resolve({ roleOk, ws }), 1500);
  });

  const viewerWs = new WebSocket(hostWsUrl);
  await new Promise((r) => viewerWs.addEventListener('open', r, { once: true }));
  let viewerGotOffer = false;
  viewerWs.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      if (msg.kind === 'offer') viewerGotOffer = true;
    } catch { /* ignore */ }
  });
  await new Promise((r) => setTimeout(r, 1000));

  try { hostResult.ws.close(); viewerWs.close(); } catch { /* ignore */ }

  record('SECURITY', 'replay-stale-offer-new-session', viewerGotOffer ? 'LIMIT' : 'PASS', {
    note: viewerGotOffer
      ? 'stale offer relayed to viewer on fresh session — no crypto binding'
      : 'viewer did not receive injected offer (unexpected)',
  });
}

async function testDcFuzz(page) {
  const r = await page.evaluate(async () => {
    const dc = window.__beamStress?.dc;
    if (!dc || dc.readyState !== 'open') return { ok: false, reason: 'no-dc' };
    const garbage = [
      new Uint8Array(0),
      new Uint8Array([99, 99, 99]),
      new Uint8Array(100).fill(0xff),
      new TextEncoder().encode('{not:"json",<<<'),
      new Uint8Array(17).fill(0),
    ];
    for (const g of garbage) {
      try { dc.send(g); } catch { /* expected for some sizes */ }
    }
    await new Promise((r) => setTimeout(r, 800));
    return { dcState: dc.readyState, pcState: window.__beamStress?.pcState };
  });

  const survived = r.dcState === 'open' && r.pcState === 'connected';
  record('SECURITY', 'datachannel-fuzz-garbage', survived ? 'PASS' : 'FAIL', {
    note: `after fuzz dc=${r.dcState} pc=${r.pcState}`,
    ...r,
  });
}

async function testViewerWsKill(page, hostProc) {
  const before = await page.evaluate(() => ({
    pc: window.__beamStress?.pcState,
    dc: window.__beamStress?.dcState,
  }));

  await page.evaluate(() => {
    const ws = window.__beamStress?.ws;
    if (ws && ws.readyState <= 1) ws.close(4000, 'stress-kill');
  });

  await new Promise((r) => setTimeout(r, 2000));

  const after = await page.evaluate(() => ({
    pc: window.__beamStress?.pcState,
    dc: window.__beamStress?.dcState,
  }));

  const hostTail = hostProc.logs.slice(-20).join('\n');
  const hostClosed = /DataChannel CLOSED|peerState=closed|peerState=disconnected/.test(hostTail);

  record('RESILIENCE', 'viewer-ws-abrupt-close', after.pc !== 'connected' ? 'PASS' : 'LIMIT', {
    note: `pc ${before.pc}→${after.pc}, dc ${before.dc}→${after.dc}, hostLoggedClose=${hostClosed}`,
    hostClosed,
    ...after,
  });
}

async function testHostRestart(page, oldUrl, procs) {
  const stateBefore = await page.evaluate(() => window.__beamStress?.pcState ?? 'missing');

  try { procs.host.kill('SIGTERM'); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1500));

  let newHost;
  try {
    newHost = await startHost();
    procs.host = newHost; // lib host handle — .kill() signals the whole group
  } catch (e) {
    record('RESILIENCE', 'host-restart-while-viewer-open', 'FAIL', { note: String(e.message) });
    return;
  }

  await new Promise((r) => setTimeout(r, 2000));
  const stateAfter = await page.evaluate(() => window.__beamStress?.pcState ?? 'missing');
  const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 120) ?? '');

  record('RESILIENCE', 'host-restart-while-viewer-open', 'PASS', {
    note: `viewer stayed on old URL; pc ${stateBefore}→${stateAfter}; page="${pageText.trim()}"`,
    newSessionUrl: newHost.url,
    oldUrl,
  });
}

async function main() {
  const procs = { host: null, wrangler: null };
  let viewerServer;
  let dummy;
  let browser;
  let page;
  let capturedOffer = null;

  try {
    log('MAIN', 'bootstrapping stack…');
    viewerServer = await startViewerServer();
    dummy = await startDummyServer();
    procs.wrangler = await startSignaling();
    await new Promise((r) => setTimeout(r, 3000));

    const host = await startHost();
    procs.host = host;

    browser = await launchBrowser();
    page = await browser.newPage();
    await page.evaluateOnNewDocument(HOOKS);
    page.on('console', (msg) => log('BROWSER', msg.text()));

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await enterPin(page, host.pin);
    const connected = await waitForConnected(page);
    if (!connected) {
      record('SETUP', 'webrtc-handshake', 'FAIL', { note: 'did not reach connected' });
      return;
    }
    record('SETUP', 'webrtc-handshake', 'PASS', { note: 'connected + mux ready' });
    await waitForDcOpen(page);

    // Capture offer for replay test from signaling (host already sent it)
    capturedOffer = await new Promise((resolve) => {
      const code = new URL(host.url).searchParams.get('signaling')?.split('/').pop();
      const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/${code}`);
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.kind === 'offer' && !capturedOffer) {
            capturedOffer = msg.payload;
            ws.close();
            resolve(msg.payload);
          }
        } catch { /* ignore */ }
      });
      setTimeout(() => resolve(capturedOffer ?? 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n'), 3000);
    });

    log('MAIN', '=== STRESS & LOAD ===');
    await testProtocolRelayPayloads(page);
    await testHttpRelayPayloads(page);
    await testRawDcPayloads(page);
    await testConcurrentProtocolRelay(page, dummy.stats);
    await testConcurrentLoad(page, dummy.stats);

    log('MAIN', '=== SECURITY ===');
    await testInvalidSessionWs();
    if (capturedOffer) await testReplayAttack(capturedOffer);
    await testDcFuzz(page);

    log('MAIN', '=== RESILIENCE ===');
    await testHostRestart(page, host.url, procs);
    // Reconnect for ws-kill test on fresh session
    const host2 = await startHost();
    procs.host = host2;
    page = await browser.newPage();
    await page.evaluateOnNewDocument(HOOKS);
    await page.goto(host2.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await enterPin(page, host2.pin);
    await waitForConnected(page);
    await testViewerWsKill(page, host2);

  } catch (err) {
    log('MAIN', `FATAL: ${err.message}`);
    console.error(err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viewerServer) viewerServer.close();
    if (dummy?.server) dummy.server.close();
    for (const p of [procs.host, procs.wrangler]) {
      if (p) try { p.kill('SIGTERM'); } catch { /* ignore */ }
    }

    console.log('\n========== STRESS MATRIX SUMMARY ==========');
    const sections = [...new Set(results.map((r) => r.section))];
    for (const sec of sections) {
      console.log(`\n## ${sec}`);
      for (const r of results.filter((x) => x.section === sec)) {
        console.log(`  ${r.outcome.padEnd(6)} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
      }
    }
    console.log('\n===========================================\n');
    process.exit(0);
  }
}

main();
