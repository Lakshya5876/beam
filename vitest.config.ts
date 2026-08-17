import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Coverage floor.
      thresholds: { lines: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
