import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // worker.ts + session-do.ts are runtime-bound Workers/DO adapters (WS
      // hibernation, DO storage) — not unit-testable in Node; their live
      // behavior is verified at S18 on a real Worker. The coverage gate scopes
      // to the pure, unit-testable logic.
      exclude: ['src/worker.ts', 'src/session-do.ts'],
      thresholds: { lines: 80 },
      reporter: ['text'],
    },
  },
});
