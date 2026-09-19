// The volumetric (anti-locking) scheme on a thick plate (h0 10 mm, R 15 mm, 5 %, 8 cells, 24 mm):
// - plane strain ahead of the bite: where nothing has yielded, σzz = ν(σxx + σyy). The deviatoric
//   update has to see the same volume change as the pressure (smoothing J but not tr D broke this:
//   σzz −156 MPa where ν(σxx + σyy) was −2 MPa)
// - no pressure diffusion: σm/2k at the plate centre in mid-bite (Hill's slip-line field: +0.39 at
//   this H/L) is not pulled negative, and does not depend on the time step (mass scaling 1e4 against
//   2e3). Re-smoothing the total J every step diffused the pressure with D ≈ h²/(4Δt).
// docs/validation.md「体積の平均化」holds the converged numbers.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams, STEEL_4340 } from '../../src/mpm/params.ts';
import { flowStress } from '../../src/mpm/material.ts';

function run(massScale, wantElastic) {
  const P = defaultParams();
  P.rolling.h0 = 10e-3;
  P.rolling.reduction = 0.05;
  P.rolling.rollRadius = 15e-3;
  P.rolling.sheetLength = 24e-3;
  P.rolling.mu = 0.3;
  P.material = { ...STEEL_4340 };
  P.damage.model = 'none';
  P.numerics.cellsThrough = 8;
  P.numerics.massScale = massScale;
  const sim = new Sim(P);
  const mat = P.material;
  const k0 = (2 / Math.sqrt(3)) * flowStress(mat, 0, 1, mat.tRoom).sy;
  const Lc = sim.contactLength;
  const h0 = P.rolling.h0;
  const epPrev = new Float64Array(sim.n);
  let sw = 0;
  let s = 0;
  let elErr = 0;
  let elN = 0;
  let nan = 0;
  while (sim.step < 200000) {
    for (let k = 0; k < 10; k++) sim.advance();
    const head = sim.headX();
    const tail = sim.tailX();
    if (head > 2 * Lc && head < 1e3 && tail < -Lc - h0) {
      for (let p = 0; p < sim.n; p++) {
        if (!sim.active[p]) continue;
        const pr = sim.pres[p];
        if (!Number.isFinite(pr + sim.sxx[p])) nan++;
        const x = sim.px[p];
        if (x > -0.6 * Lc && x < -0.4 * Lc && Math.abs(sim.py[p]) < 0.6 * sim.h) {
          // weighted by the plastic increment: the yielding centre
          const dep = sim.ep[p] - epPrev[p];
          if (dep > 0) {
            const k2 = (2 / Math.sqrt(3)) * flowStress(mat, sim.ep[p], 1, mat.tRoom).sy;
            s += (-pr / k2) * dep;
            sw += dep;
          }
        }
        if (wantElastic && sim.ep[p] === 0 && x > -Lc - 2 * h0 && x < -Lc - 0.5 * h0) {
          const sum = sim.sxx[p] + sim.syy[p] - 2 * pr;
          elErr += Math.abs(sim.szz[p] - pr - mat.nu * sum) / k0;
          elN++;
        }
      }
    }
    for (let p = 0; p < sim.n; p++) epPrev[p] = sim.ep[p];
    if (head >= 1e3 || tail > -Lc) break;
  }
  return { centre: sw > 0 ? s / sw : NaN, elastic: elN ? elErr / elN : NaN, elN, nan };
}

const a = run(1e4, true);
const b = run(2e3, false);
ok(a.nan === 0 && b.nan === 0, 'no NaN', `${a.nan}, ${b.nan}`);
ok(a.elN > 1000, 'elastic points ahead of the bite were sampled', `${a.elN}`);
between(a.elastic, 0, 1e-6, 'plane strain ahead of the bite: mean |σzz − ν(σxx + σyy)| / 2k');
between(a.centre, -0.2, 0.4, 'σm/2k at the plate centre in mid-bite, mass scaling 1e4 (smoothing the total J: ≈ −0.3)');
between(b.centre - a.centre, -0.03, 0.03, 'the same with mass scaling 2e3 minus 1e4 (a scheme that diffuses depends on the time step)');
done();
