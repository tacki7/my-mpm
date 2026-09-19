// The volumetric scheme on the thin sheet at 10 cells (rolling-smoke runs 6), 4 mm of sheet, while the
// bite is at least half full: no locking (no η > 1 in the bite, elastic J within 0.98..1.02), stable (no NaN;
// a cell-mean F-bar blew up at 16 cells through the node-checkerboard mode), smooth pressure between
// lattice neighbours, and a ductile sheet does not crack.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

function pass(cells, gtn) {
  const P = defaultParams();
  P.numerics.cellsThrough = cells;
  P.rolling.sheetLength = 4e-3;
  if (gtn) {
    P.damage.yield = 'gtn';
    P.damage.gtn.nucleation = 'always';
  }
  const sim = new Sim(P);
  const Lc = sim.contactLength;
  const { NI, NJ, lattice } = sim;
  const r = { nan: 0, badJ: 0, eta1: 0, dsum: 0, dn: 0, dmax: 0, psum: 0, pn: 0 };
  while (sim.step < 200000) {
    for (let k = 0; k < 500; k++) sim.advance();
    const head = sim.headX();
    // the bite at least half full of sheet
    if (head > -0.5 * Lc && head < 1e3) {
      for (let p = 0; p < sim.n; p++) {
        if (!sim.active[p] || sim.failed[p]) continue;
        const J = sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p];
        if (!Number.isFinite(J + sim.pres[p] + sim.sxx[p] + sim.px[p])) {
          r.nan++;
          continue;
        }
        const Je = J * Math.exp(-sim.ev[p]); // elastic volume ratio (GTN: J also holds the plastic dilatation)
        if (Je < 0.98 || Je > 1.02) r.badJ++;
        if (sim.px[p] < -Lc || sim.px[p] > 0) continue;
        if (sim.eta[p] > 1) r.eta1++;
        r.psum += sim.pres[p];
        r.pn++;
        const i = sim.li[p];
        const j = sim.lj[p];
        for (const q of [i < NI - 1 ? lattice[(i + 1) * NJ + j] : -1, j < NJ - 1 ? lattice[i * NJ + j + 1] : -1]) {
          if (q < 0 || !sim.active[q] || sim.failed[q]) continue;
          const d = Math.abs(sim.pres[p] - sim.pres[q]);
          r.dsum += d;
          r.dn++;
          if (d > r.dmax) r.dmax = d;
        }
      }
    }
    if (r.nan > 0 || sim.tailX() > -0.5 * Lc || head >= 1e3) break;
  }
  const d = sim.diagnostics();
  let fMax = 0;
  for (let p = 0; p < sim.n; p++) if (sim.active[p] && sim.por[p] > fMax) fMax = sim.por[p];
  return { ...r, failed: d.nFailed, noise: r.dsum / r.dn / (r.psum / r.pn), fMax };
}

const a = pass(10, false);
ok(a.pn > 1000, '10 cells: the bite was sampled', `${a.pn} point-samples`);
ok(a.nan === 0, '10 cells: no NaN', `${a.nan}`);
ok(a.badJ === 0, '10 cells: J within 0.98..1.02', `${a.badJ} point-samples outside`);
ok(a.eta1 === 0, '10 cells: no η > 1 in the bite', `${a.eta1} point-samples`);
ok(a.failed === 0, '10 cells: ductile SPCC does not crack', `${a.failed}`);
between(a.noise, 0, 0.08, '10 cells: mean pressure jump between lattice neighbours in the bite / mean pressure (grid-smoothed total J: 0.013; an unstable scheme: > 0.3)');

done();
