// The 3D model's team on node's worker_threads (src/mpm/solid/team.ts): `nodeTeam(size)` for tools and checks.
import { Worker } from 'node:worker_threads';
import { Team } from '../../src/mpm/solid/team.ts';

export function nodeTeam(size, opts = {}) {
  return new Team(size, () => {
    const w = new Worker(new URL('./solid-helper.mjs', import.meta.url));
    let handler = null;
    w.on('message', (m) => handler?.(m));
    return {
      postMessage: (m) => w.postMessage(m),
      get onmessage() {
        return handler;
      },
      set onmessage(h) {
        handler = h;
      },
      terminate: () => void w.terminate(),
    };
  }, opts);
}
