/**
 * Viewer bootstrap entry (S15a: minimal). Proves the bundle includes feature
 * detection AND the CORE shared framing by genuinely round-tripping a frame
 * through the shared codec at startup. The full bootstrap — service-worker
 * registration with clients.claim, the viewer-side RTCPeerConnection, and the
 * unsupported / connection-failed pages — is S15b and S16.
 */

import { readBrowserCapabilities } from './browser-capabilities.js';
import { detectSupport } from './feature-detect.js';
import {
  createFramePayload,
  createStreamId,
  decodeFrame,
  encodeFrame,
  FrameType,
  isFrameDecodeError,
  isInvalidStreamIdError,
  isPayloadTooLargeError,
} from './protocol-bridge.js';
import { bootstrap } from './bootstrap.js';

/** Startup self-check: a frame round-trips through the SHARED codec. */
function sharedProtocolReady(): boolean {
  const streamId = createStreamId(1);
  if (isInvalidStreamIdError(streamId)) {
    return false;
  }
  const payload = createFramePayload(new Uint8Array([1, 2, 3]));
  if (isPayloadTooLargeError(payload)) {
    return false;
  }
  const decoded = decodeFrame(encodeFrame({ type: FrameType.PING, streamId, payload }));
  return !isFrameDecodeError(decoded);
}

const verdict = detectSupport(readBrowserCapabilities());
const protocolReady = sharedProtocolReady();

const root = document.getElementById('beam-root');
if (root) {
  if (!verdict.supported) {
    root.textContent = `Unsupported browser. Missing: ${verdict.missing.join(', ')}`;
  } else if (!protocolReady) {
    root.textContent = 'Internal error: shared protocol failed self-check.';
  } else {
    // S15b: bootstrap the viewer connection orchestration
    // Fallback matches `wrangler dev` (local signaling worker) on its default
    // port. Production viewers always arrive with ?signaling=<deployed-url>.
    const signalingBaseUrl = new URL(document.location.href).searchParams.get('signaling') || 'ws://127.0.0.1:8787';
    bootstrap(signalingBaseUrl).catch((err) => {
      if (root) root.textContent = `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`;
    });
  }
}
