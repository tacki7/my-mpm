// One of the page's workers (src/app/*.worker.ts) on node's worker_threads, for tools/remote/server.mjs: the globals
// a dedicated worker has (self, onmessage, postMessage, close, Worker, crossOriginIsolated, navigator.gpu) laid over
// node's, then the worker's own module. `wire`: the messages to and from the page are src/app/remoteCodec.ts's
// binary frames (the server passes them through as they are); a helper worker the worker starts itself (the 3D
// model's team) talks plain structured clones with it, as in the browser.
import { parentPort, workerData, Worker as NodeWorker } from 'node:worker_threads';

const { entry, wire } = workerData;
const codec = wire ? await import('../../src/app/remoteCodec.ts') : null;

globalThis.self = globalThis;
globalThis.crossOriginIsolated = true;
globalThis.close = () => process.exit(0);

// messages that come before the module has set its onmessage wait for it
let handler = null;
const early = [];
Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  get: () => handler,
  set: (h) => {
    handler = h;
    while (handler && early.length) handler({ data: early.shift() });
  },
});
parentPort.on('message', (m) => {
  const data = codec ? codec.decode(m) : m;
  if (handler) handler({ data });
  else early.push(data);
});
globalThis.postMessage = (m, transfer) => {
  if (codec) {
    const buf = codec.encode(m);
    parentPort.postMessage(buf, [buf]);
  } else parentPort.postMessage(m, transfer);
};

// the worker's own workers (src/app/solid.helper.worker.ts), on this same host
globalThis.Worker = class {
  onmessage = null;
  onerror = null;
  constructor(url) {
    this.w = new NodeWorker(new URL(import.meta.url), { workerData: { entry: String(url), wire: false } });
    this.w.on('message', (data) => this.onmessage?.({ data }));
    this.w.on('error', (e) => this.onerror?.({ message: e.message }));
  }
  postMessage(m, transfer) {
    this.w.postMessage(m, transfer);
  }
  terminate() {
    void this.w.terminate();
  }
};

// WebGPU through Dawn (the `webgpu` package; the page's own worker only, its helpers step on the CPU): the
// GPU* constants at once, the adapter's entry point when the worker first asks for it
const dawn = wire ? await import('webgpu').catch(() => null) : null;
if (dawn) Object.assign(globalThis, dawn.globals);
let gpu;
Object.defineProperty(globalThis.navigator, 'gpu', {
  configurable: true,
  get: () => {
    if (gpu === undefined) {
      try {
        gpu = dawn ? dawn.create([]) : null;
      } catch {
        gpu = null;
      }
    }
    return gpu ?? undefined;
  },
});

await import(entry);
