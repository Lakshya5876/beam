import { describe, it, expect } from 'vitest';
import { renderConnecting, renderFailed, renderUnsupported } from '../src/pages.js';

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
});
