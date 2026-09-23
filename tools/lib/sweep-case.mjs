// One condition of a sweep (src/mpm/solid/sweep.ts) on a worker thread: tools/sweep.mjs --jobs N spawns these.
import { parentPort } from 'node:worker_threads';
import { runCase } from '../../src/mpm/solid/sweepRun.ts';

parentPort.on('message', ({ index, P, values, stands, handoff }) => {
  const t0 = performance.now();
  try {
    const result = runCase(P, values, stands, handoff);
    parentPort.postMessage({ index, result, seconds: (performance.now() - t0) / 1e3 });
  } catch (e) {
    parentPort.postMessage({ index, error: String(e?.message ?? e), seconds: (performance.now() - t0) / 1e3 });
  }
});
