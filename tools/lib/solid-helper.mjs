// A worker of the 3D model's team (src/mpm/solid/team.ts) in node: tools/solid.mjs --threads N spawns these.
import { parentPort } from 'node:worker_threads';
import { runWorker } from '../../src/mpm/solid/team.ts';

let handler = null;
const port = {
  postMessage: (m) => parentPort.postMessage(m),
  get onmessage() {
    return handler;
  },
  set onmessage(h) {
    handler = h;
  },
  terminate: () => process.exit(0),
};
parentPort.on('message', (m) => handler?.(m));
runWorker(port);
