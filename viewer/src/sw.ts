/// <reference lib="webworker" />
/**
 * Service Worker entry point (S16 — impure boundary, verified live at S18).
 * Thin glue over sw-fetch-gate.ts and sw-bridge.ts pure modules.
 *
 * Path-based exclusion (N1): /__beam/* passes through — Beam's own bootstrap assets.
 * Single-document/SPA apps only in v1 — see LIMITATIONS.md.
 */

import { parseSwMessage, serializeSwMessage } from './sw-bridge.js';
import { ResponseAssembler } from './response-assembler.js';
import {
  createFetchGate,
  enqueue,
  nextStreamId,
  onMuxReady,
  trackStreamClose,
  RELAY_TIMEOUT_MS,
} from './sw-fetch-gate.js';
import { encodeFrame, decodeFrame, isFrameDecodeError } from './protocol-bridge.js';
import { encodeRequest } from './request-serializer.js';

declare const self: ServiceWorkerGlobalScope;

const gate = createFetchGate();
const assemblers = new Map<number, ResponseAssembler>();
const responseResolvers = new Map<number, (r: Response) => void>();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = parseSwMessage(event.data as unknown);
  if (!msg) return;
  handleSwMessage(msg, event.source as WindowClient);
});

function handleSwMessage(msg: ReturnType<typeof parseSwMessage>, source: WindowClient): void {
  if (!msg) return;
  if (msg.type === 'mux-ready') handleMuxReady(source, msg.sessionCode);
  else if (msg.type === 'relay-response') handleRelayResponse(msg.streamId, msg.data);
  else if (msg.type === 'relay-error') handleRelayError(msg.streamId, msg.reason);
}

function handleMuxReady(source: WindowClient, sessionCode: string): void {
  const toFlush = onMuxReady(source, sessionCode, gate as typeof gate & { source: WindowClient | null });
  for (const item of toFlush) {
    clearTimeout(item.timer);
    const idx = gate.pending.indexOf(item);
    if (idx >= 0) gate.pending.splice(idx, 1);
    item.resolve({ ok: true });
  }
}

function handleRelayResponse(streamId: number, frameBytes: Uint8Array): void {
  const frame = decodeFrame(frameBytes);
  if (isFrameDecodeError(frame)) return;

  let assembler = assemblers.get(streamId);
  if (!assembler) {
    assembler = new ResponseAssembler();
    assemblers.set(streamId, assembler);
  }

  const feedResult = assembler.feed(frame);

  // Resolve respondWith on first RESPONSE_HEAD (streaming body continues after)
  const resolver = responseResolvers.get(streamId);
  if (resolver) {
    try {
      const response = assembler.buildResponse();
      responseResolvers.delete(streamId);
      resolver(response);
    } catch {
      // buildResponse throws before RESPONSE_HEAD — ignore, wait for next frame
    }
  }

  if (feedResult === 'complete' || feedResult === 'error') {
    assemblers.delete(streamId);
    trackStreamClose(streamId, gate);
  }
}

function handleRelayError(streamId: number, reason: string): void {
  assemblers.get(streamId)?.abort(reason);
  assemblers.delete(streamId);
  const resolver = responseResolvers.get(streamId);
  if (resolver) {
    responseResolvers.delete(streamId);
    resolver(make504(reason));
  }
  trackStreamClose(streamId, gate);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/__beam/')) return; // Beam bootstrap assets — pass through
  if (url.origin !== self.location.origin) return;  // Cross-origin — pass through
  const streamId = nextStreamId(gate);

  // SW restart recovery: if gate state was lost (SW terminated while idle), pull
  // mux-ready from all window clients instead of waiting for a one-shot push that
  // already fired into the previous SW instance and is now gone.
  if (!gate.ready) {
    void self.clients.matchAll({ type: 'window' }).then((clients) => {
      const msg = serializeSwMessage({ type: 'request-mux-ready' });
      for (const client of clients) client.postMessage(msg);
    });
  }

  event.respondWith(handleFetch(streamId, event.request, event.clientId));
});

async function resolveRelayTarget(clientId: string): Promise<WindowClient | null> {
  if (clientId) {
    const fetchClient = await self.clients.get(clientId);
    if (fetchClient) return fetchClient as WindowClient;
  }
  return gate.source as WindowClient | null;
}

function postRelayFrames(source: WindowClient, streamId: number, frames: ReturnType<typeof encodeRequest>): void {
  for (const frame of frames) {
    console.log(`[SW] posting relay-request sid=${String(streamId)} frameType=${String(frame.type)}`);
    source.postMessage(serializeSwMessage({ type: 'relay-request', streamId, data: encodeFrame(frame) }));
  }
  console.log(`[SW] all frames posted sid=${String(streamId)} count=${String(frames.length)}`);
}

async function handleFetch(streamId: number, request: Request, clientId: string): Promise<Response> {
  try {
    console.log(`[SW] fetch sid=${String(streamId)} ready=${String(gate.ready)} clientId=${clientId}`);
    const result = await enqueue(streamId, RELAY_TIMEOUT_MS, gate);
    if (!result.ok) return result.response;

    // Prefer the fetch event's own clientId over the stored gate.source.
    // gate.source can be stale after a SW restart + re-arm cycle.
    const source = await resolveRelayTarget(clientId);
    console.log(`[SW] relay target sid=${String(streamId)} hasSource=${String(source !== null)}`);
    if (!source) return make504('no-source');

    const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname + (reqUrl.search ?? '');
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, name) => { headers.push([name, value]); });

    const frames = encodeRequest(streamId, { method: request.method, path, headers, body: bodyBytes });
    postRelayFrames(source, streamId, frames);

    return new Promise<Response>((resolve) => {
      responseResolvers.set(streamId, resolve);
    });
  } catch (err) {
    trackStreamClose(streamId, gate);
    return make504(`internal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function make504(reason: string): Response {
  return new Response(
    `<html><body><h1>Beam: relay unavailable</h1><p>${reason}</p></body></html>`,
    { status: 504, statusText: 'Gateway Timeout', headers: { 'content-type': 'text/html' } },
  );
}
