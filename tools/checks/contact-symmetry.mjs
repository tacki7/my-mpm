// The two rolls act alike on a symmetric pass, even on coarse grids where their contact meets.
// Over the steady phase the top and bottom roll force and torque are the same to rounding, and
// the two rows next to the mid-plane stay centred on it (about 12 s):
// - 4 cells, 40 % (the coarsest grid the panel allows; a gap of 2.4 cells). The 'stencil'
//   contact (every node of a touching point's stencil) projected the same nodes for both rolls
//   one after the other: torque 0.9 % apart, the mid-plane rows 0.5 dp off
// - 2 cells, 40 % (URL only; a gap of 1.2 cells): here even the surface contact holds some nodes
//   from both rolls. Projecting them one roll after the other and mixing the two rolls' requests
//   in one sum gave a torque 9.9 % apart and the rows 0.23 dp off. Now each roll projects the
//   velocity before contact and a node takes the nearer roll (the mean of the two on the
//   mid-plane), and the requests are summed per roll
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

function pass(cells, reduction) {
  const P = defaultParams();
  P.numerics.cellsThrough = cells;
  P.rolling.reduction = reduction;
  P.rolling.sheetLength = 8e-3;
  const sim = new Sim(P);
  const { NI, NJ, lattice, dp } = sim;
  const [jlo, jhi] = [NJ / 2 - 1, NJ / 2];
  // per roll, before diagnostics() averages them (the solver keeps them private: read here only)
  let [f0, f1, t0, t1, windows] = [0, 0, 0, 0, 0];
  let drift = 0;
  while (sim.step < 100000) {
    for (let k = 0; k < 250; k++) sim.advance();
    const [a0, a1, q0, q1] = [Math.abs(sim.accFy[0]), Math.abs(sim.accFy[1]), -sim.accTorque[0], sim.accTorque[1]];
    const d = sim.diagnostics();
    if (d.phase === 'steady') {
      [f0, f1, t0, t1] = [f0 + a0, f1 + a1, t0 + q0, t1 + q1];
      windows++;
      for (let i = 0; i < NI; i++) {
        const [a, b] = [lattice[i * NJ + jlo], lattice[i * NJ + jhi]];
        if (a < 0 || b < 0 || !sim.active[a] || !sim.active[b]) continue;
        drift = Math.max(drift, Math.abs(0.5 * (sim.py[a] + sim.py[b])) / dp);
      }
    }
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  const name = `${cells} cells, ${reduction * 100} %`;
  ok(windows >= 2, `${name}: a steady phase is reached`, `${windows} windows of 250 steps`);
  between(Math.abs(f0 - f1) / (f0 + f1), 0, 1e-9, `${name}: top and bottom roll force, relative difference`);
  between(Math.abs(t0 - t1) / (t0 + t1), 0, 1e-9, `${name}: top and bottom roll torque, relative difference`);
  between(drift, 0, 0.01, `${name}: the two rows next to the mid-plane stay centred on it (largest drift, in dp)`);
}

pass(4, 0.4);
pass(2, 0.4);
done();
