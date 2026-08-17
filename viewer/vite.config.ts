import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Browser build for the viewer. Output to dist/ — the directory a future
// Cloudflare Pages deployment (S17) serves. NO deploy happens here.
//
// Three outputs:
//   dist/index.html + assets/  — main app bundle (from index.html / src/main.ts)
//   dist/__beam/sw.js          — service worker (fixed path + filename, no content hash)
//   dist/__beam/ws-shim.js     — WebSocket shim injected into relayed HTML
//                                 responses (see src/application/html-injection.ts
//                                 on the host side); fixed path for the same reason.
//
// Both live under dist/__beam/ so that when Pages serves dist/ at root /, they
// are reachable at /__beam/sw.js and /__beam/ws-shim.js — matching the
// register() call in bootstrap.ts / the injected <script src> and the
// path-exclusion predicate in sw-fetch-gate.ts (startsWith('/__beam/')).
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
        'ws-shim': resolve(__dirname, 'src/ws-shim.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          // Fixed path+filename: dist/__beam/<name>.js → served at /__beam/<name>.js by Pages.
          // Must match bootstrap.ts register('/__beam/sw.js'), the injected
          // <script src="/__beam/ws-shim.js">, and the sw-fetch-gate.ts exclusion predicate.
          if (chunk.name === 'sw') return '__beam/sw.js';
          if (chunk.name === 'ws-shim') return '__beam/ws-shim.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
