import { defineConfig } from 'vite';

/** the page cross-origin isolated, so that the 3D model's team of workers can share memory (SharedArrayBuffer, src/mpm/solid/team.ts) */
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  server: { port: 5173, open: false, headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
