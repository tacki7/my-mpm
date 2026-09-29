// The team's partition of the columns (src/mpm/solid/sim3.ts partition / reduce) when the strip is shorter than
// two columns per worker: a strip of 6 base cell columns on a team of 8 (L 1.5 mm, 4 cells, W 2 mm), in the
// team's serial mode (deterministic, no threads race). Before 2026-09-30 a run of columns could be one column wide,
// and the scatter of the run two to the left — which reaches two columns past its own — was added to the main grid
// by nobody (16 % of the mass missing on the grid, the velocities then blowing up). About 5 s.
// - the main grid holds all the mass after a step, alone and on the team
// - the whole pass on the team (6000 steps) is the pass alone: every number of the stand's result within 1e-9
// - advance() on a Sim3 made for a team, or with a GPU attached, is refused (it would step rank 0's share only)
// @check
import { ok, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { nodeTeam } from '../lib/solid-team.mjs';

const SIZE = 8;
const MAX_STEPS = 20000;

const params = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 1.5e-3;
  return solidParams(P, { width: 2e-3 });
};

/** the mass on the main grid (a TS-private field, read here as the check's probe) and the mass of the active points */
function masses(sim) {
  let grid = 0;
  const gm = sim.G.m;
  for (let i = 0; i < gm.length; i++) grid += gm[i];
  let points = 0;
  for (let p = 0; p < sim.n; p++) if (sim.active[p]) points += sim.mass[p];
  return { grid, points };
}

const flat = (o, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
};
/** the worst relative difference over the numbers of two results (the same keys), as solid3-threads.mjs */
function worst(a, b) {
  const A = flat(a);
  const B = flat(b);
  let w = { key: '', err: 0, a: 0, b: 0 };
  for (const k of Object.keys(A)) {
    if (typeof A[k] !== 'number' || /secs|ms/.test(k)) continue;
    if (typeof B[k] !== 'number') return { key: k, err: Infinity, a: A[k], b: B[k] };
    const err = Math.abs(A[k] - B[k]) / Math.max(1e-300, Math.abs(A[k]));
    if (err > w.err) w = { key: k, err, a: A[k], b: B[k] };
  }
  return w;
}

const t0 = performance.now();

// ── alone: the probe is calibrated (the grid's mass after a step is the points'), then the whole pass
const one = new Tandem3(params(), 1, 'done');
one.advance();
{
  const m = masses(one.sim);
  near(m.grid, m.points, 1e-12, `alone: the main grid holds the points' mass after a step (${one.sim.n} points, ${one.sim.nxN} columns)`);
}
let steps1 = 1;
while (!one.done && steps1 < MAX_STEPS) {
  one.advance();
  steps1++;
}

// ── the team of 8, serial: the mass after the first step, then the whole pass
const team = nodeTeam(SIZE, { serial: true });
const T = new Tandem3(params(), 1, 'done', { shared: true, size: SIZE });
await T.useTeam(team);
await T.advanceTeam();
{
  const sim = T.sim;
  const m = masses(sim);
  const b = Array.from(sim.sync.subarray(16, 16 + SIZE + 1));
  ok(Math.abs(m.grid - m.points) <= 1e-12 * m.points, `team of ${SIZE}: the main grid holds the points' mass after the first step`, `grid / points = ${(m.grid / m.points).toFixed(6)}, columns ${b.map((v) => (Math.abs(v) >= 1e9 ? (v < 0 ? '−∞' : '∞') : v)).join(' | ')}`);
}
let steps8 = 1;
while (!T.done && steps8 < MAX_STEPS) {
  await T.advanceTeam();
  steps8++;
}
team.close();
{
  const r1 = one.results[0];
  const r8 = T.results[0];
  ok(r1?.phase === 'done' && r8?.phase === 'done' && steps1 === steps8, `both passes end with the strip out in the same number of steps`, `${r1?.phase} in ${steps1} / ${r8?.phase} in ${steps8}`);
  const w = worst(r1, r8);
  ok(w.err <= 1e-9, `team of ${SIZE}: every number of the stand's result within 1e-9 of the pass alone (${w.key} ${w.err.toExponential(2)})`, `${w.a} / ${w.b}`);
}

// ── advance() where the step belongs to the team or the device
{
  let msg = '';
  try {
    new Sim3(params(), { shared: true, size: 2 }).advance();
  } catch (err) {
    msg = String(err.message);
  }
  ok(/Team/.test(msg), 'advance() on a Sim3 made for a team is refused', msg || 'no error');
  msg = '';
  const s = new Sim3(params());
  s.gpu = { destroy() {} };
  try {
    s.advance();
  } catch (err) {
    msg = String(err.message);
  }
  ok(/advanceBatch/.test(msg), 'advance() on a Sim3 with a GPU attached is refused', msg || 'no error');
}

console.log(`${((performance.now() - t0) / 1e3).toFixed(1)} s`);
done();
