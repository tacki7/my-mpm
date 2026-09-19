// The nonlocal average of the damage increments (Sim.nonlocalAverage): a uniform
// field stays the same, Σ m·v is kept (the B-spline weights are a partition of
// unity), a single point spreads only within the kernel's reach (3 cells) and
// wider with more passes (about √passes), and the passes follow the length ℓ.
// @check
import { ok, between, near, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
P.numerics.cellsThrough = 6;
P.rolling.sheetLength = 6e-3;
const sim = new Sim(P);
const n = sim.n;
const fresh = (v) => [Float64Array.from({ length: n }, (_, p) => (typeof v === 'function' ? v(p) : v))];

// a uniform field
for (const passes of [1, 4]) {
  const u = fresh(1);
  sim.nonlocalAverage(u, passes);
  const worst = u[0].reduce((w, v) => Math.max(w, Math.abs(v - 1)), 0);
  between(worst, 0, 1e-12, `a uniform field stays uniform (${passes} passes, worst |v − 1|)`);
}

// one point in the middle of the sheet
const mid = (() => {
  let best = 0;
  let bd = Infinity;
  const cx = sim.x0.reduce((a, b) => a + b, 0) / n;
  for (let p = 0; p < n; p++) {
    const d = Math.hypot(sim.x0[p] - cx, sim.y0[p]);
    if (d < bd) [bd, best] = [d, p];
  }
  return best;
})();
const spread = (passes) => {
  const v = fresh((p) => (p === mid ? 1 : 0));
  const before = sim.mass[mid] * 1;
  sim.nonlocalAverage(v, passes);
  // along x (the lattice is the same both ways): the kernel reaches 3 cells, its spread (std) is per axis
  let sum = 0;
  let m2 = 0;
  let reach = 0;
  for (let p = 0; p < n; p++) {
    const w = sim.mass[p] * v[0][p];
    sum += w;
    const dx = Math.abs(sim.px[p] - sim.px[mid]);
    m2 += w * dx * dx;
    if (v[0][p] > 0) reach = Math.max(reach, dx, Math.abs(sim.py[p] - sim.py[mid]));
  }
  return { v: v[0], sum, before, std: Math.sqrt(m2 / sum), reach };
};
const one = spread(1);
near(one.sum, one.before, 1e-12, 'Σ m·v is kept by a pass');
ok(one.v[mid] < 1 && one.v[mid] > 0, 'the point keeps part of its value', `${one.v[mid].toFixed(3)}`);
between(one.reach / sim.h, 1, 3, 'one pass reaches no farther than the kernel (3 cells along each axis)');
between(one.std / sim.h, 0.5, 0.95, 'one pass spreads it by about 0.71 cell along an axis (std)');
const four = spread(4);
near(four.sum, four.before, 1e-12, 'Σ m·v is kept by four passes');
between(four.std / one.std, 1.6, 2.4, 'four passes spread it about twice as far (√4)');

// passes for a length
ok(sim.nonlocalPasses(0.1 * sim.h) === 1 && sim.nonlocalPasses(sim.h) === 2 && sim.nonlocalPasses(2 * sim.h) === 8, 'passes = max(1, round(2 (ℓ/h)²))');
done();
