// A coarse rolling pass end to end (6 cells through 1 mm, 8 mm of sheet, about
// 20 000 steps): the sheet is bitten, rolled and leaves; force, gauge, slip and
// the pressure field stay in physical bands; a ductile sheet does not crack; the
// friction hill carries the roll force, is smooth, and has its neutral point in
// the bite where the forward slip puts it. The contact acts at the surface: the
// outermost particles carry the roll pressure without sinking into the rolls, and
// every row of particles gets about as much thinner as the sheet does.
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

const { NI, NJ, lattice, rolls, dp } = sim;
const Lc = sim.contactLength;
// outermost particle layer: −n·σ·n per bin (n: roll centre → point), and its deepest edge inside a roll
const sn = new Float64Array(sim.nBins);
const sc = new Float64Array(sim.nBins);
let sinkMax = 0;
const surface = () => {
  for (let i = 0; i < NI; i++) {
    for (const [k, j] of [[0, NJ - 1], [1, 0]]) {
      const q = lattice[i * NJ + j];
      if (q < 0 || !sim.active[q]) continue;
      const roll = rolls[k];
      const rx = sim.px[q] - roll.cx;
      const ry = sim.py[q] - roll.cy;
      const d = Math.hypot(rx, ry);
      const sink = (roll.R + 0.5 * dp * Math.hypot(sim.f01[q], sim.f11[q]) - d) / dp;
      if (sink > sinkMax) sinkMax = sink;
      const b = Math.floor((sim.px[q] - sim.binX0) / sim.binW);
      if (b < 0 || b >= sim.nBins) continue;
      const [nx, ny, pr] = [rx / d, ry / d, sim.pres[q]];
      sn[b] -= nx * ((sim.sxx[q] - pr) * nx + sim.sxy[q] * ny) + ny * (sim.sxy[q] * nx + (sim.syy[q] - pr) * ny);
      sc[b]++;
    }
  }
};
const steady = [];
const hill = [];
const layer = [];
let spurious = 0;
let badJ = 0;
let nan = 0;
while (sim.step < 60000) {
  sn.fill(0);
  sc.fill(0);
  for (let k = 0; k < 1000; k++) {
    sim.advance();
    if (k % 100 === 0) surface();
  }
  const d = sim.diagnostics();
  const prof = sim.pressureProfile();
  if (d.phase === 'steady') {
    steady.push(d);
    // the outermost layer against the roll pressure over the middle half of the bite
    let ps = 0;
    let pn = 0;
    for (let b = 0; b < sim.nBins; b++) {
      if (prof.x[b] < -0.75 * Lc || prof.x[b] > -0.25 * Lc || sc[b] === 0) continue;
      ps += sn[b] / sc[b];
      pn += prof.p[b];
    }
    layer.push(ps / pn);
    // integral of the pressure, and the mean jump between neighbouring bins inside the bite / the mean pressure there
    let F = 0;
    let sum = 0;
    let jump = 0;
    for (let b = 0; b < sim.nBins; b++) {
      F += prof.p[b] * sim.binW;
      if (prof.x[b] > -sim.contactLength && prof.x[b + 1] < 0) {
        sum += prof.p[b];
        jump += Math.abs(prof.p[b + 1] - prof.p[b]);
      }
    }
    // a second read with nothing stepped in between (the page does this while paused) repeats the profile
    const again = sim.pressureProfile();
    const repeated = again.p.every((v, b) => v === prof.p[b]) && again.tau.every((v, b) => v === prof.tau[b]);
    hill.push({ F, saw: jump / sum, repeated, xn: d.neutralX, ford: -Math.sqrt(Math.max(0, d.forwardSlip ?? 0) * P.rolling.rollRadius * (d.exitThickness ?? NaN)) });
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
// how much thinner each row of points got (head and tail fifths left out), from the spacing to its neighbours
const thin = (j) => {
  let s = 0;
  let c = 0;
  for (let i = Math.floor(NI / 5); i < NI - Math.floor(NI / 5); i++) {
    for (const jj of [j, NJ - 1 - j]) {
      const lo = lattice[i * NJ + Math.max(0, jj - 1)];
      const hi = lattice[i * NJ + Math.min(NJ - 1, jj + 1)];
      s += Math.log(((Math.min(NJ - 1, jj + 1) - Math.max(0, jj - 1)) * dp) / (sim.py[hi] - sim.py[lo]));
      c++;
    }
  }
  return s / c;
};
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
ok(last.phase === 'done', 'the sheet goes through the rolls and leaves', `phase ${last.phase} at step ${sim.step}`);
ok(steady.length >= 2, 'a steady phase is reached', `${steady.length} samples`);
between(mean(steady.map((d) => d.rollForce)) * 1e-6, 2.5, 5, 'steady roll force [kN/mm] (slab method 3.03, docs/validation.md)');
between(mean(steady.map((d) => d.exitThickness ?? NaN)) * 1e3, 0.745, 0.77, 'exit thickness [mm] (gap 0.75 + springback)');
between(mean(steady.map((d) => d.forwardSlip ?? NaN)) * 100, 0, 6, 'forward slip [%]');
ok(nan === 0, 'no NaN in positions or stresses', `${nan}`);
ok(badJ === 0, 'volume ratio J stays within 0.98..1.02 (plastic flow is isochoric)', `${badJ} point-samples outside`);
ok(spurious === 0, 'no hydrostatic tension (η > 1) inside the roll bite', `${spurious} point-samples`);
between(mean(hill.map((h) => h.F)) / mean(steady.map((d) => d.rollForce)), 0.9, 1.1, 'integral of the pressure profile / roll force');
between(Math.max(...hill.map((h) => h.saw)), 0, 0.25, 'friction hill is smooth (mean jump between neighbouring bins / mean pressure; 1.3 when bins caught 0–2 grid columns)');
ok(hill.every((h) => h.repeated), 'a profile read again without a step repeats the last one (not zeros)');
ok(hill.every((h) => h.xn != null && h.xn > -sim.contactLength && h.xn < 0), 'neutral point inside the bite', hill.map((h) => (h.xn == null ? 'none' : (h.xn * 1e3).toFixed(3) + ' mm')).join(', '));
between(mean(hill.map((h) => h.xn / h.ford)), 0.75, 1.25, "neutral point / Ford's xn = −√(f R h1) from the forward slip");
ok(last.nFailed === 0, 'ductile SPCC at 25 % does not crack', `${last.nFailed} failed, max D ${last.maxDamage.toFixed(3)}`);
// the contact acts at the surface (marking the whole 3 × 3 stencil pinned a band 1.5 cells deep: 0.57, rows −0.02 / 0.68)
between(mean(layer), 0.75, 1.25, 'outermost particles carry the roll pressure (−n·σ·n / p, middle half of the bite)');
between(sinkMax, 0, 0.02, 'no particle edge sinks into a roll (deepest edge, in dp; 0.071 with the roll-side nodes held to the roll surface velocity alone)');
between(thin(0) / thin(Math.floor(NJ / 2) - 1), 0.8, 1.2, 'surface rows get about as much thinner as the centre rows (ln of the spacing ratio)');
done();
