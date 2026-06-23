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
  event.respondWith(handleFetch(streamId, event.request));
});

async function handleFetch(streamId: number, request: Request): Promise<Response> {
  try {
    const result = await enqueue(streamId, RELAY_TIMEOUT_MS, gate);
    if (!result.ok) return result.response; // 504 — never rejects (B3)

    const source = gate.source as WindowClient | null;
    if (!source) return make504('no-source');

    // Fully buffer request body (S-c: no request-side streaming in v1)
    const bodyBytes = request.body
      ? new Uint8Array(await request.arrayBuffer())
      : new Uint8Array(0);

    // Build path (pathname + search) — host decodeRequestHead expects 'path', not full URL
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname + (reqUrl.search ?? '');

    // Collect headers as [name, value] pairs — cap total JSON size to avoid
    // exceeding MAX_PAYLOAD_SIZE (16 KiB) on requests with very large headers.
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, name) => { headers.push([name, value]); });

    // Encode into REQUEST_HEAD + REQUEST_BODY_CHUNK* + REQUEST_END frames.
    const frames = encodeRequest(streamId, { method: request.method, path, headers, body: bodyBytes });
    for (const frame of frames) {
      source.postMessage(serializeSwMessage({ type: 'relay-request', streamId, data: encodeFrame(frame) }));
    }

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
