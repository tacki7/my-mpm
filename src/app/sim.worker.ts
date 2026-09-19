// Runs the MPM in its own thread and streams frames to the page (~30 per second). A tandem of several stands
// runs one stand after the other (TandemSim): when a stand is done the worker sends its last frame and its
// geometry (the page keeps that picture), and follows the points on into the next stand.
import type { SimParams } from '../mpm/params.ts';
import type { Sim, FieldName } from '../mpm/solver.ts';
import type { FromWorker, ToWorker, Frame, Geometry } from './protocol.ts';
import { READ_STEPS, TandemSim, type StandDone } from '../mpm/tandem.ts';
import { Tracker } from './tracker.ts';

let tandem: TandemSim | null = null;
let sim: Sim | null = null;
let params: SimParams | null = null;
let tracker: Tracker | null = null;
let selected: number | null = null;
let field: FieldName = 'seq';
let running = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
let dirsOn = false;
/** the finished stands, kept to draw their pictures again with another field */
let held: { stand: number; sim: Sim; tracker: Tracker | null; result: StandDone['result'] }[] = [];

const FRAME_MS = 33;
/** steps between the tandem's own reads (tools/tandem.mjs reads at the same steps, so the results agree) */
const EVERY = READ_STEPS;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function geometryOf(s: Sim): Geometry {
  return {
    n: s.n,
    h0: s.params.rolling.h0,
    gap: s.gap,
    dp: s.dp,
    h: s.h,
    dt: s.dt,
    contactLength: s.contactLength,
    xExitProbe: s.xExitProbe,
    rolls: s.rolls.map((r) => ({ ...r })),
    rollSpeed: s.params.rolling.rollSpeed,
  };
}

/** a frame of sim s (the current stand, or one just finished) with its tracker; its buffers go with it */
function makeFrame(s: Sim, tr: Tracker | null): [Frame, Transferable[]] {
  const n = s.n;
  const pos = new Float32Array(2 * n);
  const F = new Float32Array(4 * n);
  const val = new Float32Array(n);
  const flags = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    pos[2 * p] = s.px[p];
    pos[2 * p + 1] = s.py[p];
    F[4 * p] = s.f00[p];
    F[4 * p + 1] = s.f01[p];
    F[4 * p + 2] = s.f10[p];
    F[4 * p + 3] = s.f11[p];
    flags[p] = (s.active[p] ? 1 : 0) | (s.failed[p] ? 2 : 0);
  }
  s.readField(field, val);
  let dirs: Float32Array | null = null;
  if (dirsOn) {
    dirs = new Float32Array(3 * n);
    for (let p = 0; p < n; p++) {
      const pr = s.pres[p];
      const sxx = s.sxx[p] - pr;
      const syy = s.syy[p] - pr;
      const sxy = s.sxy[p];
      const c = 0.5 * (sxx + syy);
      const r = Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);
      dirs[3 * p] = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      dirs[3 * p + 1] = (c + r) * 1e-6;
      dirs[3 * p + 2] = (c - r) * 1e-6;
    }
  }
  const diag = s.diagnostics();
  const prof = s.pressureProfile();
  const cent = s.crackCentroids();
  const t = tandem!;
  const k = tr?.stand ?? t.stand;
  // the stands before stand j, on the pass's clock
  const tBefore = (j: number) => t.results.slice(0, j).reduce((a, r) => a + r.t, 0);
  const stepsBefore = (j: number) => t.results.slice(0, j).reduce((a, r) => a + r.steps, 0);
  const msg: Frame = {
    type: 'frame',
    pos,
    F,
    dirs,
    val,
    field,
    flags,
    diag,
    profile: { x: Array.from(prof.x), p: Array.from(prof.p), tau: Array.from(prof.tau) },
    cracks: s.cracks.map((c, i) => {
      const j = c.stand ?? k; // a crack of the stand still running has no stand yet
      return { ...c, cx: cent[i].x, cy: cent[i].y, stand: j, tPass: tBefore(j) + c.t, stepPass: stepsBefore(j) + c.step };
    }),
    tracks: tr ? tr.tracks(selected) : [],
    running,
    msPerStep,
    stand: k,
    stands: t.stands,
    tOffset: t.tOffset,
    stepOffset: t.stepOffset,
    results: t.results.map((r) => ({ ...r })),
    passDone: s === sim && finished(),
  };
  return [msg, [pos.buffer, F.buffer, val.buffer, flags.buffer, ...(dirs ? [dirs.buffer] : [])]];
}

function frame(): void {
  if (!sim) return;
  const [msg, transfer] = makeFrame(sim, tracker);
  post(msg, transfer);
}

/** the whole pass's step count (the stands before and this one's) */
const passStep = () => tandem!.stepOffset + sim!.step;

/** one stand is past: hold its last picture, and follow the points into the next stand */
function onStandDone(e: StandDone): void {
  tracker?.record();
  const [last, transfer] = makeFrame(e.sim, tracker);
  last.running = false;
  post({ type: 'stand', stand: e.stand, frame: last, geometry: geometryOf(e.sim), result: { ...e.result }, next: e.next ? geometryOf(e.next) : null }, transfer);
  held.push({ stand: e.stand, sim: e.sim, tracker, result: e.result });
  if (!e.next || !e.parentOf) return;
  const next = new Tracker(e.next, { tracker: tracker!, parentOf: e.parentOf });
  if (selected !== null) {
    const child = next.childOf(selected);
    selected = child >= 0 ? child : null;
  }
  tracker = next;
  sim = e.next;
  (self as unknown as { __sim: Sim }).__sim = e.next;
}

/** the finished stands' pictures again, in the field (and directions) now asked for */
function refreshHeld(): void {
  for (const h of held) {
    const [f, transfer] = makeFrame(h.sim, h.tracker);
    f.running = false;
    f.stand = h.stand;
    post({ type: 'stand', stand: h.stand, frame: f, geometry: geometryOf(h.sim), result: { ...h.result }, next: null, refresh: true }, transfer);
  }
}

/** the pass is over: one stand as before (its phase), a tandem when the last stand has been closed */
function finished(): boolean {
  const t = tandem!;
  if (t.stands === 1) {
    const ph = sim!.phase();
    return ph === 'done' || ph === 'stalled';
  }
  return t.done;
}

function loop(): void {
  timer = null;
  if (!sim || !running) return;
  const t0 = performance.now();
  let steps = 0;
  while (performance.now() - t0 < FRAME_MS - 6) {
    const chunk = stopAfter === null ? 20 : Math.min(20, stopAfter - passStep());
    for (let k = 0; k < chunk; k++) tandem!.advance();
    tracker?.record();
    steps += Math.max(0, chunk);
    if (stopAfter !== null && passStep() >= stopAfter) break;
    if (tandem!.stands > 1 && tandem!.done) break;
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  // stop there once; "続ける" runs on from it
  const reached = stopAfter !== null && passStep() >= stopAfter;
  if (reached) stopAfter = null;
  if (finished() || reached) running = false;
  frame();
  if (running) timer = setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        field = m.field;
        stopAfter = m.stopAfter;
        params = m.params;
        tandem = new TandemSim(params, m.stands, EVERY);
        tandem.onStandDone = onStandDone;
        sim = tandem.sim;
        tracker = new Tracker(sim);
        held = [];
        selected = null;
        // headless checks read the simulation itself through the worker target (tools/browser/explorer.mjs)
        (self as unknown as { __sim: Sim }).__sim = sim;
        post({ type: 'ready', geometry: geometryOf(sim) });
        frame();
        break;
      }
      case 'run':
        if (sim && !running) {
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
        refreshHeld();
        if (!running) frame();
        break;
      case 'select':
        selected = m.particle;
        if (!running) frame();
        break;
      case 'dirs':
        dirsOn = m.on;
        refreshHeld();
        if (!running) frame();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
