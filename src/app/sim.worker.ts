// Runs the MPM in its own thread and streams frames to the page (~30 per second). A tandem of several stands
// runs one stand after the other (TandemSim). Each stand's picture is kept from its steady phase, when the
// sheet fills the default window (every field and the principal directions, so it can be drawn again in any
// of them); when a stand is done the worker sends that picture and the stand's geometry (the page shows it
// in the stand's slot), and follows the points on into the next stand.
import type { SimParams } from '../mpm/params.ts';
import type { Sim, FieldName, Diagnostics } from '../mpm/solver.ts';
import type { FromWorker, ToWorker, Frame, Geometry } from './protocol.ts';
import { READ_STEPS, TandemSim, steadyLength, type StandDone } from '../mpm/tandem.ts';
import { standEndTail, standProgress } from '../mpm/progress.ts';
import { Tracker } from './tracker.ts';
import { FIELDS } from './fields.ts';
import { windowCentre, windowWidth } from './biteWindow.ts';
import { LOOK, MidPlaneEta } from '../mpm/midplane.ts';

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
/** a tandem: each stand's picture (null until taken), and the first stand's sheet, which sets the window */
let pictures: (Picture | null)[] = [];
/** the last live frame's diagnostics and pressure profile: a picture takes them rather than read (and so restart) the
 * means the page shows (Sim.diagnostics() and pressureProfile() average over the steps since their last call) */
let lastDiag: Diagnostics | null = null;
let lastProfile: Frame['profile'] | null = null;
/** the current stand's mid-plane η over its steady phase, read every LOOK steps as tools/burst-map.mjs reads it */
let midPlane: { sim: Sim; eta: MidPlaneEta } | null = null;
function lookMidPlane(s: Sim): void {
  if (midPlane?.sim !== s) midPlane = { sim: s, eta: new MidPlaneEta(s) }; // a new stand starts its own
  if (s.step % LOOK === 0) midPlane.eta.look(s);
}

/** a tandem: each stand change's parentOf (next stand's point → the point it came from), to follow a pick made before it */
let changes: Int32Array[] = [];
let scale: { contactLength: number; h0: number } | null = null;

/** a stand's picture kept for later: every field and the principal directions, so that it can be drawn again in any */
interface Picture {
  geometry: Geometry;
  pos: Float32Array;
  F: Float32Array;
  flags: Uint8Array;
  dirs: Float32Array;
  vals: Map<FieldName, Float32Array>;
  rest: Omit<Frame, 'pos' | 'F' | 'dirs' | 'val' | 'field' | 'flags'>;
}

const FRAME_MS = 33;
/** the interval between frames the page asked for (a 'frame-ms' message; FRAME_MS when it asks for the worker's own) */
let frameMs = FRAME_MS;
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

/** positions, deformation gradients and flags of sim s */
function arraysOf(s: Sim): { pos: Float32Array; F: Float32Array; flags: Uint8Array } {
  const n = s.n;
  const pos = new Float32Array(2 * n);
  const F = new Float32Array(4 * n);
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
  return { pos, F, flags };
}

/** in-plane principal stresses: angle of σI from x, σI, σII [MPa] */
function dirsOf(s: Sim): Float32Array {
  const n = s.n;
  const dirs = new Float32Array(3 * n);
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
  return dirs;
}

/** where each stand's tail began and where it is when the stand ends (src/mpm/progress.ts), found at the stand's first frame */
const tailSpan = new WeakMap<Sim, [number, number]>();

/** how far the running stand is through its pass, 0..1 (for the page's estimate of the time left) */
function progressOf(s: Sim, t: TandemSim): number {
  let span = tailSpan.get(s);
  if (!span) {
    const tail0 = s.tailX();
    const length = s.headX() - tail0;
    // a stand with another after it hands on once it is steady: the first stand's strip may be longer than that
    // reading needs, the later ones are made that long
    const handsOn = t.handoff === 'steady' && t.stand < t.stands - 1;
    const need = !handsOn ? null : t.stand === 0 ? steadyLength(s.params, EVERY) : length;
    span = [tail0, standEndTail(s.params.rolling.h0, s.contactLength, length, need)];
    tailSpan.set(s, span);
  }
  return standProgress(s.tailX(), span[0], span[1], s.contactLength, s.params.rolling.reduction);
}

/** the rest of a frame of sim s with its tracker; keep: without reading the display's means (a picture) */
function restOf(s: Sim, tr: Tracker | null, keep = false): Picture['rest'] {
  let diag: Diagnostics;
  let profile: Frame['profile'];
  if (keep && lastDiag && lastProfile) {
    // the last frame's, at this moment: the pictures use its time (the rolls' marks), step and phase
    diag = { ...lastDiag, t: s.t, step: s.step, phase: s.phase() };
    profile = lastProfile;
  } else {
    diag = s.diagnostics();
    const prof = s.pressureProfile();
    profile = { x: Array.from(prof.x), p: Array.from(prof.p), tau: Array.from(prof.tau) };
    if (!keep) {
      lastDiag = diag;
      lastProfile = profile;
    }
  }
  const cent = s.crackCentroids();
  const t = tandem!;
  const k = tr?.stand ?? t.stand;
  // the stands before stand j, on the pass's clock
  const tBefore = (j: number) => t.results.slice(0, j).reduce((a, r) => a + r.t, 0);
  const stepsBefore = (j: number) => t.results.slice(0, j).reduce((a, r) => a + r.steps, 0);
  return {
    type: 'frame',
    diag,
    profile,
    cracks: s.cracks.map((c, i) => {
      const j = c.stand ?? k; // a crack of the stand still running has no stand yet
      // a record with no points left (a tandem carries the records on; their points may be gone): where it began
      const e = cent[i];
      const at = Number.isFinite(e.x) && Number.isFinite(e.y);
      return { ...c, cx: at ? e.x : c.x, cy: at ? e.y : c.y, stand: j, tPass: tBefore(j) + c.t, stepPass: stepsBefore(j) + c.step };
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
    progress: s === sim ? progressOf(s, t) : 1,
    stopped: t.stopped,
    steady: s === sim ? t.steadyMeans() : null,
    midEta: s === sim && midPlane?.sim === s ? midPlane.eta.middle : null,
  };
}

/** a frame of sim s (the current stand) with its tracker; its buffers go with it */
function makeFrame(s: Sim, tr: Tracker | null): [Frame, Transferable[]] {
  const { pos, F, flags } = arraysOf(s);
  const val = new Float32Array(s.n);
  s.readField(field, val);
  const dirs = dirsOn ? dirsOf(s) : null;
  const msg: Frame = { ...restOf(s, tr), pos, F, dirs, val, field, flags };
  return [msg, [pos.buffer, F.buffer, val.buffer, flags.buffer, ...(dirs ? [dirs.buffer] : [])]];
}

/** sim s as it is now, kept: every field and the principal directions */
function snapshot(s: Sim, tr: Tracker | null): Picture {
  const vals = new Map<FieldName, Float32Array>();
  for (const f of FIELDS) {
    const v = new Float32Array(s.n);
    s.readField(f.id, v);
    vals.set(f.id, v);
  }
  const rest = restOf(s, tr, true);
  rest.running = false;
  rest.passDone = false;
  return { geometry: geometryOf(s), ...arraysOf(s), dirs: dirsOf(s), vals, rest };
}

/** a frame of a kept picture, in the field (and directions) now asked for; copies go with it */
function pictureFrame(pic: Picture): [Frame, Transferable[]] {
  const pos = pic.pos.slice();
  const F = pic.F.slice();
  const flags = pic.flags.slice();
  const val = pic.vals.get(field)!.slice();
  const dirs = dirsOn ? pic.dirs.slice() : null;
  const msg: Frame = { ...pic.rest, pos, F, dirs, val, field, flags };
  return [msg, [pos.buffer, F.buffer, val.buffer, flags.buffer, ...(dirs ? [dirs.buffer] : [])]];
}

/**
 * The moment to keep a stand's picture: in the steady phase once the tail has passed the left edge of the default
 * window (the sheet then fills the window as far as it ever will, and the bite is full), or as soon as the steady
 * phase is over without that (a short sheet).
 */
function wantsPicture(s: Sim): boolean {
  const ph = s.phase();
  // 'adjusting': the rolls still move (flattening, constant reduction); the steady phase comes after it
  if (ph === 'approach' || ph === 'bite' || ph === 'adjusting') return false;
  if (ph !== 'steady') return true;
  const w = windowWidth(scale!);
  return s.tailX() >= windowCentre(s.contactLength, w) - w / 2;
}

function frame(): void {
  if (!sim) return;
  const [msg, transfer] = makeFrame(sim, tracker);
  post(msg, transfer);
}

/** the whole pass's step count (the stands before and this one's) */
const passStep = () => tandem!.stepOffset + sim!.step;

/** one stand is past: send its picture (the last state if none was taken), and follow the points into the next stand */
function onStandDone(e: StandDone): void {
  // one stand: nothing to hold or hand on (the page is as before; whether its reading falls inside a run of the
  // loop or not must not change what the page shows)
  if (tandem!.stands === 1) return;
  tracker?.record();
  const pic = pictures[e.stand] ?? snapshot(e.sim, tracker);
  pictures[e.stand] = pic;
  const [f, transfer] = pictureFrame(pic);
  post({ type: 'stand', stand: e.stand, frame: f, geometry: pic.geometry, result: { ...e.result }, next: e.next ? geometryOf(e.next) : null }, transfer);
  if (!e.next || !e.parentOf) return;
  changes[e.stand] = e.parentOf;
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
  if (!tandem || tandem.stands === 1) return;
  tandem.results.forEach((result, k) => {
    const pic = pictures[k];
    if (!pic) return;
    const [f, transfer] = pictureFrame(pic);
    post({ type: 'stand', stand: k, frame: f, geometry: pic.geometry, result: { ...result }, next: null, refresh: true }, transfer);
  });
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
  while (performance.now() - t0 < Math.max(10, frameMs - 6)) {
    const chunk = stopAfter === null ? 20 : Math.min(20, stopAfter - passStep());
    const t = tandem!;
    for (let k = 0; k < chunk; k++) {
      t.advance();
      lookMidPlane(t.sim);
      // a tandem's pass is over: no steps past the last stand's end (its stands end at any step, not a chunk's)
      if (t.stands > 1 && t.done) break;
    }
    tracker?.record();
    // a tandem keeps each stand's picture (checked every chunk of 20 steps, so the moment is the same every run)
    if (t.stands > 1 && !t.done && !pictures[t.stand] && wantsPicture(sim)) pictures[t.stand] = snapshot(sim, tracker);
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
        tandem = new TandemSim(params, m.stands, EVERY, params.rolling.handoff ?? 'done');
        tandem.onStandDone = onStandDone;
        sim = tandem.sim;
        tracker = new Tracker(sim);
        pictures = [];
        changes = [];
        midPlane = null;
        lastDiag = null;
        lastProfile = null;
        scale = { contactLength: sim.contactLength, h0: sim.params.rolling.h0 };
        selected = null;
        // headless checks read the simulation itself through the worker target (tools/browser/explorer.mjs)
        (self as unknown as { __sim: Sim }).__sim = sim;
        post({ type: 'ready', geometry: geometryOf(sim), sheetLength: sim.params.rolling.sheetLength });
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
      case 'frame-ms':
        frameMs = m.ms > 0 ? m.ms : FRAME_MS;
        break;
      case 'field':
        field = m.field;
        refreshHeld();
        if (!running) frame();
        break;
      case 'select':
        selected = m.particle;
        // picked in a stand the tandem has since left: the point's child in the stand now running
        for (let k = m.stand ?? tandem?.stand ?? 0; selected !== null && selected >= 0 && tandem && k < tandem.stand; k++) {
          const map = changes[k];
          const child = map ? map.indexOf(selected) : -1;
          selected = child >= 0 ? child : null;
        }
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
