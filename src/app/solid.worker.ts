// Runs the three-dimensional model (src/mpm/solid/sim3.ts) in its own thread and streams the strip's faces to
// the page. The steady values are read as tools/solid.mjs reads them (a look every READ_STEPS steps).
import { solidParams, type Sim3 } from '../mpm/solid/sim3.ts';
import { READ_STEPS, type SolidLook } from '../mpm/solid/steady.ts';
import { Tandem3 } from '../mpm/solid/tandem3.ts';
import { requestGpu, type GpuInfo } from '../mpm/solid/gpu/stepper.ts';
import { Team, type TeamPort } from '../mpm/solid/team.ts';
import { CTL_EVERY } from '../mpm/solver.ts';
import { standProgress3 } from '../mpm/solid/progress3.ts';
import { faces } from '../mpm/solid/surface.ts';
import { Tracker3 } from './tracker3.ts';
import { karman } from '../mpm/slab.ts';
import { SOLID_FIELD_IDS, type Compute, type FromSolidWorker, type SolidFieldName, type SolidFrame, type ToSolidWorker } from './solidProtocol.ts';

let tandem: Tandem3 | null = null;
let tracker: Tracker3 | null = null;
let running = false;
let finished = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
let history: { t: number[]; force: number[]; stand: number[] } = { t: [], force: [], stand: [] };
/** rows of the history the frames have carried so far */
let historySent = 0;
/** where the step runs (the init's choice, or the CPU where the GPU was asked for but is not there), and why */
let compute: Compute = 'cpu';
let gpuInfo: GpuInfo | null = null;
let gpuNote: string | null = null;
let gpuDevice: GPUDevice | null = null;
/** the team of helper workers the CPU's step runs on (kept across inits of the same size), and why it is smaller than asked for */
let team: Team | null = null;
let threads = 1;
let threadsNote: string | null = null;
/** an init that came while the GPU was being asked for is the one to keep */
let initSeq = 0;

// a frame of the faces is light, but a step is heavy (tens of ms on a fine grid): a frame at least every FRAME_MS
const FRAME_MS = 80;
/** the interval between frames the page asked for (a 'frame-ms' message; FRAME_MS when it asks for the worker's own) */
let frameMs = FRAME_MS;

function post(msg: FromSolidWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

/** the field in display units: stresses in MPa, the lateral displacement in mm */
function fieldValue(s: Sim3, f: SolidFieldName): (p: number) => number {
  switch (f) {
    case 'seq':
      return (p) => s.seq[p] * 1e-6;
    case 'ep':
      return (p) => s.ep[p];
    case 'pres':
      return (p) => s.pres[p] * 1e-6;
    case 'eta':
      return (p) => s.eta[p];
    case 'sxx':
      return (p) => (s.sxx[p] - s.pres[p]) * 1e-6;
    case 'syy':
      return (p) => (s.syy[p] - s.pres[p]) * 1e-6;
    case 'szz':
      return (p) => (s.szz[p] - s.pres[p]) * 1e-6;
    case 'damage':
      return (p) => s.governingDamage(p);
    case 'spread':
      return (p) => (s.pz[p] - ((p % s.NK) + 0.5) * s.dz) * 1e3;
    case 'rate':
      return (p) => s.rate[p];
  }
}

function ready(T: Tandem3): void {
  const sim = T.sim;
  post({
    type: 'ready',
    geometry: {
      compute,
      gpu: compute === 'gpu' ? gpuInfo : null,
      gpuNote,
      threads,
      threadsNote,
      stand: T.stand,
      stands: T.stands,
      sheetLength: sim.params.rolling.sheetLength,
      n: sim.n,
      lattice: [sim.NI, sim.NJ, sim.NK],
      h: sim.h,
      dt: sim.dt,
      h0: sim.params.rolling.h0,
      gap: sim.gap,
      rollRadius: sim.roll.R,
      contactLength: sim.contactLength,
      xExitProbe: sim.xExitProbe,
      halfWidth0: sim.halfWidth0,
      crownIn: sim.params.solid.crownIn ?? 0,
      fullThickness: sim.fullThickness,
      mapX0: sim.ox + sim.binCol0 * sim.h,
      // a later stand's strip comes in hardened
      slabForce: karman(sim.params.rolling, sim.params.material, 2000, sim.params.rolling.entryStrain ?? 0).force,
    },
  });
  // headless checks can read the simulation through the worker target
  (self as unknown as { __solid: Sim3 }).__solid = sim;
}

function frame(): void {
  if (!tandem) return;
  const T = tandem;
  const s = T.sim;
  const fs = faces(s, SOLID_FIELD_IDS.map((f) => fieldValue(s, f)));
  const edge = s.edgeProfile();
  const msg: SolidFrame = {
    type: 'frame',
    faces: fs,
    edgeX: Float32Array.from(edge.x),
    edgeHalfWidth: Float32Array.from(edge.halfWidth),
    diag: {
      t: T.tOffset + s.t,
      step: T.stepOffset + s.step,
      stand: T.stand,
      finished,
      stopped: T.stopped,
      rollRadius: s.roll.R,
      gap: s.gap,
      rollsSettled: s.rollsSettled,
      rollBend: s.beam ? { centre: s.bend[1], edge: s.bendAt(s.halfWidth0), settled: s.bendSettled } : null,
      phase: s.phase(),
      progress: finished ? 1 : standProgress3(T),
      now: T.sampler.last,
      steady: T.sampler.means(s),
      nFailed: s.nFailed,
      maxDamage: s.maxDamage(),
      firstCrack: s.firstCrack,
      inertiaRatio: s.inertiaRatio,
      backTension: s.backNow,
      frontTension: s.frontNow,
    },
    history: { from: historySent, t: history.t.slice(historySent), force: history.force.slice(historySent), stand: history.stand.slice(historySent) },
    tracks: tracker ? tracker.tracks() : [],
    running,
    msPerStep,
  };
  historySent = history.t.length;
  post(msg, [...fs.flatMap((f) => [f.pos.buffer, f.vals.buffer, f.failed.buffer]), msg.edgeX.buffer, msg.edgeHalfWidth.buffer]);
}

/** a look's row on the history; the stand may have ended at it */
function afterLook(T: Tandem3, stand: number, t: number, l: SolidLook): void {
  history.t.push(t);
  history.force.push(l.force);
  history.stand.push(stand);
  if (T.done) finished = true;
  else if (T.stand !== stand) ready(T);
}

/** the steps of the next chunk: up to `most`, not past a look or the stop */
function chunkOf(T: Tandem3, most: number): number {
  const at = T.stepOffset + T.sim.step;
  let chunk = Math.min(most, READ_STEPS - (T.sim.step % READ_STEPS));
  if (stopAfter !== null) chunk = Math.min(chunk, stopAfter - at);
  return chunk;
}

function loop(): void {
  timer = null;
  if (!tandem || !running) return;
  if (compute === 'gpu') {
    void loopGpu();
    return;
  }
  if (team) {
    void loopTeam();
    return;
  }
  const T = tandem;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  while (performance.now() - t0 < frameMs && !finished) {
    const chunk = chunkOf(T, 5);
    for (let k = 0; k < chunk; k++) {
      const stand = T.stand;
      const t = T.tOffset + T.sim.t + T.sim.dt;
      const l = T.advance();
      // a look ends the chunk (chunks stop at the looks), and it may have ended the stand
      if (l) afterLook(T, stand, t, l);
    }
    // the paths, every chunk (at most 5 steps: the section model's tracker reads every 20)
    tracker?.record();
    steps += Math.max(0, chunk);
    if (stopAfter !== null && T.stepOffset + T.sim.step >= stopAfter) {
      reached = true;
      break;
    }
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  if (reached) stopAfter = null;
  if (finished || reached) running = false;
  frame();
  if (running) timer = setTimeout(loop, 0);
}

/**
 * The GPU's loop: batches of CTL_EVERY steps (Sim3.advanceBatch; fewer to land on a multiple of CTL_EVERY, a look
 * or the stop), awaited one after another, the paths recorded after each batch. A frame every FRAME_MS as the
 * CPU's loop. An init or a pause in the middle of a batch takes effect after it.
 */
async function loopGpu(): Promise<void> {
  const T = tandem!;
  const seq = initSeq;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  try {
    while (performance.now() - t0 < frameMs && !finished && running && seq === initSeq) {
      const chunk = chunkOf(T, CTL_EVERY - (T.sim.step % CTL_EVERY));
      if (chunk > 0) {
        const stand = T.stand;
        const t = T.tOffset + T.sim.t + chunk * T.sim.dt;
        const l = await T.advanceBatch(chunk);
        if (seq !== initSeq) return;
        if (l) afterLook(T, stand, t, l);
        tracker?.record();
        steps += chunk;
      }
      // the stop (already at it: a chunk of 0)
      if (stopAfter !== null && T.stepOffset + T.sim.step >= stopAfter) {
        reached = true;
        break;
      }
      if (chunk <= 0) break;
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
    return;
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  if (reached) stopAfter = null;
  if (finished || reached) running = false;
  frame();
  if (running) timer = setTimeout(loop, 0);
}

/**
 * The team's loop: the CPU's loop with Tandem3.advanceTeam (a promise, settled at once but where a stand ends
 * and the next attaches). A worker of the team that throws ends the pass with the error.
 */
async function loopTeam(): Promise<void> {
  const T = tandem!;
  const seq = initSeq;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  try {
    while (performance.now() - t0 < frameMs && !finished && running && seq === initSeq) {
      const chunk = chunkOf(T, 5);
      for (let k = 0; k < chunk; k++) {
        const stand = T.stand;
        const t = T.tOffset + T.sim.t + T.sim.dt;
        const l = await T.advanceTeam();
        if (seq !== initSeq) return;
        if (l) afterLook(T, stand, t, l);
      }
      tracker?.record();
      steps += Math.max(0, chunk);
      if (stopAfter !== null && T.stepOffset + T.sim.step >= stopAfter) {
        reached = true;
        break;
      }
    }
  } catch (err) {
    running = false;
    team?.close();
    team = null;
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
    return;
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  if (reached) stopAfter = null;
  if (finished || reached) running = false;
  frame();
  if (running) timer = setTimeout(loop, 0);
}

/** a helper worker of the team behind the port Team wants */
function spawnHelper(): TeamPort {
  const w = new Worker(new URL('./solid.helper.worker.ts', import.meta.url), { type: 'module' });
  let handler: TeamPort['onmessage'] = null;
  w.onmessage = (e: MessageEvent) => handler?.(e.data);
  return {
    postMessage: (m) => w.postMessage(m),
    get onmessage() {
      return handler;
    },
    set onmessage(h) {
      handler = h;
    },
    terminate: () => w.terminate(),
  };
}

/** the threads the CPU's step can run on: the team's size is what the Tandem3 is made for, so this is settled before it is made */
function threadsFor(want: number): number {
  threadsNote = null;
  const n = Math.max(1, Math.floor(want));
  if (n <= 1) return 1;
  if (typeof SharedArrayBuffer === 'undefined' || !(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
    threadsNote = 'このページは SharedArrayBuffer が使えない（cross-origin isolated でない）ので 1 スレッドで計算する';
    return 1;
  }
  return n;
}

/** the tandem of an init, made for `threads` (a Sim3 made for a team steps only its own share alone: one made anew when the team fails) */
function makeTandem(m: ToSolidWorker & { type: 'init' }): Tandem3 {
  const T = new Tandem3(solidParams(m.params, m.solid), m.stands, m.handoff, threads > 1 ? { shared: true, size: threads } : {});
  tandem = T;
  tracker = new Tracker3(T.sim);
  T.onStandDone = (e) => {
    // the stand's last steps go on its paths; the next stand's tracker carries them on (Sim3.parentOf)
    // and retires this one
    tracker?.record();
    post({ type: 'stand', result: e.result });
    if (e.next) tracker = new Tracker3(e.next, tracker);
  };
  return T;
}

/** the device for the step where it is asked for and there (once per worker; kept across inits), then the ready */
async function setCompute(m: ToSolidWorker & { type: 'init' }, seq: number): Promise<void> {
  const want = m.compute;
  let T = makeTandem(m);
  compute = 'cpu';
  gpuNote = null;
  if (want === 'cpu' && threads > 1) {
    try {
      if (team && team.size !== threads) {
        team.close();
        team = null;
      }
      if (!team) team = new Team(threads, spawnHelper);
      await T.useTeam(team);
      if (seq !== initSeq) return;
    } catch (err) {
      if (seq !== initSeq) return;
      team?.close();
      team = null;
      threadsNote = `スレッドが使えないので 1 スレッドで計算する（${String((err as Error)?.message ?? err)}）`;
      threads = 1;
      T = makeTandem(m);
    }
  }
  if (want === 'gpu') {
    try {
      if (!gpuDevice) {
        const r = await requestGpu();
        if (r) {
          gpuDevice = r.device;
          gpuInfo = r.info;
          void r.device.lost.then((info) => {
            gpuDevice = null;
            gpuInfo = null;
            if (compute === 'gpu') post({ type: 'error', message: `GPU が失われた（${info.message}）。条件を反映し直すと CPU で続けられる` });
          });
        }
      }
      if (seq !== initSeq) return;
      if (gpuDevice) {
        await T.useGpu(gpuDevice);
        if (seq !== initSeq) return;
        compute = 'gpu';
      } else gpuNote = 'この環境には WebGPU が無いので CPU で計算する';
    } catch (err) {
      if (seq !== initSeq) return;
      T.sim.detachGpu();
      gpuNote = `GPU が使えないので CPU で計算する（${String((err as Error)?.message ?? err)}）`;
    }
  }
  ready(T);
  frame();
}

self.onmessage = (e: MessageEvent<ToSolidWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        finished = false;
        initSeq++;
        stopAfter = m.stopAfter;
        history = { t: [], force: [], stand: [] };
        historySent = 0;
        tandem?.sim.detachGpu();
        threads = m.compute === 'cpu' ? threadsFor(m.threads) : 1;
        if (threads === 1 && team) {
          team.close();
          team = null;
        }
        void setCompute(m, initSeq);
        break;
      }
      case 'run':
        if (tandem && !running && !finished) {
          running = true;
          loop();
        }
        break;
      case 'pause':
        running = false;
        frame();
        break;
      case 'frame-ms':
        frameMs = m.ms > 0 ? m.ms : FRAME_MS;
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
