/**
 * Pure URL construction for the viewer signaling WebSocket.
 * Achieves byte-identity with S8's buildUrl and S14's parser (URL triangle).
 */

export function buildViewerSignalingUrl(baseUrl: string, sessionCode: string): string {
  // S8 replica: strip trailing slashes, append code
  return `${baseUrl.replace(/\/+$/, '')}/${sessionCode}`;
}
