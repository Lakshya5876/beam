import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Browser build for the viewer. Output to dist/ — the directory a future
// Cloudflare Pages deployment (S17) serves. NO deploy happens here.
//
// Two outputs:
//   dist/index.html + assets/  — main app bundle (from index.html / src/main.ts)
//   dist/__beam/sw.js          — service worker (fixed path + filename, no content hash)
//
// The SW lives under dist/__beam/ so that when Pages serves dist/ at root /,
// the SW is reachable at /__beam/sw.js — matching the register() call in
// bootstrap.ts and the path-exclusion predicate in sw.ts (startsWith('/__beam/')).
//
// dist/public/_headers applies Service-Worker-Allowed: / to /__beam/sw.js so
// the scope:'/' registration in bootstrap.ts succeeds without SecurityError.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sw: resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          // Fixed path+filename for SW: dist/__beam/sw.js → served at /__beam/sw.js by Pages.
          // Must match bootstrap.ts register('/__beam/sw.js') and sw.ts exclusion predicate.
          if (chunk.name === 'sw') return '__beam/sw.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
