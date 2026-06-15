/**
 * Pure request-routing decision for the signaling Worker. Maps an inbound HTTP
 * request to a typed action; no I/O, no Worker types. The Worker (thin
 * adapter) executes the decision.
 */

import { parseSessionCodeFromUrl } from './url.js';

export const MINT_PATH = '/new';

export type RouteDecision =
  | { readonly kind: 'mint' }
  | { readonly kind: 'pair'; readonly code: string }
  | { readonly kind: 'reject'; readonly status: number; readonly reason: string };

export function routeRequest(method: string, url: string, isWebSocketUpgrade: boolean): RouteDecision {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { kind: 'reject', status: 400, reason: 'bad-url' };
  }
  if (pathname === MINT_PATH) {
    if (method !== 'POST') {
      return { kind: 'reject', status: 405, reason: 'mint-requires-post' };
    }
    return { kind: 'mint' };
  }
  if (!isWebSocketUpgrade) {
    return { kind: 'reject', status: 426, reason: 'expected-websocket-upgrade' };
  }
  const code = parseSessionCodeFromUrl(url);
  if (!code) {
    return { kind: 'reject', status: 404, reason: 'invalid-session-code' };
  }
  return { kind: 'pair', code };
}
