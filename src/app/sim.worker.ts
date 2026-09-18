// Runs the MPM in its own thread and streams frames to the page (~30 per second).
import { Sim, type FieldName } from '../mpm/solver.ts';
import type { FromWorker, ToWorker, Frame } from './protocol.ts';

let sim: Sim | null = null;
let field: FieldName = 'seq';
let running = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;

const FRAME_MS = 33;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function frame(): void {
  if (!sim) return;
  const s = sim;
  const n = s.n;
  const pos = new Float32Array(2 * n);
  const ext = new Float32Array(2 * n);
  const val = new Float32Array(n);
  const flags = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    pos[2 * p] = s.px[p];
    pos[2 * p + 1] = s.py[p];
    ext[2 * p] = Math.abs(s.f00[p]) + Math.abs(s.f01[p]);
    ext[2 * p + 1] = Math.abs(s.f10[p]) + Math.abs(s.f11[p]);
    flags[p] = (s.active[p] ? 1 : 0) | (s.failed[p] ? 2 : 0);
  }
  s.readField(field, val);
  const diag = s.diagnostics();
  const prof = s.pressureProfile();
  const cent = s.crackCentroids();
  const msg: Frame = {
    type: 'frame',
    pos,
    ext,
    val,
    field,
    flags,
    diag,
    profile: { x: Array.from(prof.x), p: Array.from(prof.p), tau: Array.from(prof.tau) },
    cracks: s.cracks.map((c, i) => ({ ...c, cx: cent[i].x, cy: cent[i].y })),
    running,
    msPerStep,
  };
  post(msg, [pos.buffer, ext.buffer, val.buffer, flags.buffer]);
}

function loop(): void {
  timer = null;
  if (!sim || !running) return;
  const t0 = performance.now();
  let steps = 0;
  while (performance.now() - t0 < FRAME_MS - 6) {
    for (let k = 0; k < 20; k++) sim.advance();
    steps += 20;
    if (stopAfter !== null && sim.step >= stopAfter) break;
  }
  msPerStep = (performance.now() - t0) / steps;
  const done = sim.phase() === 'done' || (stopAfter !== null && sim.step >= stopAfter);
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
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
