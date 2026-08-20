/**
 * Render helpers for unsupported-browser, connection-failed, and connecting states.
 * Pure HTML generation (no DOM mutations).
 */

export function renderUnsupported(missing: readonly string[]): string {
  return `Unsupported browser. Missing: ${missing.join(', ')}`;
}

export function renderConnecting(): string {
  return 'Browser supported — connecting…';
}

/**
 * The connected shell: the tunneled app is embedded in an iframe rather than
 * rendered directly into the top-level document. The RTCPeerConnection, the
 * Service Worker registration, and the DataChannel mux all live in THIS
 * outer document — a full-page navigation inside the iframe (client-side
 * routed or genuine server-rendered) never unloads them, so it does not tear
 * down the tunnel. The service worker relays the iframe's navigations too
 * (see sw-fetch-gate.ts shouldBypassRelay's destination==='iframe' case).
 */
export function renderConnectedShell(): string {
  // referrerpolicy="same-origin": the FIRST navigation into this iframe is
  // how the Service Worker attributes that request to this exact session
  // before the iframe has a client of its own to identify itself by (see
  // sw.ts resolveSession / SECURITY_AUDIT_20-08.md finding #1) — it reads
  // the outer document's own URL (which carries the session code) from the
  // navigation's Referer. Pinning the policy explicitly means that
  // continues to work even if a future response header or default policy
  // change would otherwise suppress it, while still sending no referrer at
  // all for any cross-origin request the tunneled app's own iframe later
  // makes on its own.
  return `<iframe id="beam-frame" title="Tunneled application" referrerpolicy="same-origin" style="position:fixed;inset:0;width:100%;height:100%;border:0;"></iframe>`;
}

export function renderFailed(reason: string): string {
  return `Connection failed: ${reason}`;
}

export function renderPinEntry(): string {
  return `<form id="beam-pin-form">
  <p>Enter the session code shown in the host terminal.</p>
  <label for="beam-pin">Session code</label>
  <input id="beam-pin" type="text" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="000 000" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>`;
}

export function renderPinFailed(attemptsLeft: number): string {
  return `<form id="beam-pin-form">
  <p class="beam-error">Wrong code — ${String(attemptsLeft)} attempt${attemptsLeft === 1 ? '' : 's'} remaining.</p>
  <label for="beam-pin">Session code</label>
  <input id="beam-pin" type="text" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="000 000" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>`;
}

export function renderPinLocked(): string {
  return `<p>Session locked — too many incorrect attempts. Ask the host to start a new session.</p>`;
}
