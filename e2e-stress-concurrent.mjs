/** Isolated concurrent-50 protocol relay test on a fresh session. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { enterPin, parseHostStart } from './e2e-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SP = 8081; const VP = 8788; const DP = 3000;
const stats = { concurrent: 0, max: 0, lat: [] };

const HOOKS = `window.__beamStress={ws:null,dc:null,pc:null,pcState:'new',dcState:'none'};const _WS=WebSocket;WebSocket=function(u,p){const w=p?new _WS(u,p):new _WS(u);if(String(u).includes(':8081'))window.__beamStress.ws=w;return w;};WebSocket.prototype=_WS.prototype;const _RTC=RTCPeerConnection;RTCPeerConnection=function(...a){const pc=new _RTC(...a);window.__beamStress.pc=pc;pc.addEventListener('connectionstatechange',()=>{window.__beamStress.pcState=pc.connectionState;});pc.addEventListener('datachannel',(e)=>{window.__beamStress.dc=e.channel;window.__beamStress.dcState=e.channel.readyState;e.channel.addEventListener('open',()=>{window.__beamStress.dcState=e.channel.readyState;});});return pc;};RTCPeerConnection.prototype=_RTC.prototype;`;

const viewerSrv = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, 'viewer/dist', p);
  try {
    const d = fs.readFileSync(f);
    const h = { 'Content-Type': 'text/html' };
    if (p === '/__beam/sw.js') { h['Service-Worker-Allowed'] = '/'; h['Cache-Control'] = 'no-cache'; }
    res.writeHead(200, h); res.end(d);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => viewerSrv.listen(VP, '127.0.0.1', r));

const dummy = http.createServer((req, res) => {
  stats.concurrent += 1;
  stats.max = Math.max(stats.max, stats.concurrent);
  const t = performance.now();
  res.writeHead(200, { 'Content-Length': '4' });
  res.end('ping', () => { stats.concurrent -= 1; stats.lat.push(performance.now() - t); });
});
await new Promise((r) => dummy.listen(DP, '127.0.0.1', r));

const wr = spawn(path.join(ROOT, 'signaling/node_modules/.bin/wrangler'),
  ['dev', '--config', path.join(ROOT, 'signaling/wrangler.jsonc'), '--port', String(SP), '--local', '--log-level', 'warn'],
  { cwd: ROOT });
await new Promise((r) => setTimeout(r, 12000));

await new Promise((r) => setTimeout(r, 3000));

const host = await new Promise((resolve, reject) => {
  const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'),
    ['src/presentation/cli.ts', String(DP), '--signaling', `ws://localhost:${SP}`, '--viewer', `http://localhost:${VP}`],
    { cwd: ROOT });
  let buf = '';
  p.stdout.on('data', (c) => {
    buf += c.toString();
    const parsed = parseHostStart(buf);
    if (parsed) resolve({ proc: p, url: parsed.url, pin: parsed.pin });
  });
  setTimeout(() => reject(new Error('host timeout')), 20000);
});

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(HOOKS);
await page.goto(host.url, { waitUntil: 'domcontentloaded' });
await enterPin(page, host.pin);
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => window.__beamStress.pcState) === 'connected') break;
  await new Promise((r) => setTimeout(r, 200));
}

const r = await page.evaluate(async () => {
  const dc = window.__beamStress?.dc;
  if (!dc || dc.readyState !== 'open') return { err: 'no-dc' };
  const enc = (type, streamId, payload) => {
    const out = new Uint8Array(9 + payload.byteLength);
    const v = new DataView(out.buffer);
    v.setUint8(0, type); v.setUint32(1, streamId); v.setUint32(5, payload.byteLength);
    out.set(payload, 9); return out;
  };
  const run = (streamId) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => resolve({ streamId, ok: false, reason: 'timeout' }), 20000);
    const onMsg = (ev) => {
      const b = new Uint8Array(ev.data);
      if (b.byteLength < 9) return;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (v.getUint32(1) !== streamId) return;
      const t = v.getUint8(0);
      if (t === 6 || t === 7) {
        if (!done) {
          done = true; clearTimeout(timer);
          dc.removeEventListener('message', onMsg);
          resolve({ streamId, ok: t === 6 });
        }
      }
    };
    dc.addEventListener('message', onMsg);
    const head = new TextEncoder().encode(JSON.stringify({ method: 'GET', path: `/c-${streamId}`, headers: {} }));
    dc.send(enc(1, streamId, head));
    dc.send(enc(3, streamId, new Uint8Array(0)));
  });
  const t0 = performance.now();
  const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => run(200 + i)));
  return { ms: performance.now() - t0, outcomes };
});

const ok = r.outcomes?.filter((o) => o.ok).length ?? 0;
const p50 = stats.lat.sort((a, b) => a - b)[Math.floor(stats.lat.length / 2)];
const pcState = await page.evaluate(() => window.__beamStress?.pcState);
const dcState = await page.evaluate(() => window.__beamStress?.dcState);
console.log(JSON.stringify({ ok, total: 50, wallMs: Math.round(r.ms ?? 0), maxConcurrent: stats.max, p50ms: p50?.toFixed(2), pcState, dcState, err: r.err }, null, 2));

await browser.close(); viewerSrv.close(); dummy.close(); wr.kill(); host.proc.kill();
