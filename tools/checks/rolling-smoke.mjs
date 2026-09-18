// A coarse rolling pass end to end (6 cells through 1 mm, 8 mm of sheet, about
// 20 000 steps): the sheet is bitten, rolled and leaves; force, gauge, slip and
// the pressure field stay in physical bands; a ductile sheet does not crack.
// The bands are loose on purpose (the mesh is coarse); docs/validation.md holds
// the converged numbers.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
P.numerics.cellsThrough = 6;
P.rolling.sheetLength = 8e-3;
const sim = new Sim(P);

const steady = [];
let spurious = 0;
let badJ = 0;
let nan = 0;
while (sim.step < 60000) {
  for (let k = 0; k < 1000; k++) sim.advance();
  const d = sim.diagnostics();
  if (d.phase === 'steady') {
    steady.push(d);
    for (let p = 0; p < sim.n; p++) {
      if (!sim.active[p]) continue;
      const J = sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p];
      if (!Number.isFinite(sim.px[p] + sim.sxx[p] + sim.pres[p])) nan++;
      if (J < 0.98 || J > 1.02) badJ++;
      // hydrostatic tension inside the bite is the signature of volumetric locking
      if (sim.px[p] > -sim.contactLength && sim.px[p] < 0 && sim.eta[p] > 1) spurious++;
    }
  }
  if (d.phase === 'done') break;
}
const last = sim.diagnostics();
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
ok(last.phase === 'done', 'the sheet goes through the rolls and leaves', `phase ${last.phase} at step ${sim.step}`);
ok(steady.length >= 2, 'a steady phase is reached', `${steady.length} samples`);
between(mean(steady.map((d) => d.rollForce)) * 1e-6, 2.5, 6, 'steady roll force [kN/mm] (slab theory ≈ 2.9 with the rate factor)');
between(mean(steady.map((d) => d.exitThickness ?? NaN)) * 1e3, 0.745, 0.77, 'exit thickness [mm] (gap 0.75 + springback)');
between(mean(steady.map((d) => d.forwardSlip ?? NaN)) * 100, 0, 6, 'forward slip [%]');
ok(nan === 0, 'no NaN in positions or stresses', `${nan}`);
ok(badJ === 0, 'volume ratio J stays within 0.98..1.02 (plastic flow is isochoric)', `${badJ} point-samples outside`);
ok(spurious === 0, 'no hydrostatic tension (η > 1) inside the roll bite', `${spurious} point-samples`);
ok(last.nFailed === 0, 'ductile SPCC at 25 % does not crack', `${last.nFailed} failed, max D ${last.maxDamage.toFixed(3)}`);
done();
