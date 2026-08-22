import nodeDataChannel from 'node-datachannel';

/**
 * Guards node-datachannel's native cleanup() so it only ever fires once per
 * process, regardless of how many test files call this.
 *
 * Root cause this fixes: two independent test files
 * (tests/infrastructure/peer-connection.test.ts and
 * tests/infrastructure/signaling-client.test.ts) each register their own
 * `afterAll(() => nodeDataChannel.cleanup())`. cleanup() is a bare,
 * unguarded call straight into the native binding (node_modules/node-
 * datachannel/src/lib/index.ts) with no idempotency of its own — calling it
 * a second time in the same process hangs natively ("libdatachannel error#
 * cleanup timeout (possible deadlock)").
 *
 * Vitest's default fork pool isolates test files into worker processes, but
 * when there are more test files than available CPU cores it batches
 * multiple files into the SAME forked process rather than spawning one per
 * file. GitHub Actions' standard ubuntu-latest runners have few cores, so
 * this repo's test files reliably get batched there — landing both
 * node-datachannel-using files in one process — while a developer's own
 * machine, with more cores, is far more likely to isolate every file into
 * its own process and never observe the double-invocation at all. That
 * mismatch is why this only failed in CI, not locally.
 */
let cleaned = false;

export function cleanupNativeOnce(): void {
  if (cleaned) return;
  cleaned = true;
  nodeDataChannel.cleanup();
}
