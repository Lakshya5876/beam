export type SwMessage =
  | { type: 'mux-ready'; sessionCode: string }
  | { type: 'relay-request'; streamId: number; data: Uint8Array }
  | { type: 'relay-response'; streamId: number; data: Uint8Array }
  | { type: 'relay-error'; streamId: number; reason: 'disconnect' | 'stream-cap-exceeded' | 'internal' };

type RawMsg = { type?: unknown; sessionCode?: unknown; streamId?: unknown; data?: unknown; reason?: unknown };

const RELAY_ERROR_REASONS = new Set<string>(['disconnect', 'stream-cap-exceeded', 'internal']);

function parseMuxReady(msg: RawMsg): SwMessage | null {
  if (typeof msg.sessionCode !== 'string') return null;
  return { type: 'mux-ready', sessionCode: msg.sessionCode };
}

function parseRelayData(type: 'relay-request' | 'relay-response', msg: RawMsg): SwMessage | null {
  if (typeof msg.streamId !== 'number') return null;
  if (!(msg.data instanceof Uint8Array)) return null;
  return { type, streamId: msg.streamId, data: msg.data };
}

function parseRelayError(msg: RawMsg): SwMessage | null {
  if (typeof msg.streamId !== 'number') return null;
  if (typeof msg.reason !== 'string' || !RELAY_ERROR_REASONS.has(msg.reason)) return null;
  return { type: 'relay-error', streamId: msg.streamId, reason: msg.reason as 'disconnect' | 'stream-cap-exceeded' | 'internal' };
}

/**
 * Parse an inbound postMessage payload. Total: malformed → null, never throws.
 */
export function parseSwMessage(data: unknown): SwMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as RawMsg;
  if (msg.type === 'mux-ready') return parseMuxReady(msg);
  if (msg.type === 'relay-request') return parseRelayData('relay-request', msg);
  if (msg.type === 'relay-response') return parseRelayData('relay-response', msg);
  if (msg.type === 'relay-error') return parseRelayError(msg);
  return null;
}

/**
 * Serialize for postMessage (structured clone — copy, not transfer).
 */
export function serializeSwMessage(msg: SwMessage): Record<string, unknown> {
  return { ...msg };
}
