// The GTN return mapping (Banerjee 2012, eqs. 13–17) against what it must do:
// with no porosity it is the J2 radial return, the returned state is on the
// yield surface with an associated flow, voids grow under tension and not under
// hydrostatic compression, and the constants change the growth the right way.
// @check
import { ok, near, between, done } from './lib.mjs';
import {
  elasticConstants,
  flowStress,
  gtnFstar,
  gtnNucleation,
  gtnReturn,
  gtnYield,
  plasticIncrement,
} from '../../src/mpm/material.ts';
import { GTN_4340, STEEL_4340, STEEL_SPCC } from '../../src/mpm/params.ts';

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
done();
