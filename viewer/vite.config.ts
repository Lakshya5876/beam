import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Browser build for the viewer. Output to dist/ — the directory a future
// Cloudflare Pages deployment (S17) serves. NO deploy happens here.
//
// Two outputs:
//   dist/index.html + assets/  — main app bundle (from index.html / src/main.ts)
//   dist/sw.js                 — service worker (fixed filename, no content hash)
//
// S17 obligation: dist/sw.js must be served with the response header
//   Service-Worker-Allowed: /
// so the scope:'/' registration in bootstrap.ts succeeds without SecurityError.
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
          // Fixed filename for the SW — it must be at a stable URL for re-registration
          if (chunk.name === 'sw') return 'sw.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
