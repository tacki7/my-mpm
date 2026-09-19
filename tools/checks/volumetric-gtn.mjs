// The volumetric scheme with GTN and the paper's nucleation (voids also nucleate in compression),
// 6 cells, 4 mm of sheet, while the bite is at least half full: the plastic dilatation εv stays per point, so
// it must not show up as pressure noise (averaging J but not εv: neighbour jumps up to 347 MPa) or as
// spurious tension, and the porosity stays below fc.
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

const g = pass(6, true);
ok(g.pn > 300, "GTN 'always', 6 cells: the bite was sampled", `${g.pn} point-samples`);
ok(g.nan === 0, "GTN 'always', 6 cells: no NaN", `${g.nan}`);
ok(g.badJ === 0, "GTN 'always': elastic volume ratio within 0.98..1.02", `${g.badJ}`);
ok(g.eta1 === 0, "GTN 'always': no η > 1 in the bite", `${g.eta1}`);
between(g.dmax * 1e-6, 0, 200, "GTN 'always': largest pressure jump between lattice neighbours in the bite [MPa] (averaging J but not εv: 347)");
between(g.fMax, 0, 0.05, "GTN 'always': porosity stays below fc");
done();
