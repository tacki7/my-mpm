// Runs the MPM in its own thread and streams frames to the page (~30 per second).
import { Sim, type FieldName } from '../mpm/solver.ts';
import type { FromWorker, ToWorker, Frame } from './protocol.ts';
import { Tracker } from './tracker.ts';

let sim: Sim | null = null;
let tracker: Tracker | null = null;
let selected: number | null = null;
let field: FieldName = 'seq';
let running = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
let dirsOn = false;

const FRAME_MS = 33;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function frame(): void {
  if (!sim) return;
  const s = sim;
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
    cracks: s.cracks.map((c, i) => ({ ...c, cx: cent[i].x, cy: cent[i].y })),
    tracks: tracker ? tracker.tracks(selected) : [],
    running,
    msPerStep,
  };
  post(msg, [pos.buffer, F.buffer, val.buffer, flags.buffer, ...(dirs ? [dirs.buffer] : [])]);
}

function loop(): void {
  timer = null;
  if (!sim || !running) return;
  const t0 = performance.now();
  let steps = 0;
  while (performance.now() - t0 < FRAME_MS - 6) {
    const chunk = stopAfter === null ? 20 : Math.min(20, stopAfter - sim.step);
    for (let k = 0; k < chunk; k++) sim.advance();
    tracker?.record();
    steps += Math.max(0, chunk);
    if (stopAfter !== null && sim.step >= stopAfter) break;
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  // stop there once; "続ける" runs on from it
  const reached = stopAfter !== null && sim.step >= stopAfter;
  if (reached) stopAfter = null;
  const ph = sim.phase();
  const done = ph === 'done' || ph === 'stalled' || reached;
  if (done) running = false;
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
        sim = new Sim(m.params);
        tracker = new Tracker(sim);
        selected = null;
        // headless checks read the simulation itself through the worker target (tools/browser/explorer.mjs)
        (self as unknown as { __sim: Sim }).__sim = sim;
        post({
          type: 'ready',
          geometry: {
            n: sim.n,
            h0: m.params.rolling.h0,
            gap: sim.gap,
            dp: sim.dp,
            h: sim.h,
            dt: sim.dt,
            contactLength: sim.contactLength,
            xExitProbe: sim.xExitProbe,
            rolls: sim.rolls.map((r) => ({ ...r })),
            rollSpeed: m.params.rolling.rollSpeed,
          },
        });
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
        if (!running) frame();
        break;
      case 'select':
        selected = m.particle;
        if (!running) frame();
        break;
      case 'dirs':
        dirsOn = m.on;
        if (!running) frame();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
