// The page's workers on this machine, for a page open on another one (src/app/remote.ts): each WebSocket on
// /worker?kind=<file> is one worker (src/app/<file>, on node's worker_threads through host.mjs, with WebGPU
// through Dawn), its messages passed through as src/app/remoteCodec.ts's frames; /hello says what the machine
// has (cores, the GPU the 3D model would step on), /stats how busy it is (stats.mjs).
//
// Listens on 127.0.0.1 only: the page reaches it through an SSH tunnel (tools/remote/start.sh:
// ssh -L <port>:127.0.0.1:<port>), so nothing is open to the network and there is no firewall rule to add.
//
//   cd tools/remote && npm install          # ws, webgpu (Dawn's prebuilt binaries)
//   node tools/remote/server.mjs [--port 8790] [--exit-with-stdin]
//
// --exit-with-stdin: end when stdin closes (the SSH session that started it has gone).
import http from 'node:http';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import { machineStats } from './stats.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const port = Number(opt('port', 8790));
const KINDS = new Set(['sim.worker.ts', 'plan.worker.ts', 'solid.worker.ts', 'sweep.worker.ts']);
const APP = new URL('../../src/app/', import.meta.url);
const HOST = new URL('./host.mjs', import.meta.url);

/** the adapter the 3D model's worker would get (requestGpu: the high-performance one) */
async function gpuInfo() {
  try {
    const { create, globals } = await import('webgpu');
    Object.assign(globalThis, globals);
    const a = await create([]).requestAdapter({ powerPreference: 'high-performance' });
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : null;
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

const gpu = await gpuInfo();
const stats = machineStats(1000);
const sessions = new Set();

const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/hello') {
    res.writeHead(200, cors).end(JSON.stringify({ host: os.hostname(), platform: process.platform, cores: os.cpus().length, memTotal: os.totalmem(), gpu, node: process.version, workers: sessions.size }));
  } else if (url.pathname === '/stats') {
    res.writeHead(200, cors).end(JSON.stringify({ ...stats.latest(), workers: sessions.size }));
  } else if (url.pathname === '/quit') {
    res.writeHead(200, cors).end('{"quit":true}');
    setTimeout(() => process.exit(0), 50);
  } else res.writeHead(404, cors).end('{}');
});

const wss = new WebSocketServer({ server, path: '/worker', maxPayload: 256 * 2 ** 20 });
wss.on('connection', (ws, req) => {
  const kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind') ?? '';
  if (!KINDS.has(kind)) {
    ws.close(1008, 'unknown worker');
    return;
  }
  const w = new Worker(HOST, { workerData: { entry: new URL(kind, APP).href, wire: true } });
  const session = { kind, w };
  sessions.add(session);
  log(`+ ${kind} (${sessions.size} open)`);
  w.on('message', (buf) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(buf));
  });
  // an error the worker's own code did not catch: to the page as the browser's worker would (its onerror)
  w.on('error', (err) => {
    log(`! ${kind}: ${err?.stack ?? err}`);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ error: String(err?.message ?? err) }));
  });
  w.on('exit', () => {
    if (ws.readyState === ws.OPEN) ws.close(1000, 'worker ended');
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    w.postMessage(ab, [ab]);
  });
  ws.on('close', () => {
    sessions.delete(session);
    void w.terminate();
    log(`- ${kind} (${sessions.size} open)`);
  });
});

function log(s) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // an earlier server still holds the port (its SSH session went without it): ask it to go, then take the port
  log(`port ${port} in use: asking the server there to quit`);
  await fetch(`http://127.0.0.1:${port}/quit`).catch(() => null);
  setTimeout(() => server.listen(port, '127.0.0.1'), 800);
});
server.listen(port, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${port}  cores ${os.cpus().length}  gpu ${gpu && !gpu.error ? `${gpu.vendor} ${gpu.device}` : gpu?.error ?? 'none'}`);
  // the launcher waits for this line
  console.log('READY');
});

if (argv.includes('--exit-with-stdin')) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();
}
