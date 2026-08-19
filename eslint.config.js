import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', 'dist/', 'viewer/dist/**', 'e2e-*.mjs', 'signaling/worker-configuration.d.ts', '**/.wrangler/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Cyclomatic complexity ceiling.
      complexity: ['error', 10],
    },
  },
);
