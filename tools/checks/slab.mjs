// The slab method (src/mpm/slab.ts) against answers worked out independently:
// closed forms for a constant flow stress, a quadrature for the real flow stress
// without friction, the textbook Bland-Ford solution, the returned pressure and
// friction arrays, and the directions in which friction and tensions must move the
// load and the neutral point. The comparison with the MPM is in docs/validation.md.
// @check
import { ok, near, between, done } from './lib.mjs';
import { karman } from '../../src/mpm/slab.ts';
import { biteGeometry, defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
// constant flow stress σy = K: no hardening, no rate factor
const rigid = { ...P.material, swN: 0, jcC: 0 };
const twoK = (2 / Math.sqrt(3)) * rigid.swK;
const std = P.rolling;
const with_ = (o) => ({ ...std, ...o });
const thick = (r, x) => biteGeometry(r).gap + 2 * (r.rollRadius - Math.sqrt(r.rollRadius ** 2 - x * x));
const maxRel = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]) / Math.abs(b[i])), 0);

// ── 1. no friction, constant k: d(σx h) = −p dh with p = 2k − σx gives h dσx = −2k dh,
//       so p = 2k(1 − ln(h0/h)) from the entry and p = 2k(1 + ln(h/hf)) from the exit
{
  const r = with_({ mu: 0 });
  const s = karman(r, rigid);
  const hf = biteGeometry(r).gap;
  const eIn = Array.from(s.x, (x) => twoK * (1 - Math.log(r.h0 / thick(r, x))));
  const eOut = Array.from(s.x, (x) => twoK * (1 + Math.log(thick(r, x) / hf)));
  ok(maxRel(s.pEntry, eIn) < 1e-7, 'μ = 0: entry branch p = 2k(1 − ln(h0/h))', `max rel. error ${maxRel(s.pEntry, eIn).toExponential(2)}`);
  ok(maxRel(s.pExit, eOut) < 1e-7, 'μ = 0: exit branch p = 2k(1 + ln(h/hf))', `max rel. error ${maxRel(s.pExit, eOut).toExponential(2)}`);
  ok(!s.crossed, 'μ = 0: no neutral point (friction cannot draw the strip in)');
}

// ── 1b. no friction, the real SPCC (hardening and rate factor): h dσx = −2k dh still holds, so
//       σx = ∫ 2k dh/h from the entry (and from the exit). 2k(h) written out here from the Swift law,
//       εp = (2/√3) ln(h0/h) and the rate (2/√3) v |dh/dx| / h with v = v_mill hf/h (no slip without
//       friction), and integrated in h by the midpoint rule
{
  const r = with_({ mu: 0 });
  const m = P.material;
  const s = karman(r, m);
  const { gap: hf } = biteGeometry(r);
  const R = r.rollRadius;
  const c = 2 / Math.sqrt(3);
  const twoKh = (h) => {
    const x = -Math.sqrt(R * R - (R - (h - hf) / 2) ** 2);
    const rate = (c * ((r.millSpeed * hf) / h) * ((-2 * x) / Math.sqrt(R * R - x * x))) / h;
    const rf = rate > m.epsDot0 ? 1 + m.jcC * Math.log(rate / m.epsDot0) : 1;
    return c * m.swK * Math.pow(m.swE0 + c * Math.log(r.h0 / h), m.swN) * rf;
  };
  const integral = (a, b) => {
    const N = 4000;
    let I = 0;
    for (let j = 0; j < N; j++) {
      const mid = a + ((b - a) * (j + 0.5)) / N;
      I += (twoKh(mid) * (b - a)) / N / mid;
    }
    return I;
  };
  let eIn = 0;
  let eOut = 0;
  for (let i = 0; i < s.x.length; i += 50) {
    const h = s.h[i];
    const k2 = twoKh(h);
    eIn = Math.max(eIn, Math.abs(s.pEntry[i] - (k2 - integral(h, r.h0))) / k2);
    eOut = Math.max(eOut, Math.abs(s.pExit[i] - (k2 + integral(hf, h))) / k2);
  }
  ok(eIn < 1e-5, 'μ = 0, SPCC with hardening and rate: entry branch = quadrature of h dσx = −2k dh', `max |Δp| / 2k ${eIn.toExponential(2)}`);
  ok(eOut < 1e-5, 'μ = 0, SPCC with hardening and rate: exit branch = quadrature', `max |Δp| / 2k ${eOut.toExponential(2)}`);
}

// ── 2. friction, constant k: the equation is linear, h dp/dx = 2sμp − 4k tan φ.
//       Solve it with an integrating factor and plain quadrature on a 100× finer grid.
function linearBranch(r, s, N) {
  const { gap: hf, contactLength: L } = biteGeometry(r);
  const R = r.rollRadius;
  const x0 = s > 0 ? -L : 0;
  const dx = ((s > 0 ? 0 : -L) - x0) / N;
  const a = (x) => (2 * s * r.mu) / thick(r, x);
  const b = (x) => (-2 * twoK * (-x / Math.sqrt(R * R - x * x))) / thick(r, x);
  const p0 = twoK - (s > 0 ? r.backTension : r.frontTension);
  const out = new Float64Array(N + 1);
  out[0] = p0;
  let A = 0;
  let I = 0;
  let prev = b(x0);
  for (let i = 1; i <= N; i++) {
    const x = x0 + i * dx;
    A += (dx / 2) * (a(x - dx) + a(x));
    const g = b(x) * Math.exp(-A);
    I += (dx / 2) * (prev + g);
    prev = g;
    out[i] = Math.exp(A) * (p0 + I);
  }
  return out;
}
for (const r of [std, with_({ mu: 0.15, backTension: 60e6, frontTension: 120e6 })]) {
  const n = 2000;
  const s = karman(r, rigid, n);
  const fine = 100;
  const lin = { in: linearBranch(r, 1, n * fine), out: linearBranch(r, -1, n * fine) };
  const eIn = Array.from({ length: n + 1 }, (_, i) => lin.in[i * fine]);
  const eOut = Array.from({ length: n + 1 }, (_, i) => lin.out[(n - i) * fine]);
  const tag = `μ ${r.mu}, tensions ${r.backTension * 1e-6}/${r.frontTension * 1e-6} MPa`;
  const err = Math.max(maxRel(s.pEntry, eIn), maxRel(s.pExit, eOut));
  ok(err < 1e-6, `constant k, ${tag}: both branches match the integrating-factor solution`, `max rel. error ${err.toExponential(2)}`);
  // loads from the fine solution: the pressure is the lower branch; friction drags the strip
  // forward before the neutral point and back after it; the roll carries the reaction
  const N = n * fine;
  const { gap: hf, contactLength: L } = biteGeometry(r);
  const R = r.rollRadius;
  let xN = 0;
  let force = 0;
  let torque = 0;
  for (let i = 0; i <= N; i++) {
    const x = -L + (i * L) / N;
    const pin = lin.in[i];
    const pout = lin.out[N - i];
    if (pin > pout && xN === 0 && i > 0) {
      const a = lin.in[i - 1] - lin.out[N - i + 1];
      xN = x - (L / N) * ((pin - pout) / (pin - pout - a));
    }
    const sgn = pin <= pout ? 1 : -1;
    const p = Math.min(pin, pout);
    const t = -x / Math.sqrt(R * R - x * x);
    const w = (i === 0 || i === N ? 0.5 : 1) * (L / N);
    force += w * p * (1 + sgn * r.mu * t);
    torque += w * R * sgn * r.mu * p * Math.sqrt(1 + t * t);
  }
  const phiN = Math.asin(-xN / R);
  const slip = ((hf + 2 * R * (1 - Math.cos(phiN))) * Math.cos(phiN)) / hf - 1;
  near(s.xNeutral, xN, 1e-4, `constant k, ${tag}: neutral point`);
  near(s.force, force, 1e-4, `constant k, ${tag}: roll force`);
  near(s.torque, torque, 1e-4, `constant k, ${tag}: roll torque`);
  near(s.forwardSlip, slip, 1e-4, `constant k, ${tag}: forward slip`);
}

// ── 3. Bland & Ford (1948): with small angles (h = hf + Rφ²) and 2 tan φ (p − 2k) neglected,
//       p = 2k (h/hf) e^{μH} after the neutral point and 2k (h/h0) e^{μ(H0 − H)} before it,
//       H = 2√(R/hf) atan(√(R/hf) φ); neutral angle φn = √(hf/R) tan(Hn √(hf/R)/2),
//       Hn = H0/2 − ln(h0/hf)/(2μ). The neglected term grows with the bite angle.
function blandFord(r) {
  const { gap: hf, biteAngle: al } = biteGeometry(r);
  const R = r.rollRadius;
  const q = Math.sqrt(R / hf);
  const H = (f) => 2 * q * Math.atan(q * f);
  const H0 = H(al);
  const phiN = Math.tan((H0 / 2 - Math.log(r.h0 / hf) / (2 * r.mu)) / (2 * q)) / q;
  const N = 20000;
  let force = 0;
  for (let i = 0; i <= N; i++) {
    const f = (al * i) / N;
    const h = hf + R * f * f;
    const p = f < phiN ? twoK * (h / hf) * Math.exp(r.mu * H(f)) : twoK * (h / r.h0) * Math.exp(r.mu * (H0 - H(f)));
    force += (i === 0 || i === N ? 0.5 : 1) * p * R * (al / N);
  }
  return { force, xN: -R * Math.sin(phiN) };
}
for (const [r, tolP, tolN] of [
  [with_({ reduction: 0.1 }), 0.005, 0.04],
  [std, 0.015, 0.08],
]) {
  const s = karman(r, rigid);
  const bf = blandFord(r);
  near(s.force, bf.force, tolP, `Bland-Ford roll force, r = ${r.reduction * 100} %, μ = ${r.mu}`);
  near(s.xNeutral, bf.xN, tolN, `Bland-Ford neutral point, r = ${r.reduction * 100} %, μ = ${r.mu}`);
}

// ── 3b. the returned pressure and friction: p is the lower branch, τ = μp pointing to the neutral
//       point, and they integrate to the roll force
for (const r of [std, with_({ mu: 0.15, backTension: 60e6, frontTension: 120e6 })]) {
  const s = karman(r, P.material);
  const R = r.rollRadius;
  let eP = 0;
  let eT = 0;
  let F = 0;
  for (let i = 0; i < s.x.length; i++) {
    eP = Math.max(eP, Math.abs(s.p[i] - Math.min(s.pEntry[i], s.pExit[i])) / s.twoK[i]);
    const sgn = s.x[i] < s.xNeutral ? 1 : -1;
    eT = Math.max(eT, Math.abs(s.tau[i] - sgn * r.mu * s.p[i]) / s.twoK[i]);
    if (i > 0) {
      const t = (x) => -x / Math.sqrt(R * R - x * x);
      const fa = s.p[i - 1] + s.tau[i - 1] * t(s.x[i - 1]);
      const fb = s.p[i] + s.tau[i] * t(s.x[i]);
      F += 0.5 * (s.x[i] - s.x[i - 1]) * (fa + fb);
    }
  }
  const tag = `μ ${r.mu}, tensions ${r.backTension * 1e-6}/${r.frontTension * 1e-6} MPa`;
  ok(eP < 1e-12, `${tag}: p = min(entry branch, exit branch)`, `max ${eP.toExponential(2)}`);
  ok(eT < 1e-12, `${tag}: τ = +μp before the neutral point, −μp after`, `max ${eT.toExponential(2)}`);
  near(F, s.force, 1e-3, `${tag}: ∫ (p + τ tan φ) dx over the returned arrays = roll force`);
}

// ── 3c. the model's own limits are flagged
{
  const m = P.material;
  ok(!karman(std, m).sticking && !karman(std, m).tensionAtYield, 'standard condition: no sticking, tensions below yield');
  ok(karman(with_({ mu: 0.6 }), rigid).sticking, 'μ = 0.6: μp > k somewhere → sticking flagged');
  ok(karman(with_({ frontTension: 600e6 }), m).tensionAtYield, 'front tension 600 MPa ≥ 2k at the exit → flagged');
}

// ── 4. light pass, little friction: p ≈ 2k all along the bite
{
  const s = karman(with_({ reduction: 0.01, mu: 0.02 }), rigid);
  between(s.pMean / twoK, 1, 1.03, 'r = 1 %, μ = 0.02: mean pressure / 2k');
}

// ── 5. directions: friction raises the load; front tension lowers it and moves the neutral
//       point towards the entry, back tension moves it towards the exit
{
  const m = P.material;
  const a = karman(with_({ mu: 0.05 }), m);
  const b = karman(std, m);
  const c = karman(with_({ mu: 0.12 }), m);
  ok(a.force < b.force && b.force < c.force, 'more friction, more load', `${[a, b, c].map((s) => (s.force * 1e-6).toFixed(3)).join(' < ')} kN/mm`);
  const f = karman(with_({ frontTension: 100e6 }), m);
  const k = karman(with_({ backTension: 100e6 }), m);
  ok(f.force < b.force && k.force < b.force, 'tension lowers the load', `none ${(b.force * 1e-6).toFixed(3)}, front ${(f.force * 1e-6).toFixed(3)}, back ${(k.force * 1e-6).toFixed(3)} kN/mm`);
  ok(f.xNeutral < b.xNeutral && b.xNeutral < k.xNeutral, 'front tension moves the neutral point to the entry, back tension to the exit',
    `xn ${(f.xNeutral * 1e3).toFixed(3)} < ${(b.xNeutral * 1e3).toFixed(3)} < ${(k.xNeutral * 1e3).toFixed(3)} mm`);
  ok(b.forwardSlip > 0 && f.forwardSlip > b.forwardSlip, 'forward slip is positive and grows with front tension',
    `${(b.forwardSlip * 100).toFixed(2)} % → ${(f.forwardSlip * 100).toFixed(2)} %`);
  // standard condition (SPCC, rate factor): docs/validation.md compares this with the MPM
  ok(b.crossed, 'standard condition: the branches cross (the strip is drawn in)');
  between(b.force * 1e-6, 2.5, 3.5, 'standard condition roll force [kN/mm] (hand estimate ≈ 2.9, the slab method 3.03)');
}

// ── 6. a strain brought in (a tandem's later stand): the flow stress along the bite at ep0 + (2/√3) ln(h0/h).
//       For the Swift law σ = K(ε0 + εp)ⁿ that is the same as a material whose ε0 is larger by ep0
{
  const m = P.material;
  const ep0 = 0.33;
  const b = karman(std, m);
  ok(karman(std, m, undefined, 0).force === b.force, 'ep0 = 0: the same result as without it, bit for bit');
  ok(karman(std, rigid, undefined, ep0).force === karman(std, rigid).force, 'no hardening: a strain brought in changes nothing');
  if (m.hardening === 'swift') {
    const pre = karman(std, m, undefined, ep0);
    const shifted = karman(std, { ...m, swE0: m.swE0 + ep0 }, undefined, 0);
    near(pre.force, shifted.force, 1e-12, `Swift: ep0 = ${ep0} equals ε0 + ${ep0} in the law (force ${(pre.force * 1e-6).toFixed(3)} kN/mm)`);
    ok(pre.force > b.force && pre.twoKMean > b.twoKMean, 'a hardened strip takes more load', `${(b.force * 1e-6).toFixed(3)} → ${(pre.force * 1e-6).toFixed(3)} kN/mm`);
  } else ok(false, 'the default material follows the Swift law (this section assumes it)', m.hardening);
}
done();
