// Bland & Ford's closed-form bite (src/mpm/slab.ts, `blandFord()`) against arithmetic done by
// hand from the source's formulas, and the forward slip of the numerically integrated
// `karman()` against it. Source: 柳本 潤「圧延理論－1（圧延概論・Karman の理論）」東京大学生産技術
// 研究所, §5 (eqs. 29-1, 29-2) and §6. About 0.5 s.
//
// The ±5 % band on karman/blandFord: measured on the standard condition (h0 1 mm, 25 %, R 100 mm,
// SPCC) with the default material, karman comes out at −1.0 % (μ 0.08), +2.0 % (0.05), −2.2 %
// (0.12), −2.9 % (0.20) of the closed form, and the neutral point within 1.3 %. The two differ
// because karman drops none of the terms (the closed form neglects 2 tan φ (p − 2k), which grows
// with the bite angle, and takes 2k constant while karman integrates the hardening); with a
// constant flow stress the gap is +11.7 %, so the band belongs to the hardening case only.
// The comparison against the MPM and the pressure distributions are in docs/validation.md.
// @check
import { ok, near, between, done } from './lib.mjs';
import { karman, blandFord } from '../../src/mpm/slab.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const P = defaultParams();
const std = P.rolling;
const with_ = (o) => ({ ...std, ...o });
const m = P.material;

// ── 1. the closed form against hand arithmetic ───────────────────────────────
// Worked out from the source's formulas outside this code, with h2 = 1 mm, h1 = 0.75 mm,
// R = 100 mm: √(R/h1) = 11.5470054, √((h2 − h1)/h1) = 0.5773503, atan of it = 0.5235988 (30°),
// so H2/2 = 11.5470054 × 0.5235988 = 6.0459979 and ln(h2/h1) = 0.2876821. Then
// Hn = 6.0459979 − 0.2876821/(2μ), f = tan²(Hn/(2 × 11.5470054)), φn = tan(…)/11.5470054 and
// xn = −100 sin φn mm:
//   μ = 0.05: Hn = 3.169177, f = 0.0190709, xn = −1.19593 mm
//   μ = 0.08: Hn = 4.247985, f = 0.0346132, xn = −1.61114 mm
//   μ = 0.12: Hn = 4.847323, f = 0.0453830, xn = −1.84481 mm
//   μ = 0.20: Hn = 5.326793, f = 0.0551481, xn = −2.03360 mm
for (const [mu, Hn, f, xn] of [
  [0.05, 3.169177, 0.0190709, -1.19593e-3],
  [0.08, 4.247985, 0.0346132, -1.61114e-3],
  [0.12, 4.847323, 0.045383, -1.84481e-3],
  [0.2, 5.326793, 0.0551481, -2.0336e-3],
]) {
  const b = blandFord(with_({ mu }), m);
  near(b.HNeutral, Hn, 1e-5, `hand arithmetic, μ = ${mu}: Hn`);
  near(b.forwardSlip, f, 1e-4, `hand arithmetic, μ = ${mu}: forward slip`);
  near(b.xNeutral, xn, 1e-4, `hand arithmetic, μ = ${mu}: neutral point`);
  ok(b.crossed, `hand arithmetic, μ = ${mu}: the branches cross inside the bite`);
}

// ── 2. the two branches of eqs. 29-1 and 29-2 ────────────────────────────────
{
  const b = blandFord(std, m);
  // they must be equal where Hn puts the neutral point (that is what eq. 3-2 solves for)
  const i = b.x.findIndex((x) => x >= b.xNeutral);
  near(b.pEntry[i], b.pExit[i], 2e-3, 'the entry and exit branches meet at the neutral point');
  // at the ends each branch is 2k (no tension): p(entry) = 2k, p(exit) = 2k
  near(b.pEntry[0], b.twoK, 1e-3, 'the entry branch starts at 2k');
  near(b.pExit[b.x.length - 1], b.twoK, 1e-12, 'the exit branch ends at 2k');
  ok(b.p[i - 1] === b.pEntry[i - 1] && b.p[i + 1] === b.pExit[i + 1], 'p is the entry branch before the neutral point and the exit branch after it');
  between(b.pMean / b.twoK, 1.1, 1.3, 'the friction hill lifts the mean pressure above 2k (Qp)');
}

// ── 3. karman() against the closed form: forward slip, neutral point, load ───
for (const mu of [0.05, 0.08, 0.12, 0.2]) {
  const r = with_({ mu });
  const k = karman(r, m);
  const b = blandFord(r, m);
  near(k.forwardSlip, b.forwardSlip, 0.05, `karman vs Bland-Ford, μ = ${mu}: forward slip`);
  near(k.xNeutral, b.xNeutral, 0.05, `karman vs Bland-Ford, μ = ${mu}: neutral point`);
  near(k.force, b.force, 0.05, `karman vs Bland-Ford, μ = ${mu}: roll force`);
}

// ── 4. no neutral point: too little friction to draw the strip in ────────────
{
  const b = blandFord(with_({ mu: 0.02 }), m);
  ok(!b.crossed && b.HNeutral < 0, 'μ = 0.02: Hn falls below 0, no neutral point', `Hn ${b.HNeutral.toFixed(3)}`);
  ok(b.forwardSlip === 0 && b.xNeutral === 0, 'it is clamped to the exit, not reported as a slip');
  const zero = blandFord(with_({ mu: 0 }), m);
  ok(!zero.crossed && zero.forwardSlip === 0, 'μ = 0: no friction, no neutral point');
}

// ── 5. tensions: direction, and which 2k they are read against ───────────────
{
  const base = blandFord(std, m);
  const front = blandFord(with_({ frontTension: 100e6 }), m);
  const back = blandFord(with_({ backTension: 100e6 }), m);
  const kBase = karman(std, m);
  ok(front.forwardSlip > base.forwardSlip && front.xNeutral < base.xNeutral, 'a front tension raises the forward slip and moves the neutral point towards the entry');
  ok(back.forwardSlip < base.forwardSlip && back.xNeutral > base.xNeutral, 'a back tension lowers the forward slip and moves the neutral point towards the exit');
  ok(karman(with_({ frontTension: 100e6 }), m).forwardSlip > kBase.forwardSlip, 'karman moves the same way under a front tension');
  ok(karman(with_({ backTension: 100e6 }), m).forwardSlip < kBase.forwardSlip, 'karman moves the same way under a back tension');
  // 2k2 at the entry (εp = 0) is about half the mean on a hardening strip, so 'ends' and 'mean'
  // are far apart under a back tension; with no tension they are the same number bit for bit
  ok(blandFord(std, m, 2000, 0, 'mean').forwardSlip === base.forwardSlip, 'tensionAt does not matter without tensions');
  const mean = blandFord(with_({ backTension: 100e6 }), m, 2000, 0, 'mean');
  ok(mean.forwardSlip > 4 * back.forwardSlip, "a back tension read against 2k2 alone kills the slip; 'mean' does not", `${back.forwardSlip.toFixed(5)} vs ${mean.forwardSlip.toFixed(5)}`);
  between(base.twoKEntry / base.twoK, 0.4, 0.6, '2k2 (entry, εp = 0) is about half the mean 2k for SPCC');
}
done();
