// The material instability indicators (src/mpm/bifurcation.ts): the closed-form minimum of
// the acoustic tensor against a brute-force contraction of the 4th-order tangent, the
// plane-strain results (a band needs H ≤ 0, at ±45° to the principal axes), Drucker's
// measure along a return-mapped loading path, and the wiring in the solver.
// @check
import { ok, between, done } from './lib.mjs';
import { druckerWork, localization } from '../../src/mpm/bifurcation.ts';
import { elasticConstants, flowStress, plasticIncrement } from '../../src/mpm/material.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';

const P = defaultParams();
const el = elasticConstants(P.material);
const { K, G } = el;
const deg = Math.PI / 180;
const angleGap = (a, b) => {
  let d = (a - b) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  return Math.abs(d);
};

// ── brute force: C_ijkl = K δij δkl + G (δik δjl + δil δjk − 2/3 δij δkl) − 6G²/(3G+H) n̂ij n̂kl,
//    A_jk = n_i C_ijkl n_l with n = (cos θ, sin θ, 0), det of the full 3×3
function detAcoustic(s, H, theta) {
  const [sxx, syy, sxy, szz] = s;
  const S = [[sxx, sxy, 0], [sxy, syy, 0], [0, 0, szz]];
  const norm = Math.sqrt(S.flat().reduce((a, v) => a + v * v, 0));
  const c = Number.isFinite(H) ? (6 * G * G) / (3 * G + H) : 0;
  const d = (i, j) => (i === j ? 1 : 0);
  const n = [Math.cos(theta), Math.sin(theta), 0];
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        for (let l = 0; l < 3; l++) {
          const C = K * d(i, j) * d(k, l) + G * (d(i, k) * d(j, l) + d(i, l) * d(j, k) - (2 / 3) * d(i, j) * d(k, l)) - (c * S[i][j] * S[k][l]) / (norm * norm);
          A[j][k] += n[i] * C * n[l];
        }
  return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
}
function bruteMin(s, H) {
  const e = detAcoustic(s, Infinity, 0);
  let best = { ratio: Infinity, theta: 0 };
  for (let i = 0; i < 18000; i++) {
    const t = -Math.PI / 2 + (i + 0.5) * 0.01 * deg;
    const r = detAcoustic(s, H, t) / e;
    if (r < best.ratio) best = { ratio: r, theta: t };
  }
  // golden-section refinement around the best sample
  let a = best.theta - 0.01 * deg;
  let b = best.theta + 0.01 * deg;
  for (let it = 0; it < 40; it++) {
    const m1 = b - 0.618 * (b - a);
    const m2 = a + 0.618 * (b - a);
    if (detAcoustic(s, H, m1) < detAcoustic(s, H, m2)) b = m2;
    else a = m1;
  }
  const t = 0.5 * (a + b);
  return { ratio: detAcoustic(s, H, t) / e, theta: t, e };
}

// ── 1. elastic: nothing to localize
{
  const r = localization(el, Infinity, 100e6, -50e6, 30e6, -50e6);
  ok(r.ratio === 1, 'elastic point (H = ∞): det A / det Aₑ = 1');
  ok(localization(el, 500e6, 0, 0, 0, 0).ratio === 1, 'no deviatoric stress: 1');
}

// ── 2. in-plane flow (s_zz = 0, plane-strain pure shear in its principal axes): min = H/(3G + H) at ±45°
for (const alpha of [0, 20 * deg, -65 * deg]) {
  const tau = 300e6;
  const s = [tau * Math.cos(2 * alpha), -tau * Math.cos(2 * alpha), tau * Math.sin(2 * alpha), 0];
  for (const H of [800e6, 0, -300e6]) {
    const r = localization(el, H, ...s);
    const want = H / (3 * G + H);
    ok(Math.abs(r.ratio - want) < 1e-12, `in-plane flow, axes at ${(alpha / deg).toFixed(0)}°, H = ${H * 1e-6} MPa: ratio = H/(3G+H)`, `got ${r.ratio.toExponential(6)}, want ${want.toExponential(6)}`);
    const gap = Math.min(angleGap(r.theta, alpha + 45 * deg), angleGap(r.theta, alpha - 45 * deg));
    ok(gap < 1e-9, `  band normal at ±45° to the principal axes`, `θ = ${(r.theta / deg).toFixed(4)}°`);
  }
}
ok(localization(el, 1e6, 1e8, -1e8, 0, 0).ratio > 0 && localization(el, -1e6, 1e8, -1e8, 0, 0).ratio < 0, 'the sign of the minimum follows the sign of H (plane strain, J2)');

// ── 3. out-of-plane stress makes a band harder to form: H = 0 but s_zz ≠ 0 → ratio > 0
{
  const r = localization(el, 0, 200e6, 100e6, 0, -300e6);
  ok(r.ratio > 0.05, 'H = 0 with s_zz ≠ 0 (flow out of the plane): no band', `ratio ${r.ratio.toFixed(4)}`);
}

// ── 4. against the brute-force contraction on random deviatoric states
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let worst = 0;
  let worstTheta = 0;
  let cases = 0;
  for (let t = 0; t < 12; t++) {
    const a = rnd() * 400e6;
    const b = rnd() * 400e6;
    const s = [a, b, rnd() * 200e6, -(a + b) * (t % 3 === 0 ? 1 : rnd() * 0.3 + 0.7)];
    // keep it deviatoric
    const m = (s[0] + s[1] + s[3]) / 3;
    s[0] -= m;
    s[1] -= m;
    s[3] -= m;
    for (const H of [2e9, 300e6, 0, -150e6]) {
      const fast = localization(el, H, ...s);
      const slow = bruteMin(s, H);
      worst = Math.max(worst, Math.abs(fast.ratio - slow.ratio));
      // the closed form's angle must reach the minimum too (two mirror bands)
      worstTheta = Math.max(worstTheta, Math.abs(detAcoustic(s, H, fast.theta) / slow.e - slow.ratio));
      cases++;
    }
  }
  ok(worst < 1e-9, `closed-form minimum = brute-force minimum over θ (${cases} states)`, `max |Δ| ${worst.toExponential(2)}`);
  ok(worstTheta < 1e-9, `det A at the returned band normal is the minimum`, `max |Δ| ${worstTheta.toExponential(2)}`);
}

// ── 5. Drucker along a return-mapped plane-strain compression (the solver's update, one point)
function compress(steps, tempOf, rateOf, dir = [0.5, -0.5, 0, 0]) {
  const m = P.material;
  const dt = 1e-6;
  let s = [0, 0, 0, 0];
  let ep = 0;
  let T = m.tRoom;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const rate = rateOf(i); // [1/s]
    const e = dir.map((v) => v * rate); // deviatoric rate (xx, yy, xy, zz); by default x stretches, y compresses, no z
    const start = [...s];
    const tr = s.map((v, k) => v + 2 * G * dt * e[k]);
    const q = Math.sqrt(1.5 * (tr[0] ** 2 + tr[1] ** 2 + tr[3] ** 2 + 2 * tr[2] ** 2));
    T += tempOf(i);
    const epsDot = Math.sqrt((2 / 3) * (e[0] ** 2 + e[1] ** 2 + e[3] ** 2 + 2 * e[2] ** 2));
    const dep = plasticIncrement(m, G, q, ep, epsDot, T);
    const f = dep > 0 ? 1 - (3 * G * dep) / q : 1;
    s = tr.map((v) => v * f);
    ep += dep;
    const qn = q - 3 * G * dep;
    const w = druckerWork(s[0] - start[0], s[1] - start[1], s[2] - start[2], s[3] - start[3], ...s, qn, dep);
    out.push({ dep, mod: dep > 0 ? w / (dep * dep) : NaN, H: flowStress(m, ep, epsDot, T).H });
  }
  return out;
}
{
  const none = () => 0;
  const path = compress(4000, none, () => 2000);
  const late = path.slice(-100).filter((r) => r.dep > 0);
  const rel = Math.max(...late.map((r) => Math.abs(r.mod / r.H - 1)));
  ok(late.length === 100 && rel < 0.01, 'Drucker: proportional compression, σ̇:Dp / ε̇p² = H', `max |mod/H − 1| ${rel.toExponential(2)}`);
  // a path with out-of-plane deviator (s_zz ≠ 0) and shear
  const d3 = compress(4000, none, () => 2000, [-0.6, 0.2, 0.3, 0.4]).slice(-100);
  const rel3 = Math.max(...d3.map((r) => Math.abs(r.mod / r.H - 1)));
  ok(d3.every((r) => r.dep > 0) && rel3 < 0.01, 'Drucker: proportional path with s_zz and s_xy, σ̇:Dp / ε̇p² = H', `max |mod/H − 1| ${rel3.toExponential(2)}`);
  // the last 100 steps heat by 5 K each (the thermal factor 1 − T*^m of the flow stress)
  const hot = compress(4000, (i) => (i < 3900 ? 0 : 5), () => 2000).slice(-100);
  ok(hot.every((r) => r.dep > 0 && r.mod < 0), 'Drucker: heating while flowing softens → σ̇:Dp < 0', `mod ${(hot[99].mod * 1e-6).toFixed(0)} MPa`);
  const slow = compress(4000, none, (i) => (i < 3000 ? 2000 : 2000 * Math.exp(-(i - 3000) / 200))).slice(3050, 3150);
  const flowing = slow.filter((r) => r.dep > 0);
  ok(flowing.length >= 50 && flowing.every((r) => r.mod < 0), 'Drucker: the strain rate falling while flowing (rate softening) → σ̇:Dp < 0', `${flowing.length} flowing steps`);
}

// ── 6. in the solver: the fields, and failure by localization only when the material softens
function run(mod) {
  const p = defaultParams();
  p.numerics.cellsThrough = 4;
  p.rolling.sheetLength = 8e-3;
  mod(p);
  const sim = new Sim(p);
  let d;
  // until the bite is full (steady or, for a short strip, the tail already in it), or something failed
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 500; k++) sim.advance();
    d = sim.diagnostics();
    if (d.phase === 'steady' || d.phase === 'tail-out' || d.phase === 'done' || d.nFailed > 0) break;
  }
  return { sim, d };
}
{
  const { sim, d } = run((p) => (p.damage.model = 'localization'));
  // "flowing" judged independently of the solver's own record: εp grew over one more step
  const ep0 = Float64Array.from(sim.ep);
  sim.advance();
  const loc = new Float32Array(sim.n);
  const dr = new Float32Array(sim.n);
  sim.readField('loc', loc);
  sim.readField('drucker', dr);
  let flowing = 0;
  let still = 0;
  let bad = 0;
  let minLoc = Infinity;
  const ratio = []; // drucker / H (without the rate factor) over the first half of the bite
  const Lc = sim.contactLength;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    if (!Number.isFinite(loc[p]) || !Number.isFinite(dr[p])) bad++;
    if (sim.ep[p] > ep0[p]) {
      flowing++;
      if (!(loc[p] < 1)) bad++;
      minLoc = Math.min(minLoc, loc[p]);
      if (sim.px[p] > -Lc && sim.px[p] < -Lc / 2) ratio.push(dr[p] / (flowStress(sim.params.material, sim.ep[p], 0, sim.temp[p]).H * 1e-6));
    } else {
      still++;
      if (loc[p] !== 1 || dr[p] !== 0) bad++;
    }
  }
  ok((d.phase === 'steady' || d.phase === 'tail-out') && flowing > 0 && still > 0 && bad === 0, 'solver: loc < 1 where εp grew this step, loc = 1 and drucker = 0 where it did not', `${flowing} flowing, ${still} not, ${bad} bad`);
  between(minLoc, 1e-5, 0.05, 'solver: hardening SPCC in the bite, min det A / det Aₑ (≈ H/3G)');
  ratio.sort((a, b) => a - b);
  between(ratio[Math.floor(ratio.length / 2)], 0.3, 3, `solver: first half of the bite, median drucker / H (${ratio.length} points; about 1.4 on 6 cells)`);
  ok(d.nFailed === 0, 'solver: hardening material, damage model "localization" → no failure', `${d.nFailed} failed`);
  // strain softening from the start: σy = K (ε0 + εp)^n with n < 0
  const soft = run((p) => {
    p.damage.model = 'localization';
    p.material = { ...p.material, swN: -0.05 };
  });
  ok(soft.d.nFailed > 0, 'solver: softening material (Swift n = −0.05) → points fail by localization', `${soft.d.nFailed} failed by step ${soft.d.step}`);
}
done();
