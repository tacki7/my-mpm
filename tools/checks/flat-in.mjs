// A tandem's later stands taking the strip as the stand before's flatness leaves it (SolidSettings.flatIn,
// tandem3.ts entryWaveOf / remap3, docs/model.md「タンデム」「入側の平坦度」): the waves the steady flatness makes
// (flatShape.ts) become the next strip's shape, the elongation in the waves comes off the fibres' stress, and the
// stand is solved through the whole thickness (the waves bend the strip out of its mid-thickness plane).
// - the fibres' steepness across the width (steepnessAt) between the shape's samples, the edges' beyond; the
//   elongation a wave holds (releasedStrain, eq. 4.46) is (π/2)² λ²
// - remap3 from a quarter to a whole strip (fresh sims, W 2 mm, 4 cells): the rows below the plane are the quarter's
//   mirror image (y, the stresses; the shear stresses across the plane change sign), the strip has twice the
//   quarter's mass at the same length, and a whole strip made from a whole strip is the same
// - with a wave (a synthetic wavy edge, λ 2 % at the edges, 0 in the middle, pitch = the width): the points are
//   lifted by δ(ζ)/2 sin(2π x/p) from the tail (the edge's crest δ/2, the middle flat, both edges together, the
//   lift at the bottom as at the top: a bend), the longitudinal stress falls by E (π/2)² λ² relative to the mean over
//   the width (two thirds deviatoric, a third off the pressure; the mean over the width stays), the grid reaches
//   above the crest, the head starts back by the crest times R / Lc, and a wave without the whole thickness throws
// - entryWaveOf: no wave without flatIn, or with a flat strip (a uniform flatness too: the fit's rounding is under
//   the 1e-5 steepness that counts); the band ignored, a strip with any difference of elongation buckles, with the
//   amplitude λ p / 2
// - a two-stand tandem (W 2 mm, crown 40 µm, handoff steady, the band ignored, about 2.5 minutes on M2): stand 2's
//   strip comes in wavy from stand 1's flatness, solved through the whole thickness, and rolls to the end
// Calibration (2026-10-01, copies of the tree, the tandem section cut): with the shear stresses not flipped the
// mirror item fails; with the stress relaxation removed 2 stress items fail; with the crest not added to the head's
// start the head item fails; with the doubled mass forgotten the mass item fails (the first run found it).
// @check 480s
import { ok, near, between, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3, entryWaveOf, remap3 } from '../../src/mpm/solid/tandem3.ts';
import { flatShape, releasedStrain, steepnessAt, waveHeight } from '../../src/mpm/solid/flatShape.ts';

const base = (edit = () => {}) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 8e-3;
  edit(P);
  return P;
};

/** a synthetic shape: the fibres' steepness λ(ζ) given, the rest as flatShape fills it */
function synthetic(lambdaOf, kind = 'edge') {
  const zeta = [];
  const lambda = [];
  for (let i = -40; i <= 40; i++) {
    zeta.push(i / 40);
    lambda.push(lambdaOf(Math.abs(i / 40)));
  }
  return { l2: 0, l4: 0, edge: 0, quarter: 0, pattern: kind, drive: 0, band: 0, bh: 0, a: 0, kind, steepness: Math.max(...lambda), at: 1, zeta, lambda };
}

// ── the pure parts
{
  const s = synthetic((z) => 0.02 * z);
  near(steepnessAt(s, 0.5), 0.01, 1e-12, 'steepnessAt: on a sample');
  near(steepnessAt(s, 0.5125), 0.01025, 1e-9, 'steepnessAt: linear between samples');
  near(steepnessAt(s, -0.5125), 0.01025, 1e-9, 'steepnessAt: the other half the same');
  near(steepnessAt(s, 1.7), 0.02, 1e-12, 'steepnessAt: the edge beyond the last sample');
  near(steepnessAt(s, -3), 0.02, 1e-12, 'steepnessAt: the other edge beyond the first');
  near(releasedStrain(0.02), (Math.PI * Math.PI * 4e-4) / 4, 1e-12, 'releasedStrain: (π/2)² λ²');
  ok(releasedStrain(0) === 0, 'releasedStrain: nothing at λ = 0');
}

// ── remap3 from a quarter to the whole thickness, with and without a wave (fresh sims)
const W = 2e-3;
const Pq = solidParams(base(), { width: W });
const Pflat = solidParams(base(), { width: W, flatIn: { pitch: 1 } });
const q = new Sim3(Pq);
// synthetic stresses on the quarter: a shear odd in y (as a bend's is) and a normal stress even
for (let p = 0; p < q.n; p++) {
  q.sxy[p] = 1e6 * (q.py[p] / q.params.rolling.h0);
  q.syz[p] = 2e6 * (q.py[p] / q.params.rolling.h0);
  q.sxx[p] = 3e6;
  q.pres[p] = 1e6;
}
const stats = (s) => {
  let m = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < s.n; p++) {
    m += s.mass[p];
    lo = Math.min(lo, s.py[p]);
    hi = Math.max(hi, s.py[p]);
  }
  return { m, lo, hi };
};
{
  const f = remap3(q, Pflat, q.params.rolling.h0, W);
  ok(f.fullThickness && !q.fullThickness, 'flatIn: the next strip is solved through the whole thickness', `${q.fullThickness} → ${f.fullThickness}`);
  ok(f.NJ === 2 * q.NJ && f.NK === q.NK && f.n === 2 * q.n, 'twice the lattice rows', `${q.NI} × ${q.NJ} × ${q.NK} → ${f.NI} × ${f.NJ} × ${f.NK}`);
  const sq = stats(q);
  const sf = stats(f);
  near(sf.m, 2 * sq.m, 1e-9, 'the whole strip has twice the quarter\'s mass');
  near(f.params.rolling.sheetLength, q.params.rolling.sheetLength, 1e-9, 'and the same length');
  near(sf.hi, sq.hi, 1e-9, 'the top row where the quarter\'s is');
  near(sf.lo, -sq.hi, 1e-9, 'the bottom row its mirror image');
  // every point below the plane has a mirror image above with the same |y|, the same z, the same x, the mirrored stresses
  const key = (x, y, z) => `${x.toFixed(9)},${Math.abs(y).toFixed(9)},${z.toFixed(9)}`;
  const above = new Map();
  for (let p = 0; p < f.n; p++) if (f.py[p] > 0) above.set(key(f.px[p], f.py[p], f.pz[p]), p);
  let paired = 0;
  let worst = 0;
  for (let p = 0; p < f.n; p++) {
    if (f.py[p] >= 0) continue;
    const u = above.get(key(f.px[p], f.py[p], f.pz[p]));
    if (u === undefined) continue;
    paired++;
    worst = Math.max(worst, Math.abs(f.sxy[p] + f.sxy[u]), Math.abs(f.syz[p] + f.syz[u]), Math.abs(f.sxx[p] - f.sxx[u]), Math.abs(f.pres[p] - f.pres[u]));
  }
  ok(paired === f.n / 2, 'every point below the plane is the mirror image of one above', `${paired} of ${f.n / 2}`);
  ok(worst < 1e-6, 'the mirrored point\'s shear stresses across the plane change sign, its normal stresses and pressure are the same', `worst ${worst.toExponential(2)} Pa`);
  let odd = 0;
  for (let p = 0; p < f.n; p++) if (Math.sign(f.sxy[p]) !== Math.sign(f.py[p]) && f.sxy[p] !== 0) odd++;
  ok(odd === 0, 'the shear stress keeps its sign with y (odd in y, as the quarter\'s)', `${odd} points against`);
  // a whole strip made from a whole strip is the same lattice
  const full = new Sim3(solidParams(base(), { width: W, fullThickness: true }));
  const g = remap3(full, Pflat, full.params.rolling.h0, W);
  let dy = 0;
  for (let p = 0; p < g.n; p++) dy = Math.max(dy, Math.abs(g.py[p] - f.py[p]), Math.abs(g.pz[p] - f.pz[p]), Math.abs(g.px[p] - f.px[p]));
  ok(g.n === f.n && dy < 1e-12, 'the whole strip from the whole strip has the same points', `${g.n} / ${f.n}, worst ${dy.toExponential(2)} m`);
  ok(f.params.solid.entryWave === undefined, 'no wave: the setting is not carried');
}

// ── with a wave
{
  const shape = synthetic((z) => 0.02 * Math.max(0, (z - 0.5) / 0.5));
  const pitch = W;
  const wave = { shape, pitch, halfWidth: W / 2, amplitude: (0.02 * pitch) / 2 };
  const f0 = remap3(q, Pflat, q.params.rolling.h0, W);
  const f = remap3(q, Pflat, q.params.rolling.h0, W, null, {}, null, wave);
  ok(f.params.solid.entryWave === wave, 'the wave is carried in the settings');
  const h0 = f.params.rolling.h0;
  const E = f.youngs;
  const xTail = f.xHead0 - f.params.rolling.sheetLength;
  near(f.xHead0, f0.xHead0 - (wave.amplitude * f.roll.R) / f.contactLength, 1e-9, 'the head starts back by the crest times R / Lc');
  ok(f.yMax >= h0 / 2 + wave.amplitude, 'the grid reaches above the crest', `yMax ${(f.yMax * 1e3).toFixed(4)} mm ≥ ${((h0 / 2 + wave.amplitude) * 1e3).toFixed(4)} mm`);
  // each point against the strip without the wave: the lift is the wave's height at (x from the tail, ζ)
  let worstLift = 0;
  let crest = 0;
  let middle = 0;
  let bottomVsTop = 0;
  const lifts = new Map();
  for (let p = 0; p < f.n; p++) {
    const lift = f.py[p] - f0.py[p];
    const zeta = f.pz[p] / wave.halfWidth;
    worstLift = Math.max(worstLift, Math.abs(lift - waveHeight(shape, f.px[p] - xTail, zeta, pitch)));
    crest = Math.max(crest, lift);
    if (zeta < 0.5) middle = Math.max(middle, Math.abs(lift));
    const k = `${f.px[p].toFixed(9)},${f.pz[p].toFixed(9)}`;
    if (lifts.has(k)) bottomVsTop = Math.max(bottomVsTop, Math.abs(lifts.get(k) - lift));
    else lifts.set(k, lift);
  }
  ok(worstLift < 1e-12, 'every point is lifted by the wave\'s height at its (x, ζ)', `worst ${worstLift.toExponential(2)} m`);
  // the outermost column sits inside the edge (ζ = 1 − 0.5 / NK) and the columns along x straddle the crest
  between(crest, 0.8 * wave.amplitude, wave.amplitude, `the edge's crest is near δ/2 = λ p / 2 (${(wave.amplitude * 1e6).toFixed(1)} µm)`);
  ok(middle === 0, 'the middle of a wavy edge stays flat');
  ok(bottomVsTop < 1e-12, 'a column\'s points are lifted alike top to bottom (a bend, not a strain)', `worst ${bottomVsTop.toExponential(2)} m`);
  ok(f.params.solid.entryWave.amplitude === wave.amplitude, 'the amplitude is the wave\'s');
  // the stresses: the columns' mean of the released strain, and each column's departure from it
  const cols = new Map();
  for (let p = 0; p < f.n; p++) {
    const k = p % f.NK;
    const c = cols.get(k) ?? { sxx: 0, syy: 0, pres: 0, n: 0, zeta: f.pz[p] / wave.halfWidth };
    c.sxx += f.sxx[p] - f0.sxx[p];
    c.syy += f.syy[p] - f0.syy[p];
    c.pres += f.pres[p] - f0.pres[p];
    c.n++;
    cols.set(k, c);
  }
  let relMean = 0;
  for (const c of cols.values()) relMean += releasedStrain(steepnessAt(shape, c.zeta));
  relMean /= cols.size;
  let worstS = 0;
  let meanS = 0;
  for (const c of cols.values()) {
    const ds = E * (releasedStrain(steepnessAt(shape, c.zeta)) - relMean);
    worstS = Math.max(worstS, Math.abs(c.sxx / c.n - (2 / 3) * ds), Math.abs(c.syy / c.n + ds / 3), Math.abs(c.pres / c.n + ds / 3));
    meanS += c.sxx / c.n - c.pres / c.n;
  }
  const edge = [...cols.values()].reduce((a, b) => (b.zeta > a.zeta ? b : a));
  const dsEdge = E * (releasedStrain(steepnessAt(shape, edge.zeta)) - relMean);
  ok(dsEdge > 1e6, 'the edge fibre\'s released stress is of order MPa', `${(dsEdge * 1e-6).toFixed(2)} MPa`);
  ok(worstS < 1e-3 * Math.abs(dsEdge), 'each column\'s longitudinal stress falls by E (π/2)² λ² relative to the mean (2/3 deviatoric, 1/3 off the pressure)', `worst ${worstS.toExponential(2)} Pa`);
  near(edge.sxx / edge.n - edge.pres / edge.n, dsEdge, 1e-6, 'the outermost column\'s total σxx falls by its released stress');
  ok(Math.abs(meanS / cols.size) < 1e-3 * Math.abs(dsEdge), 'the mean total σxx over the width stays', `${(meanS / cols.size).toExponential(2)} Pa`);
  let threw = '';
  try {
    new Sim3({ ...Pq, solid: { ...Pq.solid, entryWave: wave } });
  } catch (e) {
    threw = String(e.message);
  }
  ok(/whole thickness/.test(threw), 'a wave without the whole thickness throws', threw);
}

// ── entryWaveOf
{
  const st = (f) => {
    const exitZ = [];
    const flatness = [];
    for (let i = 0; i < 8; i++) (exitZ.push(((i + 0.5) / 8) * 1e-3), flatness.push(f((i + 0.5) / 8)));
    return { exitZ, flatness, halfWidth: 1e-3, halfThickness: [0.4e-3, 0.4e-3, 0.4e-3, 0.4e-3, 0.4e-3, 0.4e-3, 0.4e-3, 0.4e-3] };
  };
  const r = (steady, P) => ({ steady, widthOut: 2e-3 });
  const wavy = st((z) => 400 * z ** 2);
  ok(entryWaveOf(Pq, r(wavy)) === null, 'no wave without flatIn');
  ok(entryWaveOf(Pflat, { steady: null, widthOut: 2e-3 }) === null, 'no wave without a steady reading');
  ok(entryWaveOf(Pflat, r(wavy)) === null, 'a narrow strip (B/h = 2.5) stays flat within the band: no wave');
  const latent = solidParams(base(), { width: W, flatIn: { pitch: 2, ignoreBand: true } });
  const w = entryWaveOf(latent, r(wavy));
  ok(w && w.shape.kind === 'edge', 'the band ignored: a wavy edge', w?.shape.kind);
  near(w.pitch, 4e-3, 1e-12, 'the pitch is the setting times the width out');
  near(w.halfWidth, 1e-3, 1e-12, 'the half width out');
  const expect = flatShape(wavy.exitZ, wavy.flatness, 1e-3, 0.8e-3, true);
  near(w.amplitude, (Math.max(...expect.lambda) * 4e-3) / 2, 1e-12, 'the amplitude λ p / 2 of the steepest fibre');
  ok(entryWaveOf(latent, r(st(() => 100))) === null, 'a uniform flatness: no wave even with the band ignored');
}

// ── a two-stand tandem: the second stand's strip comes in wavy
{
  const t0 = performance.now();
  const P = solidParams(base((p) => { p.rolling.lengthMode = 'steady'; p.rolling.stands = 2; p.rolling.handoff = 'steady'; }), { width: W, crownIn: 40e-6, flatIn: { pitch: 1, ignoreBand: true } });
  const T = new Tandem3(P, 2, 'steady');
  const geoms = [T.sim];
  T.onStandDone = (e) => { if (e.next) geoms.push(e.next); };
  let steps = 0;
  while (!T.done && steps < 400000) {
    T.advance();
    steps++;
  }
  const secs = (performance.now() - t0) / 1e3;
  ok(T.results.length === 2 && T.stopped === null, 'both stands rolled to the end', `${T.results.map((r) => r.phase).join(' / ')} in ${secs.toFixed(0)} s`);
  const [r1, r2] = T.results;
  ok(!r1.fullThickness && r1.entryWave === null, 'stand 1: the quarter model, a flat entry');
  ok(r2.fullThickness, 'stand 2: the whole thickness');
  ok(r2.entryWave !== null, 'stand 2: the strip came in wavy', r2.entryWave && `${r2.entryWave.shape.kind} height ${(2 * r2.entryWave.amplitude * 1e6).toFixed(2)} µm, pitch ${(r2.entryWave.pitch * 1e3).toFixed(2)} mm`);
  if (r2.entryWave) {
    near(r2.entryWave.pitch, r1.widthOut, 1e-12, 'the pitch is the width out of stand 1');
    const expect = entryWaveOf(P, r1);
    ok(expect && expect.amplitude === r2.entryWave.amplitude && expect.shape.kind === r2.entryWave.shape.kind, 'the wave is what entryWaveOf reads from stand 1\'s result');
    between(2 * r2.entryWave.amplitude, 1e-7, 1e-4, 'the wave\'s height is between 0.1 µm and 100 µm');
  }
  ok(geoms.length === 2 && geoms[1].fullThickness && geoms[1].NJ === 2 * geoms[0].NJ, 'stand 2\'s lattice has twice the rows', geoms.map((g) => `${g.NI} × ${g.NJ} × ${g.NK}`).join(' → '));
  ok(r2.steady !== null && r2.steady.force > 0, 'stand 2 has a steady reading', r2.steady && `${(r2.steady.force * 1e-3).toFixed(3)} kN`);
  between(1 - r2.thicknessOut / r2.h0, 0.2, 0.3, 'stand 2 reduces the strip by about a quarter');
}

done();
