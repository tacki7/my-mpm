// A touching point on a cell centre along x (fx exactly 0.5) does not weigh one column of its
// stencil. The contact's correction must not ask anything of such a node: with a zero weight it
// was still listed, divided 0 by 0 and spread NaN over the whole sheet in about 20 steps.
// Standard pass, 6 cells: in the steady phase, before each of 300 steps the touching outermost
// point closest to a cell centre is moved onto it (by at most 0.03 cells).
// @check
import { ok, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
P.numerics.cellsThrough = 6;
P.rolling.sheetLength = 8e-3;
const sim = new Sim(P);
while (sim.phase() !== 'steady' && sim.step < 60000) sim.advance();
const { NI, NJ, lattice, ox, h, invH } = sim;

// x with (x − ox) · invH exactly k + 0.5, as the solver computes it
const onCentre = (x) => {
  const target = Math.round((x - ox) * invH - 0.5) + 0.5;
  let y = ox + target * h;
  for (let t = 0; t < 60 && (y - ox) * invH !== target; t++) {
    const g = (y - ox) * invH;
    y += g < target ? Math.abs(y) * Number.EPSILON : -Math.abs(y) * Number.EPSILON;
  }
  return (y - ox) * invH === target ? y : null;
};

let moved = 0;
let nan = 0;
for (let s = 0; s < 300; s++) {
  let best = -1;
  let dist = 0.03;
  for (let i = 0; i < NI; i++) {
    for (const j of [0, NJ - 1]) {
      const q = lattice[i * NJ + j];
      if (q < 0 || !sim.active[q] || !sim.touch[q]) continue;
      const g = (sim.px[q] - ox) * invH;
      const d = Math.abs(g - 0.5 - Math.round(g - 0.5));
      if (d < dist) [best, dist] = [q, d];
    }
  }
  if (best >= 0) {
    const x = onCentre(sim.px[best]);
    if (x !== null) {
      sim.px[best] = x;
      moved++;
    }
  }
  sim.advance();
}
for (let p = 0; p < sim.n; p++) if (sim.active[p] && !Number.isFinite(sim.px[p] + sim.py[p] + sim.sxx[p] + sim.pres[p])) nan++;
ok(moved >= 100, 'touching points were put on cell centres', `${moved} of 300 steps`);
ok(nan === 0, 'no NaN after 300 steps with a touching point on a cell centre', `${nan} points`);
done();
