import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts (build entry) and browser-capabilities.ts (impure DOM-global
      // boundary) are runtime-bound and verified at S18; the coverage gate
      // scopes to the pure, unit-testable logic.
      exclude: ['src/main.ts', 'src/browser-capabilities.ts'],
      thresholds: { lines: 80 },
      reporter: ['text'],
    },
  },
});
