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
