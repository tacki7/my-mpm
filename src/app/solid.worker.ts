// Runs the three-dimensional model (src/mpm/solid/sim3.ts) in its own thread and streams the strip's faces to
// the page. The steady values are read as tools/solid.mjs reads them (a look every READ_STEPS steps).
import { solidParams, type Sim3 } from '../mpm/solid/sim3.ts';
import { READ_STEPS } from '../mpm/solid/steady.ts';
import { Tandem3, steadyLength3 } from '../mpm/solid/tandem3.ts';
import { standEndTail, standProgress } from '../mpm/progress.ts';
import { faces } from '../mpm/solid/surface.ts';
import { Tracker3 } from './tracker3.ts';
import { karman } from '../mpm/slab.ts';
import { SOLID_FIELD_IDS, type FromSolidWorker, type SolidFieldName, type SolidFrame, type ToSolidWorker } from './solidProtocol.ts';

let tandem: Tandem3 | null = null;
let tracker: Tracker3 | null = null;
let running = false;
let finished = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
let history: { t: number[]; force: number[]; stand: number[] } = { t: [], force: [], stand: [] };

/** where each stand's tail began and where it is when the stand ends (src/mpm/progress.ts), found at the stand's first frame */
const tailSpan = new WeakMap<Sim3, [number, number]>();

/** how far the running stand is through its pass, 0..1 (for the page's estimate of the time left) */
function progressOf(T: Tandem3): number {
  const s = T.sim;
  let span = tailSpan.get(s);
  if (!span) {
    const tail0 = s.tailX();
    const length = s.headX() - tail0;
    // a stand with another after it hands on once it is steady: the first stand's strip may be longer than that
    // reading needs, the later ones are made that long
    const handsOn = T.handoff === 'steady' && T.stand < T.stands - 1;
    const need = !handsOn ? null : T.stand === 0 ? steadyLength3(s.params) : length;
    span = [tail0, standEndTail(s.params.rolling.h0, s.contactLength, length, need)];
    tailSpan.set(s, span);
  }
  return standProgress(s.tailX(), span[0], span[1], s.contactLength, s.params.rolling.reduction);
}

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

function ready(T: Tandem3): void {
  const sim = T.sim;
  post({
    type: 'ready',
    geometry: {
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
      progress: finished ? 1 : progressOf(T),
      now: T.sampler.last,
      steady: T.sampler.means(s),
      nFailed: s.nFailed,
      maxDamage: s.maxDamage(),
      firstCrack: s.firstCrack,
      inertiaRatio: s.inertiaRatio,
      backTension: s.backNow,
      frontTension: s.frontNow,
    },
    history: { t: history.t.slice(), force: history.force.slice(), stand: history.stand.slice() },
    tracks: tracker ? tracker.tracks() : [],
    running,
    msPerStep,
  };
  post(msg, [...fs.flatMap((f) => [f.pos.buffer, f.vals.buffer, f.failed.buffer]), msg.edgeX.buffer, msg.edgeHalfWidth.buffer]);
}

function loop(): void {
  timer = null;
  if (!tandem || !running) return;
  const T = tandem;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  while (performance.now() - t0 < FRAME_MS && !finished) {
    const at = T.stepOffset + T.sim.step;
    let chunk = Math.min(5, READ_STEPS - (T.sim.step % READ_STEPS));
    if (stopAfter !== null) chunk = Math.min(chunk, stopAfter - at);
    for (let k = 0; k < chunk; k++) {
      const stand = T.stand;
      const t = T.tOffset + T.sim.t + T.sim.dt;
      const l = T.advance();
      if (!l) continue;
      // a look ends the chunk (chunks stop at the looks), and it may have ended the stand
      history.t.push(t);
      history.force.push(l.force);
      history.stand.push(stand);
      if (T.done) finished = true;
      else if (T.stand !== stand) ready(T);
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

self.onmessage = (e: MessageEvent<ToSolidWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        finished = false;
        stopAfter = m.stopAfter;
        history = { t: [], force: [], stand: [] };
        tandem = new Tandem3(solidParams(m.params, m.solid), m.stands, m.handoff);
        tracker = new Tracker3(tandem.sim);
        tandem.onStandDone = (e) => {
          // the stand's last steps go on its paths; the next stand's tracker carries them on (Sim3.parentOf)
          // and retires this one
          tracker?.record();
          post({ type: 'stand', result: e.result });
          if (e.next) tracker = new Tracker3(e.next, tracker);
        };
        ready(tandem);
        frame();
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
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
