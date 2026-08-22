import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Default 10_000ms is too tight for node-datachannel's native cleanup()
    // in tests/infrastructure/{signaling-client,peer-connection}.test.ts's
    // afterAll on GitHub Actions' ubuntu-latest runners specifically — it
    // can genuinely take longer than 10s to settle there (unreproducible on
    // Windows). See tests/fixtures/native-cleanup.ts for the full
    // investigation; this and that file's try/catch address two DIFFERENT
    // failure shapes of the same underlying native flakiness (a slow-but-
    // eventually-throwing call needs the catch; a call slower than the hook
    // timeout needs this, since Vitest kills the hook itself before the
    // catch ever gets a chance to run).
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Coverage floor.
      thresholds: { lines: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
