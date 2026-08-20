import { describe, it, expect } from 'vitest';
import { renderConnectedShell, renderConnecting, renderFailed, renderUnsupported, renderPinEntry, renderPinFailed, renderPinLocked } from '../src/pages.js';

describe('pages (pure render helpers)', () => {
  it('renders unsupported browser message', () => {
    const html = renderUnsupported(['WebRTC', 'Service Worker']);
    expect(html).toContain('Unsupported browser');
    expect(html).toContain('WebRTC');
    expect(html).toContain('Service Worker');
  });

  it('renders connecting message', () => {
    const html = renderConnecting();
    expect(html).toContain('connecting');
  });

  it('renders failed message with reason', () => {
    const html = renderFailed('timeout');
    expect(html).toContain('failed');
    expect(html).toContain('timeout');
  });

  it('renders the connected shell as an iframe (no src set — bootstrap sets it after mount)', () => {
    const html = renderConnectedShell();
    expect(html).toContain('<iframe');
    expect(html).toContain('id="beam-frame"');
    expect(html).not.toContain('src=');
  });

  it('pins referrerpolicy="same-origin" so the SW can attribute the first iframe navigation to its session (SECURITY_AUDIT_20-08.md #1)', () => {
    const html = renderConnectedShell();
    expect(html).toContain('referrerpolicy="same-origin"');
  });
});

describe('PIN pages', () => {
  it('renderPinEntry() contains a form, a text input, and a submit button', () => {
    const html = renderPinEntry();
    expect(html).toContain('<form');
    expect(html).toContain('<input');
    expect(html).toContain('type="submit"');
  });

  it('renderPinFailed(2) shows "2" and "attempt" text', () => {
    const html = renderPinFailed(2);
    expect(html).toContain('2');
    expect(html).toContain('attempt');
  });

  it('renderPinFailed(1) uses singular "attempt"', () => {
    const html = renderPinFailed(1);
    expect(html).toContain('1 attempt remaining');
  });

  it('renderPinLocked() contains "locked"', () => {
    const html = renderPinLocked();
    expect(html.toLowerCase()).toContain('locked');
  });
});
