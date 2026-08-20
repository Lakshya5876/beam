import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // worker.ts is a thin, runtime-bound Worker fetch entry (no logic of
      // its own beyond dispatch) — its live behavior is verified at S18 on a
      // real Worker. session-do.ts USED to be excluded here too ("not
      // unit-testable in Node"), which was only true for acceptPeer()'s
      // `new WebSocketPair()` call — test/session-do.test.ts now drives every
      // other entry point (webSocketMessage/webSocketClose/webSocketError/
      // alarm) against hand-rolled fakes of the DurableObjectState/WebSocket
      // globals (see that file's doc and tsconfig.do-test.json), closing the
      // regression-coverage gap SECURITY_AUDIT_20-08.md finding #7 flagged in
      // exactly this file's most security-critical module.
      exclude: ['src/worker.ts'],
      thresholds: { lines: 80 },
      reporter: ['text'],
    },
  },
});
