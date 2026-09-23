// The conditions of the 「条件の比較」 tab, one after another (src/app/sweepMode.ts hands them over one at a time): a
// plain Tandem3 run to its end (sweep.ts runCase, in slices so that a pause gets through), on a team of `threads`
// (the 3D tab's multi-threaded step, team.ts; kept across conditions), its progress after each slice, and its
// stands' results.
import type { Handoff } from '../mpm/tandem.ts';
import type { Solid3Params } from '../mpm/solid/sim3.ts';
import { tandemProgress3 } from '../mpm/solid/progress3.ts';
import { Team, type TeamPort } from '../mpm/solid/team.ts';
import { MAX_STANDS, Tandem3 } from '../mpm/solid/tandem3.ts';
import type { SweepCaseResult, SweepValues } from '../mpm/solid/sweep.ts';
import { standGrowth } from './eta.ts';

export type ToSweepWorker =
  | { type: 'run'; index: number; P: Solid3Params; values: SweepValues; stands: number; handoff: Handoff; threads: number }
  | { type: 'pause' }
  | { type: 'resume' };
export type FromSweepWorker =
  | { type: 'progress'; index: number; stand: number; progress: number }
  | { type: 'done'; index: number; result: SweepCaseResult; seconds: number; threads: number; note: string | null }
  | { type: 'error'; index: number; message: string };

const post = (m: FromSweepWorker) => (self as unknown as Worker).postMessage(m);
/** a slice of steps between looks at the messages [ms] */
const SLICE_MS = 150;
const MAX_STEPS = 2_000_000;

let job: { index: number; T: Tandem3; values: SweepValues; growth: number; steps: number; ms: number; threads: number; note: string | null } | null = null;
let team: Team | null = null;
let paused = false;
let scheduled = false;
/** a run message's sequence: a condition's team setup that is overtaken by the next run is dropped */
let seq = 0;

async function slice(): Promise<void> {
  scheduled = false;
  if (!job || paused) return;
  const j = job;
  const t0 = performance.now();
  try {
    while (!j.T.done && j.steps < MAX_STEPS && performance.now() - t0 < SLICE_MS) {
      if (j.threads > 1) await j.T.advanceTeam();
      else j.T.advance();
      j.steps++;
    }
  } catch (err) {
    job = null;
    team?.close();
    team = null;
    post({ type: 'error', index: j.index, message: String((err as Error)?.message ?? err) });
    return;
  }
  if (job !== j) return;
  j.ms += performance.now() - t0;
  if (j.T.done || j.steps >= MAX_STEPS) {
    job = null;
    const result: SweepCaseResult = { values: j.values, stands: j.T.results.slice(), stopped: j.T.stopped ?? (j.T.done ? null : 'steps') };
    post({ type: 'done', index: j.index, result, seconds: j.ms / 1e3, threads: j.threads, note: j.note });
    return;
  }
  post({ type: 'progress', index: j.index, stand: j.T.stand, progress: tandemProgress3(j.T, j.growth) });
  schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => void slice(), 0);
}

/** a helper worker of the team (the 3D tab's, solid.helper.worker.ts) */
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

/** the condition's tandem on `want` threads where the page can share memory, else on this one (and why) */
async function start(m: ToSweepWorker & { type: 'run' }, s: number): Promise<void> {
  const stands = Math.max(1, Math.min(MAX_STANDS, m.stands));
  let threads = Math.max(1, Math.floor(m.threads));
  let note: string | null = null;
  if (threads > 1 && (typeof SharedArrayBuffer === 'undefined' || !(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated)) {
    note = 'このページは SharedArrayBuffer が使えない（cross-origin isolated でない）ので 1 スレッドで計算する';
    threads = 1;
  }
  let T: Tandem3;
  if (threads > 1) {
    try {
      T = new Tandem3(m.P, stands, m.handoff, { shared: true, size: threads });
      if (team && team.size !== threads) {
        team.close();
        team = null;
      }
      if (!team) team = new Team(threads, spawnHelper);
      await T.useTeam(team);
    } catch (err) {
      team?.close();
      team = null;
      note = `スレッドが使えないので 1 スレッドで計算する（${String((err as Error)?.message ?? err)}）`;
      threads = 1;
      T = new Tandem3(m.P, stands, m.handoff);
    }
  } else {
    team?.close();
    team = null;
    T = new Tandem3(m.P, stands, m.handoff);
  }
  if (s !== seq) return;
  job = { index: m.index, T, values: m.values, growth: standGrowth(m.P.rolling.reduction, m.handoff, true), steps: 0, ms: 0, threads, note };
  schedule();
}

self.onmessage = (e: MessageEvent<ToSweepWorker>) => {
  const m = e.data;
  if (m.type === 'pause') paused = true;
  else if (m.type === 'resume') {
    paused = false;
    schedule();
  } else if (m.type === 'run') {
    job = null;
    paused = false;
    const s = ++seq;
    start(m, s).catch((err) => post({ type: 'error', index: m.index, message: String((err as Error)?.message ?? err) }));
  }
};
