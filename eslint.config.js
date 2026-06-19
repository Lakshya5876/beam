import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', 'dist/', 'viewer/dist/**', 'e2e-*.mjs', 'signaling/worker-configuration.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // COMPLEXITY GATE (CLAUDE.md / gate.sh): cyclomatic complexity ceiling.
      // Threshold mirrors COMPLEXITY_THRESHOLD in .claude/gate_state.json;
      // lowering/raising it is a human-PR change, never an agent edit.
      complexity: ['error', 10],
    },
  },
);
