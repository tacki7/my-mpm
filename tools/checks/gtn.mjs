// The GTN return mapping (Banerjee 2012, eqs. 13–17) against what it must do:
// with no porosity it is the J2 radial return, the returned state is on the
// yield surface with an associated flow, voids grow under tension and not under
// hydrostatic compression, and the constants change the growth the right way.
// f* is capped at 1/q1, where the yield surface has shrunk to nothing (past it
// the surface grew again and a point under tension looked elastic), and in the
// solver a point whose porosity is at that fF fails under any damage criterion.
// @check
import { ok, near, between, done } from './lib.mjs';
import {
  elasticConstants,
  flowStress,
  gtnFailurePorosity,
  gtnFstar,
  gtnNucleation,
  gtnReturn,
  gtnYield,
  plasticIncrement,
} from '../../src/mpm/material.ts';
import { GTN_4340, STEEL_4340, STEEL_SPCC, defaultParams } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';

const T = 294;
const rate = 1;
const noVoids = { ...GTN_4340, fn: 0, f0: 0 };

// f = 0: the J2 radial return, whatever the mean stress.
for (const [mat, name] of [
  [STEEL_SPCC, 'Swift'],
  [STEEL_4340, 'Johnson-Cook'],
]) {
  const { K, G } = elasticConstants(mat);
  for (const ep of [0, 0.1]) {
    const y = flowStress(mat, ep, rate, T).sy;
    let worst = 0;
    let dev = 0;
    for (const sm of [-2 * y, 0, 2 * y]) {
      const r = gtnReturn(mat, noVoids, K, G, 1.5 * y, sm, ep, 0, rate, T);
      const d = plasticIncrement(mat, G, 1.5 * y, ep, rate, T);
      worst = Math.max(worst, Math.abs(r.dEq / d - 1));
      dev = Math.max(dev, Math.abs(r.dEv) + Math.abs(r.df) + Math.abs(r.sm - sm));
    }
    between(worst, 0, 1e-8, `${name}, εp ${ep}: f = 0 gives the J2 plastic increment (worst relative difference)`);
    ok(dev === 0, `${name}, εp ${ep}: f = 0 leaves the volume, the porosity and the mean stress alone`, `${dev}`);
  }
}

// f > 0: the returned state is on the yield surface and the flow is associated.
const m = STEEL_SPCC;
const { K, G } = elasticConstants(m);
const ep = 0.1;
const f = 0.02;
const g = { ...GTN_4340, fn: 0 }; // growth only
const y = flowStress(m, ep, rate, T).sy;
const fs = gtnFstar(g, f);
const trials = [
  ['uniaxial tension', 1.3 * y, (1.3 * y) / 3],
  ['plane-strain tension', 1.3 * y, 0.577 * 1.3 * y],
  ['shear', 1.3 * y, 0],
  ['compression', 1.3 * y, -1.3 * y],
  ['hydrostatic tension', 0, 3 * y],
  ['hydrostatic compression', 0, -3.5 * y],
];
const step = {};
for (const [name, q, sm] of trials) {
  ok(gtnYield(g, q, sm, y, fs) > 0, `${name}: the trial state is plastic`);
  const r = gtnReturn(m, g, K, G, q, sm, ep, f, rate, T);
  step[name] = r;
  const sy = flowStress(m, ep + r.dEm, rate, T).sy;
  const phi = gtnYield(g, r.q, r.sm, sy, fs);
  // normality: Δεv ∂Φ/∂q = Δεq ∂Φ/∂σm
  const dq = (2 * r.q) / (sy * sy);
  const dm = ((3 * g.q1 * g.q2 * fs) / sy) * Math.sinh((1.5 * g.q2 * r.sm) / sy);
  const normal = Math.abs(r.dEv * dq - r.dEq * dm) / (Math.abs(r.dEv * dq) + Math.abs(r.dEq * dm) + 1e-30);
  between(Math.abs(phi), 0, 1e-8, `${name}: returned state on the yield surface |Φ|`);
  between(normal, 0, 1e-6, `${name}: associated flow (relative normality residual)`);
  near(r.q, q - 3 * G * r.dEq, 1e-12, `${name}: q = q_tr − 3G Δεq`);
  near(r.sm, sm - K * r.dEv, 1e-12, `${name}: σm = σm_tr − K Δεv`);
}
ok(step['uniaxial tension'].df > 0, 'voids grow in uniaxial tension', `Δf ${step['uniaxial tension'].df.toExponential(3)}`);
ok(step['hydrostatic tension'].df > step['plane-strain tension'].df && step['plane-strain tension'].df > step['uniaxial tension'].df, 'growth rises with the triaxiality (uniaxial < plane strain < hydrostatic)');
ok(step['shear'].dEv === 0 && step['shear'].df === 0, 'no growth in pure shear (σm = 0)');
ok(step['compression'].df < 0 && step['hydrostatic compression'].df < 0, 'voids close under compression', `Δf ${step['compression'].df.toExponential(3)}, ${step['hydrostatic compression'].df.toExponential(3)}`);

// Nucleation: normal distribution in the matrix strain; only in tension when asked.
near(gtnNucleation(GTN_4340, GTN_4340.en), GTN_4340.fn / (GTN_4340.sn * Math.sqrt(2 * Math.PI)), 1e-12, 'nucleation rate peaks at εn with fn / (sn √(2π))');
near(gtnNucleation(GTN_4340, GTN_4340.en + GTN_4340.sn), gtnNucleation(GTN_4340, GTN_4340.en) * Math.exp(-0.5), 1e-12, 'one sn away it is e^(−1/2) of the peak');
const hc = { ...GTN_4340, nucleation: 'tension' };
const rc = gtnReturn(m, hc, K, G, 0, -3.5 * y, ep, f, rate, T);
const ra = gtnReturn(m, { ...GTN_4340, nucleation: 'always' }, K, G, 0, -3.5 * y, ep, f, rate, T);
ok(rc.df < 0 && rc.df === (1 - f) * rc.dEv, "hydrostatic compression with nucleation 'tension': growth only, and the voids close", `Δf ${rc.df.toExponential(3)}`);
ok(ra.df > rc.df, "nucleation 'always' adds voids under compression too (the paper's law)", `Δf ${ra.df.toExponential(3)}`);

// The constants change the growth the right way.
const ut = (gg) => gtnReturn(m, gg, K, G, 1.3 * y, (1.3 * y) / 3, ep, f, rate, T).df;
ok(ut({ ...g, q1: 2 }) > ut(g), 'a larger q1 grows voids faster');
ok(ut({ ...g, q2: 1.2 }) > ut(g), 'a larger q2 grows voids faster');
ok(ut({ ...GTN_4340, fn: 0.2 }) > ut({ ...GTN_4340, fn: 0.1 }), 'more nucleating particles (fn) nucleate more');
near(gtnFstar(GTN_4340, 0.03), 0.03, 0, 'f* = f below fc');
near(gtnFstar(GTN_4340, 0.06), 0.05 + 4 * 0.01, 1e-12, 'f* = fc + k (f − fc) beyond fc');

// f* is capped at f*_u = 1/q1 (Tvergaard-Needleman), where Φ = 0 has shrunk to the point q = σm = 0: past it the
// constant term of Φ outgrew the cosh term, the surface grew again and a point whose voids kept growing under
// tension looked elastic (2026-09-30). gtnFailurePorosity is the f at which f* gets there.
{
  const g = GTN_4340;
  const fu = 1 / g.q1;
  const fF = gtnFailurePorosity(g);
  near(fF, g.fc + (fu - g.fc) / g.k, 1e-12, "fF = fc + (1/q1 − fc) / k (0.2042 with the paper's constants)");
  near(gtnFstar(g, fF), fu, 1e-12, 'f*(fF) = 1/q1');
  let over = 0;
  let drops = 0;
  let prev = 0;
  for (let f = 0; f <= 1; f += 1e-3) {
    const fs = gtnFstar(g, f);
    if (fs > fu) over++;
    if (fs < prev) drops++;
    prev = fs;
  }
  ok(over === 0 && drops === 0, 'f* never exceeds 1/q1 and never falls as f grows (f from 0 to 1)', `${over} over, ${drops} drops`);
  near(gtnFstar(g, 0.5), fu, 0, 'f*(0.5) = 1/q1 (it was 1.85)');
  const sy0 = 1e9;
  between(Math.abs(gtnYield(g, 0, 0, sy0, fu)), 0, 1e-12, 'at f* = 1/q1 the yield surface is the point q = σm = 0 (Φ(0, 0) = 0)');
  ok(gtnYield(g, 1e6, 0, sy0, fu) > 0 && gtnYield(g, 0, 1e6, sy0, fu) > 0 && gtnYield(g, 0, -1e6, sy0, fu) > 0, 'and any stress, tension or compression, is outside it');
  // the case that flipped: 4340 with f 0.5 and a trial of q 800 MPa, σm 400 MPa came back elastic (Φ −0.46, null)
  const m4 = STEEL_4340;
  const e4 = elasticConstants(m4);
  const r = gtnReturn(m4, g, e4.K, e4.G, 800e6, 400e6, 0, 0.5, rate, T);
  ok(r !== null, '4340, f 0.5, q_tr 800 MPa, σm 400 MPa: plastic (the return is not null)');
  ok(r !== null && Number.isFinite(r.q) && Number.isFinite(r.sm) && r.q >= 0 && r.q < 800e6 && Math.abs(r.sm) < 400e6, 'and the returned state is finite, inside the trial', r ? `q ${(r.q * 1e-6).toFixed(3)} MPa, σm ${(r.sm * 1e-6).toFixed(3)} MPa` : 'null');
  if (r) between(Math.abs(gtnYield(g, r.q, r.sm, flowStress(m4, r.dEm, rate, T).sy, fu)), 0, 1e-6, 'on the (collapsed) surface: |Φ| at the returned state');
}

// In the solver (yield 'gtn' with the Johnson-Cook criterion, 4 cells, 6 mm, about 1 s): a point in the bite whose
// porosity is at fF fails in the next step, one at fF / 2 does not (no criterion failed it before 2026-09-30).
{
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.damage = { ...P.damage, yield: 'gtn', model: 'johnson-cook', gtn: { ...GTN_4340 } };
  const sim = new Sim(P);
  const fF = gtnFailurePorosity(P.damage.gtn);
  // into the bite: the points that flowed in the last step
  const flowed = () => {
    const ep0 = Float64Array.from(sim.ep);
    sim.advance();
    const out = [];
    for (let p = 0; p < sim.n; p++) if (sim.active[p] && sim.ep[p] > ep0[p]) out.push(p);
    return out;
  };
  let flowing = [];
  while (sim.step < 20000 && flowing.length < 8) flowing = flowed();
  ok(flowing.length >= 8, 'points flow in the bite', `${flowing.length} at step ${sim.step}`);
  const at = flowing.filter((_, i) => i % 2 === 0);
  const under = flowing.filter((_, i) => i % 2 === 1);
  for (const p of at) sim.por[p] = fF;
  for (const p of under) sim.por[p] = fF / 2;
  sim.advance();
  const failedAt = at.filter((p) => sim.failed[p] === 1).length;
  const failedUnder = under.filter((p) => sim.failed[p] === 1).length;
  ok(failedAt === at.length, 'the points at fF fail in the next step', `${failedAt} of ${at.length}`);
  ok(failedUnder === 0, 'the points at fF / 2 do not', `${failedUnder} of ${under.length}`);
  let bad = 0;
  for (let p = 0; p < sim.n; p++) if (sim.active[p] && !(Number.isFinite(sim.sxx[p]) && Number.isFinite(sim.pres[p]) && Number.isFinite(sim.por[p]))) bad++;
  ok(bad === 0, 'every stress and porosity is finite', `${bad} not`);
}
done();
