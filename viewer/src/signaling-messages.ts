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
 * Serialize to JSON. Caller guarantees well-formed input.
 */
export function serializeMessage(kind: SignalingMessageKind, payload: SignalingPayload): string {
  return JSON.stringify({ kind, payload });
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
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const ic = payload as { candidate?: unknown; mid?: unknown };
  if (typeof ic.candidate !== 'string') {
    return null;
  }
  return {
    kind: 'ice-candidate',
    payload: {
      candidate: ic.candidate,
      mid: typeof ic.mid === 'string' ? ic.mid : undefined,
    },
  };
}
