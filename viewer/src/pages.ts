/**
 * Render helpers for unsupported-browser, connection-failed, and connecting states.
 * Pure HTML generation (no DOM mutations).
 */

export function renderUnsupported(missing: string[]): string {
  return `Unsupported browser. Missing: ${missing.join(', ')}`;
}

export function renderConnecting(): string {
  return 'Browser supported — connecting…';
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
