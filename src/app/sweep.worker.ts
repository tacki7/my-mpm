// One condition of the 「条件の比較」 tab at a time (src/app/sweepMode.ts runs several of these at once): a plain
// Tandem3 run to its end (sweep.ts runCase, in slices so that a pause gets through), its progress after each
// slice, and its stands' results.
import type { Handoff } from '../mpm/tandem.ts';
import type { Solid3Params } from '../mpm/solid/sim3.ts';
import { tandemProgress3 } from '../mpm/solid/progress3.ts';
import { MAX_STANDS, Tandem3 } from '../mpm/solid/tandem3.ts';
import type { SweepCaseResult, SweepValues } from '../mpm/solid/sweep.ts';
import { standGrowth } from './eta.ts';

export type ToSweepWorker =
  | { type: 'run'; index: number; P: Solid3Params; values: SweepValues; stands: number; handoff: Handoff }
  | { type: 'pause' }
  | { type: 'resume' };
export type FromSweepWorker =
  | { type: 'progress'; index: number; stand: number; progress: number }
  | { type: 'done'; index: number; result: SweepCaseResult; seconds: number }
  | { type: 'error'; index: number; message: string };

const post = (m: FromSweepWorker) => (self as unknown as Worker).postMessage(m);
/** a slice of steps between looks at the messages [ms] */
const SLICE_MS = 150;
const MAX_STEPS = 2_000_000;

let job: { index: number; T: Tandem3; values: SweepValues; growth: number; steps: number; ms: number } | null = null;
let paused = false;
let scheduled = false;

function slice(): void {
  scheduled = false;
  if (!job || paused) return;
  const j = job;
  const t0 = performance.now();
  try {
    while (!j.T.done && j.steps < MAX_STEPS && performance.now() - t0 < SLICE_MS) {
      j.T.advance();
      j.steps++;
    }
  } catch (err) {
    job = null;
    post({ type: 'error', index: j.index, message: String((err as Error)?.message ?? err) });
    return;
  }
  j.ms += performance.now() - t0;
  if (j.T.done || j.steps >= MAX_STEPS) {
    job = null;
    const result: SweepCaseResult = { values: j.values, stands: j.T.results.slice(), stopped: j.T.stopped ?? (j.T.done ? null : 'steps') };
    post({ type: 'done', index: j.index, result, seconds: j.ms / 1e3 });
    return;
  }
  post({ type: 'progress', index: j.index, stand: j.T.stand, progress: tandemProgress3(j.T, j.growth) });
  schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(slice, 0);
}

self.onmessage = (e: MessageEvent<ToSweepWorker>) => {
  const m = e.data;
  if (m.type === 'pause') paused = true;
  else if (m.type === 'resume') {
    paused = false;
    schedule();
  } else if (m.type === 'run') {
    try {
      const T = new Tandem3(m.P, Math.max(1, Math.min(MAX_STANDS, m.stands)), m.handoff);
      job = { index: m.index, T, values: m.values, growth: standGrowth(m.P.rolling.reduction, m.handoff, true), steps: 0, ms: 0 };
      paused = false;
      schedule();
    } catch (err) {
      post({ type: 'error', index: m.index, message: String((err as Error)?.message ?? err) });
    }
  }
};
