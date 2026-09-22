// Runs the plan-view model (src/mpm/planview/sim.ts) in its own thread and streams frames to the
// page, like sim.worker.ts does for the section model. The steady values are read exactly as
// tools/planview.mjs reads them (a look at every multiple of SAMPLE_STEPS steps), so the page and
// the tool agree to the last digit for the same condition.
import { planCondition } from '../mpm/planview/condition.ts';
import { PlanSim } from '../mpm/planview/sim.ts';
import { SAMPLE_STEPS, SteadySampler, snapshot } from '../mpm/planview/steady.ts';
import { standEndTail, standProgress } from '../mpm/progress.ts';
import type { FromPlanWorker, PlanCrackView, PlanDiag, PlanFieldName, PlanFrame, ToPlanWorker } from './planProtocol.ts';

let sim: PlanSim | null = null;
let sampler: SteadySampler | null = null;
let now: PlanDiag['now'] = null;
let field: PlanFieldName = 'sxx';
let running = false;
let finished = false;
let stopAfter: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let msPerStep = 0;
/** where the strip's tail began: the way it has come is the run's progress (src/mpm/progress.ts) */
let tail0: number | null = null;

const FRAME_MS = 33;
/** the interval between frames the page asked for (a 'frame-ms' message; FRAME_MS when it asks for the worker's own) */
let frameMs = FRAME_MS;

function post(msg: FromPlanWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

/** the field in display units: stresses in MPa, the lateral displacement in mm */
function fieldValue(s: PlanSim, f: PlanFieldName, p: number): number {
  switch (f) {
    case 'sxx':
      return (s.sxx[p] - s.pres[p]) * 1e-6;
    case 'szz':
      return (s.szz[p] - s.pres[p]) * 1e-6;
    case 'seq':
      return s.seq[p] * 1e-6;
    case 'eta':
      return s.eta[p];
    case 'damage':
      return s.governingDamage(p);
    case 'spread':
      return (s.pz[p] - s.z0[p]) * 1e3;
  }
}

function diag(s: PlanSim): PlanDiag {
  let nFailed = 0;
  let maxDamage = 0;
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p]) continue;
    if (s.failed[p]) nFailed++;
    else maxDamage = Math.max(maxDamage, s.governingDamage(p));
  }
  tail0 ??= s.tailX();
  const progress = standProgress(s.tailX(), tail0, standEndTail(s.params.rolling.h0, s.contactLength, 0, null), s.contactLength, s.params.rolling.reduction);
  return { t: s.t, step: s.step, phase: s.phase(), progress, now, steady: sampler!.means(s.halfWidth0), nFailed, maxDamage };
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
    pos[2 * p + 1] = s.pz[p];
    F[4 * p] = s.f00[p];
    F[4 * p + 1] = s.f01[p];
    F[4 * p + 2] = s.f10[p];
    F[4 * p + 3] = s.f11[p];
    val[p] = fieldValue(s, field, p);
    flags[p] = (s.active[p] ? 1 : 0) | (s.failed[p] ? 2 : 0);
  }
  const msg: PlanFrame = {
    type: 'frame',
    pos,
    F,
    val,
    field,
    flags,
    diag: diag(s),
    cracks: crackViews(s),
    running,
    msPerStep,
  };
  post(msg, [pos.buffer, F.buffer, val.buffer, flags.buffer]);
}

/** the cracks with the current centroid of their failed points */
function crackViews(s: PlanSim): PlanCrackView[] {
  const sum = s.cracks.map(() => [0, 0, 0]);
  for (let p = 0; p < s.n; p++) {
    const id = s.crackId[p];
    if (id < 0 || !s.active[p]) continue;
    sum[id][0] += s.px[p];
    sum[id][1] += s.pz[p];
    sum[id][2]++;
  }
  return s.cracks.map((c, i) => ({ ...c, cx: sum[i][2] ? sum[i][0] / sum[i][2] : c.x, cz: sum[i][2] ? sum[i][1] / sum[i][2] : c.z }));
}

/** a look at every multiple of SAMPLE_STEPS steps, as tools/planview.mjs takes them */
function look(s: PlanSim): void {
  const phase = sampler!.look(s);
  // the last look with the strip in the rolls (after the tail has left there is nothing to read)
  if (sampler!.lastForce > 0) {
    const snap = snapshot(s);
    now = { forceHalfWidth: sampler!.lastForce, forceMid: snap.forcePerWidth[0], spread: snap.halfWidth / s.halfWidth0 - 1, centreThick: snap.centreThick };
  }
  if (phase === 'done') finished = true;
}

function loop(): void {
  timer = null;
  if (!sim || !running) return;
  const s = sim;
  const t0 = performance.now();
  let steps = 0;
  let reached = false;
  while (performance.now() - t0 < Math.max(10, frameMs - 6) && !finished) {
    let chunk = Math.min(25, SAMPLE_STEPS - (s.step % SAMPLE_STEPS));
    if (stopAfter !== null) chunk = Math.min(chunk, stopAfter - s.step);
    for (let k = 0; k < chunk; k++) s.advance();
    steps += Math.max(0, chunk);
    if (s.step % SAMPLE_STEPS === 0) look(s);
    if (stopAfter !== null && s.step >= stopAfter) {
      reached = true;
      break;
    }
  }
  if (steps) msPerStep = (performance.now() - t0) / steps;
  // stop there once; "続ける" runs on from it
  if (reached) stopAfter = null;
  if (finished || reached) running = false;
  frame();
  if (running) timer = setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent<ToPlanWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        finished = false;
        now = null;
        field = m.field;
        stopAfter = m.stopAfter;
        sim = new PlanSim(planCondition(m.params, m.plan));
        tail0 = null;
        sampler = new SteadySampler();
        // headless checks can read the simulation through the worker target
        (self as unknown as { __plan: PlanSim }).__plan = sim;
        post({
          type: 'ready',
          geometry: {
            n: sim.n,
            dp: sim.dp,
            h: sim.h,
            dt: sim.dt,
            h0: m.params.rolling.h0,
            gap: sim.gap,
            contactLength: sim.contactLength,
            xExitProbe: sim.xExitProbe,
            halfWidth0: sim.halfWidth0,
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
      case 'frame-ms':
        frameMs = m.ms > 0 ? m.ms : FRAME_MS;
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
