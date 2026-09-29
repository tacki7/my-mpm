import { defineConfig, type Plugin } from 'vite';
import { machineStats } from './tools/remote/stats.mjs';

/** the page cross-origin isolated, so that the 3D model's team of workers can share memory (SharedArrayBuffer, src/mpm/solid/team.ts) */
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

/** this machine's CPU, memory and GPU use at /__stats, for the meters at the top of the page (src/app/machineStats.ts) */
function statsEndpoint(): Plugin {
  let stats: ReturnType<typeof machineStats> | null = null;
  const serve = (server: { middlewares: { use: (path: string, fn: (req: unknown, res: { setHeader: (k: string, v: string) => void; end: (s: string) => void }) => void) => void } }) => {
    stats ??= machineStats(1000);
    server.middlewares.use('/__stats', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(stats!.latest()));
    });
  };
  return { name: 'machine-stats', configureServer: serve, configurePreviewServer: serve };
}

export default defineConfig({
  plugins: [statsEndpoint()],
  server: { port: 5173, open: false, headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
