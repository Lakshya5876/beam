/**
 * Signaling message size cap (design §A.2.4). SDP/ICE blobs are kilobytes; any
 * message above the cap is refused so the Worker can never be coerced into
 * relaying payload. Pure predicate.
 */

export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

export function isWithinSizeCap(byteLength: number, cap: number = MAX_SIGNALING_MESSAGE_BYTES): boolean {
  return Number.isInteger(byteLength) && byteLength >= 0 && byteLength <= cap;
}
