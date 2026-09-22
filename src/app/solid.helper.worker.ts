// A worker of the 3D model's team (src/mpm/solid/team.ts) in the browser: the coordinator is solid.worker.ts.
import { runWorker, type TeamPort } from '../mpm/solid/team.ts';

let handler: TeamPort['onmessage'] = null;
const port: TeamPort = {
  postMessage: (m) => (self as unknown as Worker).postMessage(m),
  get onmessage() {
    return handler;
  },
  set onmessage(h) {
    handler = h;
  },
  terminate: () => self.close(),
};
self.onmessage = (e: MessageEvent) => handler?.(e.data);
runWorker(port);
