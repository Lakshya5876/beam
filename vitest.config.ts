import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // COVERAGE GATE floor — mirrors COVERAGE_THRESHOLD in
      // .claude/gate_state.json; gate.sh may override via CLI flag.
      // Human-PR change only.
      thresholds: { lines: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
