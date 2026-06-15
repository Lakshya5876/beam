import { defineConfig } from 'vite';

// Browser build for the viewer. Output to dist/ — the directory a future
// Cloudflare Pages deployment (S17) serves. NO deploy happens here.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
