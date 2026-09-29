// Where the page's workers compute: on this machine (the browser's own workers), or on another one — winpc, a
// Windows PC with a discrete GPU — through tools/remote/server.mjs, which runs the same worker modules on
// node (worker_threads, WebGPU through Dawn) and passes their messages over a WebSocket (remoteCodec.ts).
// A remote worker is a stand-in for `Worker` with the same postMessage / onmessage / onerror / terminate, so
// the modes do not know the difference.
//
// The place is the URL's `at` (mac | winpc), else the one chosen last (localStorage); the server's address is
// `remote` (host:port), else localhost:8790 — the SSH tunnel tools/remote/start.sh opens. Choosing another place
// reloads the page (every worker starts over there). The server is asked what it has (/hello) before the modes
// are made: their thread and GPU choices are the computing machine's. Where it does not answer, the page
// computes here and says why (`remote.note`).
import { decode, encode } from './remoteCodec.ts';

export type Place = 'mac' | 'winpc';

/** what the server's machine has (tools/remote/server.mjs /hello) */
export interface RemoteHello {
  host: string;
  platform: string;
  cores: number;
  memTotal: number;
  gpu: { vendor: string; architecture: string; device: string; description: string } | { error: string } | null;
  node: string;
}

const KEY_AT = 'mpm.at';
const KEY_ADDR = 'mpm.remote';
const inPage = typeof location !== 'undefined';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const query = inPage ? new URLSearchParams(location.search) : new URLSearchParams();
const asked = query.get('at') ?? stored(KEY_AT);
/** the place asked for */
export const WANT: Place = asked === 'winpc' ? 'winpc' : 'mac';
/** the server's host:port */
export const REMOTE_ADDR = query.get('remote') ?? stored(KEY_ADDR) ?? 'localhost:8790';
export const REMOTE_NAME = 'winpc';

const platform = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : 'Mac';
/** the machine the browser runs on, which computes when the place is 'mac' (the page's own workers): 「この Mac」,
 *  or 「この PC」 when the page is opened on a PC (winpc's browser, through start.sh's reverse tunnel) */
export const LOCAL_NAME = /Mac/i.test(platform) ? 'この Mac' : 'この PC';
/** the browser runs on winpc itself: a Windows browser on localhost, which is the Mac's dev server through the
 *  launcher's reverse tunnel (the page's own workers then compute on winpc, and winpc's meters are this machine's) */
export const BROWSER_ON_REMOTE = /Win/i.test(platform) && inPage && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

async function hello(): Promise<RemoteHello | null> {
  try {
    const r = await fetch(`http://${REMOTE_ADDR}/hello`, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    return r.ok ? ((await r.json()) as RemoteHello) : null;
  } catch {
    return null;
  }
}

const answered = inPage && WANT === 'winpc' ? await hello() : null;

export const remote: { place: Place; hello: RemoteHello | null; note: string | null } = {
  place: answered ? 'winpc' : 'mac',
  hello: answered,
  note:
    WANT === 'winpc' && !answered
      ? `${REMOTE_NAME} の計算サーバに繋がらないので、${LOCAL_NAME}（このブラウザ）で計算している`
      : null,
};

/** the GPU the remote machine's 3D model would step on, or null */
export function remoteGpu(): { vendor: string; architecture: string; device: string; description: string } | null {
  const g = remote.hello?.gpu;
  return g && !('error' in g) ? g : null;
}

/** the logical cores of the machine that computes */
export const COMPUTE_CORES = Math.max(1, remote.hello?.cores ?? ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8));
/** the machine that computes can step the 3D model on a GPU */
export const COMPUTE_GPU = remote.place === 'winpc' ? remoteGpu() !== null : typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
/** the machine that computes can run the 3D model's team of threads (a remote node always can; a page must be cross-origin isolated) */
export const COMPUTE_THREADS =
  remote.place === 'winpc' || (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined');

/** the machine that computes, in words: 「この Mac」「この PC」 or 「winpc（<cores> コア・<GPU の名前>）」 */
export function placeLabel(): string {
  if (remote.place === 'mac') return LOCAL_NAME;
  const g = remoteGpu();
  return `${REMOTE_NAME}（${COMPUTE_CORES} コア${g ? `・${gpuName(g.device)}` : ''}）`;
}

/** an adapter's device id as a name: nvidia-geforce-rtx-3060-ti → GeForce RTX 3060 TI */
export function gpuName(device: string): string {
  return device
    .replace(/^nvidia-/, '')
    .split('-')
    .map((w) => (/^(rtx|gtx|gt|super|ti)$/.test(w) ? w.toUpperCase() : /^geforce$/.test(w) ? 'GeForce' : w))
    .join(' ');
}

/** choose where to compute: remembered, put in the URL, and the page reloaded (every worker starts over there) */
export function choosePlace(at: Place): void {
  try {
    localStorage.setItem(KEY_AT, at);
  } catch {
    // the URL carries it
  }
  const u = new URL(location.href);
  u.searchParams.set('at', at);
  u.searchParams.delete('autorun');
  location.assign(u.href);
}

/** a worker of src/app/<kind> on the remote machine, behind Worker's interface */
export function remoteWorker(kind: string): Worker {
  return new RemoteWorker(kind) as unknown as Worker;
}

class RemoteWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  private readonly ws: WebSocket;
  private readonly queue: ArrayBuffer[] = [];
  private ended = false;

  constructor(kind: string) {
    this.ws = new WebSocket(`ws://${REMOTE_ADDR}/worker?kind=${encodeURIComponent(kind)}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const b of this.queue.splice(0)) this.ws.send(b);
    };
    this.ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as { error?: string };
        if (m.error) this.fail(`${REMOTE_NAME} のワーカーで例外: ${m.error}`);
        return;
      }
      this.onmessage?.({ data: decode(e.data as ArrayBuffer) } as MessageEvent);
    };
    this.ws.onclose = (e) => {
      if (!this.ended) this.fail(`${REMOTE_NAME} との接続が切れた（${e.reason || e.code}）。npm run remote が動いているか確かめて、ページを開き直す`);
    };
  }

  private fail(message: string): void {
    this.ended = true;
    this.onerror?.({ message });
  }

  postMessage(m: unknown): void {
    const b = encode(m);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(b);
  }

  terminate(): void {
    this.ended = true;
    this.ws.close();
  }
}
