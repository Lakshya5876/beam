import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for the actual CI failure this file exists to
 * prevent: node-datachannel's native cleanup() intermittently throws
 * "libdatachannel error# cleanup timeout (possible deadlock)" on CI's Linux
 * runners after ~10s, even though every real test in the file that calls it
 * has already passed. See native-cleanup.ts's own doc for the full
 * investigation — this is the actual fix (catch it, never let best-effort
 * process hygiene fail an otherwise-green suite), not the double-invocation
 * guard or the disconnect() timing fix that came before it in that story
 * (both real, both kept, neither sufficient alone).
 */
vi.mock('node-datachannel', () => ({
  default: { cleanup: vi.fn() },
}));

describe('cleanupNativeOnce', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls the native cleanup exactly once even if imported/invoked multiple times', async () => {
    const nodeDataChannel = (await import('node-datachannel')).default;
    const { cleanupNativeOnce } = await import('./native-cleanup.js');
    cleanupNativeOnce();
    cleanupNativeOnce();
    cleanupNativeOnce();
    expect(nodeDataChannel.cleanup).toHaveBeenCalledTimes(1);
  });

  it('swallows a genuinely throwing native cleanup() rather than failing the suite', async () => {
    vi.doMock('node-datachannel', () => ({
      default: {
        cleanup: () => {
          throw new Error('libdatachannel error# cleanup timeout (possible deadlock)');
        },
      },
    }));
    const { cleanupNativeOnce } = await import('./native-cleanup.js');
    expect(() => { cleanupNativeOnce(); }).not.toThrow();
  });

  it('a throw on the first call still leaves the guard set — a later call is a silent no-op, not a retry', async () => {
    const cleanup = vi.fn(() => {
      throw new Error('libdatachannel error# cleanup timeout (possible deadlock)');
    });
    vi.doMock('node-datachannel', () => ({ default: { cleanup } }));
    const { cleanupNativeOnce } = await import('./native-cleanup.js');
    cleanupNativeOnce();
    cleanupNativeOnce();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
