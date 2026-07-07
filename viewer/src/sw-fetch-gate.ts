export const MAX_CONCURRENT_STREAMS = 32;
export const RELAY_TIMEOUT_MS = 30_000;

/**
 * Paths that belong to the viewer's OWN static bundle, not the tunneled
 * target — these must never be relayed.
 *
 * `/__beam/*` was already excluded (bootstrap assets). `/assets/*` (the
 * vite-hashed JS bundle, see viewer/vite.config.ts) and `/` (the app shell,
 * served by the static host) were NOT excluded — so once the service worker
 * took control, reloading the page hung: the SW intercepted the request for
 * its own JS bundle and root document, tried to relay them to a peer, and
 * the reload never completed. Every reload after first connect was broken.
 *
 * Trade-off: a tunneled target whose OWN app also serves `/assets/*` will
 * have that prefix shadowed by the viewer's bundle instead of relayed. Kept
 * narrow (exact `/` and `/assets/` prefix only) to minimize that collision
 * — documented in LIMITATIONS.md.
 */
export function shouldBypassRelay(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/assets/') || pathname.startsWith('/__beam/');
}

export interface PendingItem {
  streamId: number;
  resolve: (r: PendingResult) => void;
  timer: ReturnType<typeof setTimeout>;
  flushing: boolean; // true = returned from onMuxReady, not yet resolved by caller
}

export interface FetchGate {
  ready: boolean;
  source: unknown;
  sessionCode: string | null;
  openStreams: Set<number>;
  pending: PendingItem[];
  nextId: number;
}

export type PendingResult = { ok: true } | { ok: false; response: Response };

export function createFetchGate(): FetchGate {
  return {
    ready: false,
    source: null,
    sessionCode: null,
    openStreams: new Set(),
    pending: [],
    nextId: 1,
  };
}

export function nextStreamId(gate: FetchGate): number {
  return gate.nextId++;
}

/**
 * Mark the gate as ready. Returns pending items for the caller to flush.
 * Items remain in gate.pending (marked flushing=true) until onMuxGone can
 * see and drain them if the mux disappears before the caller finishes flushing.
 */
export function onMuxReady<S>(
  source: S,
  sessionCode: string,
  gate: FetchGate & { source: S | null },
): PendingItem[] {
  gate.ready = true;
  gate.source = source;
  gate.sessionCode = sessionCode;
  // Mark all pending items as flushing; return them for caller to resolve
  for (const item of gate.pending) {
    item.flushing = true;
  }
  return [...gate.pending];
}

/**
 * Mark the gate as not ready. Drains ALL remaining pending items (including
 * any partially-flushed from onMuxReady that the caller hasn't resolved yet).
 * Returns items to resolve ok:false, and open streamIds to emit relay-error for.
 */
export function onMuxGone(gate: FetchGate): { pending: PendingItem[]; openStreamIds: number[] } {
  gate.ready = false;
  gate.source = null;
  const remaining = gate.pending.splice(0);
  const openStreamIds = [...gate.openStreams];
  gate.openStreams.clear();
  return { pending: remaining, openStreamIds };
}

export function enqueue(streamId: number, timeoutMs: number, gate: FetchGate): Promise<PendingResult> {
  return new Promise((resolve) => {
    if (gate.ready) {
      if (gate.openStreams.size >= MAX_CONCURRENT_STREAMS) {
        resolve({ ok: false, response: make504('stream-cap-exceeded') });
        return;
      }
      gate.openStreams.add(streamId);
      resolve({ ok: true });
      return;
    }
    const timer = setTimeout(() => {
      const idx = gate.pending.findIndex((p) => p.streamId === streamId);
      if (idx >= 0) gate.pending.splice(idx, 1);
      resolve({ ok: false, response: make504('timeout') });
    }, timeoutMs);
    gate.pending.push({ streamId, resolve, timer, flushing: false });
  });
}

export function trackStreamOpen(streamId: number, gate: FetchGate): void {
  gate.openStreams.add(streamId);
}

export function trackStreamClose(streamId: number, gate: FetchGate): void {
  gate.openStreams.delete(streamId);
}

function make504(reason: string): Response {
  return new Response(
    `<html><body><h1>Beam: relay unavailable</h1><p>${reason}</p></body></html>`,
    { status: 504, statusText: 'Gateway Timeout', headers: { 'content-type': 'text/html' } },
  );
}
