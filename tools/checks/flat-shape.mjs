// 平坦度の形 (src/mpm/solid/flatShape.ts, docs/model.md「平坦度の形」): from a steady flatness by column, whether the
// strip buckles and into which waves, as the reference (a textbook on strip crown and flatness, §4.3) reads it.
// Pure functions, about 0.1 s:
// - the pattern from the 4th-order fit (eq. 4.57, fig. 4.20): 400 ζ⁴ is a wavy edge, −300 ζ² a centre buckle,
//   800 ζ² − 1000 ζ⁴ a quarter buckle (the steepest fibre near ζ = √0.4)
// - Shohet's limits (eq. 4.53) as the band: a wavy edge just under 80 (h/B)² stays flat and just over buckles; a
//   centre buckle's band is 40 (h/B)²
// - the shape coefficient (fig. 4.17): 0 up to B/h = 50, 0.582 √(B/h − 50) to 160, 6 above; a strip with B/h < 50
//   never buckles however large the difference
// - the theory (eqs. 4.46, 4.51): with a = 6.37 = (2/π)·10 and no band, λ = (2/π) √Δε; and a sine wave of steepness
//   λ is longer than its pitch by (π/2)² λ² to 1 % at λ = 3 % (the arc length integrated)
// - the drawn waves: waveHeight is δ/2 sin(2πx/p) with δ = λ p, interpolated on ζ; a flat strip's is 0 everywhere;
//   a wavy edge's middle is flat and a centre buckle's edges are flat
// - the real reading: the 4 mm strip of tools/solid.mjs --W 4 (B/h = 6) stays flat with its 374 I of wavy edge
// Calibrated on copies (2026-09-29): with the band ignored in the judgement the "just under" cases buckle (3 items
// fail); with a = 6 for every B/h the narrow strip and the real 4 mm strip buckle (4 items fail); with Λ₄ ignored in
// the pattern (edge or centre only) the quarter item fails.
// @check
import { ok, near, done } from './lib.mjs';
import { flatShape, shapeCoefficient, steepnessOf, waveHeight } from '../../src/mpm/solid/flatShape.ts';

/** a flatness profile over 40 columns from the mid-width out: f(ζ) in I-units */
function profile(f, halfWidth = 0.1, n = 40) {
  const exitZ = [];
  const flatness = [];
  for (let i = 0; i < n; i++) {
    const z = (i + 0.5) / n;
    exitZ.push(z * halfWidth);
    flatness.push(f(z));
  }
  return { exitZ, flatness };
}
const H = 0.75e-3; // thickness: B/h = 267 with the 0.2 m width
const shape = (f, ignoreBand = false, hw = 0.1, h = H) => {
  const p = profile(f, hw);
  return flatShape(p.exitZ, p.flatness, hw, h, ignoreBand);
};

// the patterns
const edge = shape((z) => 400 * z ** 4);
ok(edge.kind === 'edge' && edge.pattern === 'edge', 'edge: 400 ζ⁴ is a wavy edge', edge.kind);
near(edge.edge, 400e-5, 1e-6, 'edge: Λ₂ = y*(1) from the fit');
near(edge.drive, 400e-5, 1e-6, 'edge: the difference of elongation');
near(edge.band, 80 * (H / 0.2) ** 2, 1e-9, 'edge: the band is 80 (h/B)²');
near(edge.steepness, steepnessOf(400e-5, edge.band, 6), 1e-9, 'edge: λ from eq. 4.52 with a = 6');
ok(edge.at === 1, 'edge: the steepest fibre is the edge', String(edge.at));
const centre = shape((z) => -300 * z ** 2);
ok(centre.kind === 'centre', 'centre: −300 ζ² is a centre buckle', centre.kind);
near(centre.band, 40 * (H / 0.2) ** 2, 1e-9, 'centre: the band is 40 (h/B)²');
ok(centre.at === 0, 'centre: the steepest fibre is the middle', String(centre.at));
const quarter = shape((z) => 800 * z ** 2 - 1000 * z ** 4);
ok(quarter.kind === 'quarter', 'quarter: 800 ζ² − 1000 ζ⁴ is a quarter buckle', quarter.kind);
near(quarter.at, Math.sqrt(0.4), 0.05, 'quarter: the steepest fibre near ζ = √0.4');
ok(quarter.quarter > quarter.edge && quarter.edge < 0, 'quarter: Λ₄ > Λ₂ and the edges are short', `${quarter.quarter} ${quarter.edge}`);

// Shohet's limits as the band
const band = 80 * (H / 0.2) ** 2;
const under = shape((z) => band * 1e5 * 0.98 * z ** 4);
ok(under.kind === 'flat' && under.pattern === 'edge' && under.steepness === 0, 'band: a wavy edge just under 80 (h/B)² stays flat', under.kind);
const over = shape((z) => band * 1e5 * 1.02 * z ** 4);
ok(over.kind === 'edge' && over.steepness > 0, 'band: just over 80 (h/B)² buckles', over.kind);
const centreUnder = shape((z) => -0.5 * band * 1e5 * 0.98 * z ** 2);
ok(centreUnder.kind === 'flat', 'band: a centre buckle just under 40 (h/B)² stays flat', centreUnder.kind);
const centreOver = shape((z) => -0.5 * band * 1e5 * 1.02 * z ** 2);
ok(centreOver.kind === 'centre', 'band: just over 40 (h/B)² buckles', centreOver.kind);

// the shape coefficient
ok(shapeCoefficient(50) === 0 && shapeCoefficient(6) === 0, 'a: 0 up to B/h = 50');
near(shapeCoefficient(100), 0.582 * Math.sqrt(50), 1e-12, 'a: 0.582 √(B/h − 50) below 160');
ok(shapeCoefficient(160) === 6 && shapeCoefficient(1000) === 6, 'a: 6 from B/h = 160');
// a narrow strip: 4 mm wide, 0.75 mm thick (B/h = 5.3), 400 I of wavy edge
const narrow = shape((z) => 400 * z ** 4, false, 2e-3);
ok(narrow.kind === 'flat' && narrow.a === 0 && narrow.steepness === 0, 'narrow: B/h < 50 never buckles', `${narrow.kind} a ${narrow.a}`);
const wide = shape((z) => 400 * z ** 4, false, 2e-3, 2e-5); // B/h = 200 with the same difference: waves
ok(wide.kind === 'edge', 'narrow: the same difference at B/h = 200 buckles', wide.kind);

// the theory
near(steepnessOf(1e-2, 0, 6.37), (2 / Math.PI) * Math.sqrt(1e-2), 2e-3, 'theory: a = 6.37 and no band is λ = (2/π) √Δε');
const latent = shape((z) => 400 * z ** 4, true);
near(latent.steepness, (2 / Math.PI) * Math.sqrt(400e-5), 1e-9, 'theory: the band ignored draws λ = (2/π) √Δε');
ok(latent.kind === 'edge', 'theory: the band ignored buckles whatever the difference', latent.kind);
// a sine wave of steepness λ: its length over the pitch is 1 + (π/2)² λ² to second order
for (const lam of [0.01, 0.03]) {
  const pitch = 1;
  const n = 20000;
  let len = 0;
  let prev = ((lam * pitch) / 2) * Math.sin(0);
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * pitch;
    const y = ((lam * pitch) / 2) * Math.sin((2 * Math.PI * x) / pitch);
    len += Math.hypot(pitch / n, y - prev);
    prev = y;
  }
  near(len / pitch - 1, (Math.PI / 2) ** 2 * lam ** 2, 0.01, `theory: a wave of λ = ${lam * 100} % is longer by (π/2)² λ²`);
}

// the drawn waves
const flat = shape((z) => 100 * z ** 4); // 100 I < the band
ok(flat.kind === 'flat', 'waves: 100 I stays flat', flat.kind);
ok([-1, -0.5, 0, 0.5, 1].every((zeta) => waveHeight(flat, 0.25, zeta, 1) === 0), 'waves: a flat strip has no height');
near(waveHeight(edge, 0.5, 1, 2), (edge.steepness * 2) / 2, 1e-9, 'waves: the edge at a quarter pitch rises δ/2 = λ p / 2');
near(waveHeight(edge, 0.5, -1, 2), waveHeight(edge, 0.5, 1, 2), 1e-12, 'waves: both edges in step');
ok(waveHeight(edge, 0.5, 0, 2) === 0 && waveHeight(edge, 0.5, 0.3, 2) === 0, 'waves: a wavy edge is flat in the middle');
ok(waveHeight(centre, 0.5, 1, 2) === 0 && waveHeight(centre, 0.5, 0, 2) > 0, 'waves: a centre buckle is flat at the edges');
ok(Math.abs(waveHeight(edge, 1, 1, 2)) < 1e-12 && waveHeight(edge, 1.5, 1, 2) < 0, 'waves: a sine along the length (0 at a half pitch, down at three quarters)');

// the real reading (tools/solid.mjs --W 4 --L 12 --cells 4, 2026-09-29: flatness by column at the exit, I-units)
const real = flatShape(
  [0.000254, 0.000762, 0.00127, 0.001778, 0.002248],
  [-152, -140, -60, 100, 252],
  0.002248,
  0.7446e-3,
);
ok(real.kind === 'flat' && real.pattern === 'edge' && real.a === 0, 'real: the 4 mm strip (B/h = 6) stays flat with its wavy-edge profile', `${real.kind} B/h ${real.bh.toFixed(1)}`);

// degenerate input
ok(flatShape([0, 1], [0, 1], 1, 1) === null, 'null: fewer than 3 columns');
ok(flatShape([0, 0.5, 1], [0, 1, 2], 1, 0) === null, 'null: no thickness');

done();
