// Runs the three-dimensional model (src/mpm/solid/sim3.ts) in its own thread and streams the strip's faces to
// the page. The steady values are read as tools/solid.mjs reads them (a look every READ_STEPS steps).
import { Sim3, solidParams } from '../mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../mpm/solid/steady.ts';
import { faces } from '../mpm/solid/surface.ts';
import { karman } from '../mpm/slab.ts';
import type { FromSolidWorker, SolidFieldName, SolidFrame, ToSolidWorker } from './solidProtocol.ts';

let sim: Sim3 | null = null;
let sampler: SolidSampler | null = null;
let field: SolidFieldName = 'seq';
let running = false;
let finished = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
let history: { t: number[]; force: number[] } = { t: [], force: [] };

// a frame of the faces is light, but a step is heavy (tens of ms on a fine grid): a frame at least every FRAME_MS
const FRAME_MS = 80;

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
  }
}

function frame(): void {
  if (!sim) return;
  const s = sim;
  const fs = faces(s, fieldValue(s, field));
  const edge = s.edgeProfile();
  const msg: SolidFrame = {
    type: 'frame',
    faces: fs,
    field,
    edgeX: Float32Array.from(edge.x),
    edgeHalfWidth: Float32Array.from(edge.halfWidth),
    diag: {
      t: s.t,
      step: s.step,
      phase: s.phase(),
      now: sampler!.last,
      steady: sampler!.means(s),
      nFailed: s.nFailed,
      maxDamage: s.maxDamage(),
      firstCrack: s.firstCrack,
      inertiaRatio: s.inertiaRatio,
    },
    history: { t: history.t.slice(), force: history.force.slice() },
    running,
    msPerStep,
  };
  post(msg, [...fs.flatMap((f) => [f.pos.buffer, f.val.buffer, f.failed.buffer]), msg.edgeX.buffer, msg.edgeHalfWidth.buffer]);
}

function look(s: Sim3): void {
  const l = sampler!.look(s);
  history.t.push(s.t);
  history.force.push(l.force);
  if (l.phase === 'done' || l.phase === 'stalled') finished = true;
}

function loop(): void {
  timer = null;
  if (!sim || !running) return;
  const s = sim;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  while (performance.now() - t0 < FRAME_MS && !finished) {
    let chunk = Math.min(5, READ_STEPS - (s.step % READ_STEPS));
    if (stopAfter !== null) chunk = Math.min(chunk, stopAfter - s.step);
    for (let k = 0; k < chunk; k++) s.advance();
    steps += Math.max(0, chunk);
    if (s.step % READ_STEPS === 0) look(s);
    if (stopAfter !== null && s.step >= stopAfter) {
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

self.onmessage = (e: MessageEvent<ToSolidWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        finished = false;
        field = m.field;
        stopAfter = m.stopAfter;
        history = { t: [], force: [] };
        sim = new Sim3(solidParams(m.params, m.solid));
        sampler = new SolidSampler();
        // headless checks can read the simulation through the worker target
        (self as unknown as { __solid: Sim3 }).__solid = sim;
        post({
          type: 'ready',
          geometry: {
            n: sim.n,
            lattice: [sim.NI, sim.NJ, sim.NK],
            h: sim.h,
            dt: sim.dt,
            h0: m.params.rolling.h0,
            gap: sim.gap,
            rollRadius: sim.roll.R,
            contactLength: sim.contactLength,
            xExitProbe: sim.xExitProbe,
            halfWidth0: sim.halfWidth0,
            mapX0: sim.ox + sim.binCol0 * sim.h,
            slabForce: karman(m.params.rolling, m.params.material).force,
          },
        });
        frame();
        break;
      }
      case 'run':
        if (sim && !running && !finished) {
          running = true;
          loop();
        }
        break;
      case 'pause':
        running = false;
        frame();
        break;
      case 'field':
        field = m.field;
        if (!running) frame();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
