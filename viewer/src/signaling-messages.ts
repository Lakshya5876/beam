/**
 * Signaling message serialization (opaque envelopes: offer/answer/ice-candidate).
 * Total parsing: malformed input yields null, never throws.
 */

export type SignalingMessageKind = 'offer' | 'answer' | 'ice-candidate';

export interface IceCandidate {
  readonly candidate: string;
  readonly mid?: string;
}

export type SignalingPayload = string | IceCandidate;

export interface SignalingMessage {
  readonly kind: SignalingMessageKind;
  readonly payload: SignalingPayload;
}

const VALID_KINDS = new Set<SignalingMessageKind>(['offer', 'answer', 'ice-candidate']);

/**
 * Serialize to JSON. IceCandidate objects are stringified so the wire payload
 * is always a string, matching the host-side SignalingMessage.payload: string
 * contract. Offer/answer payloads are already strings — no change there.
 */
export function serializeMessage(kind: SignalingMessageKind, payload: SignalingPayload): string {
  const wirePayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({ kind, payload: wirePayload });
}

/**
 * Parse from JSON. Malformed -> null (dropped), never thrown.
 */
export function parseMessage(text: string): SignalingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const msg = parsed as { kind?: unknown; payload?: unknown };
  if (typeof msg.kind !== 'string' || !VALID_KINDS.has(msg.kind as SignalingMessageKind)) {
    return null;
  }
  const kind = msg.kind as SignalingMessageKind;
  if (kind === 'ice-candidate') {
    return parseIceCandidate(msg.payload);
  }
  if (typeof msg.payload !== 'string') {
    return null;
  }
  return { kind, payload: msg.payload };
}

function parseIceCandidate(payload: unknown): SignalingMessage | null {
  // Host sends payload as a JSON string (host SignalingMessage.payload: string).
  // Parse it first if it arrived as a string; keep object form for robustness.
  let ic: unknown = payload;
  if (typeof payload === 'string') {
    try { ic = JSON.parse(payload); } catch { return null; }
  }
  if (typeof ic !== 'object' || ic === null) {
    return null;
  }
  const { candidate, mid } = ic as { candidate?: unknown; mid?: unknown };
  if (typeof candidate !== 'string') {
    return null;
  }
  return {
    kind: 'ice-candidate',
    payload: typeof mid === 'string' ? { candidate, mid } : { candidate },
  };
}
