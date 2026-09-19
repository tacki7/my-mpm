// The plan-view model (src/mpm/planview/sim.ts) on a coarse 10 mm wide strip: the thickness
// rules (plane stress off the rolls, the gap in contact), the mid-width symmetry plane
// (v_z = 0, v_x free), the width effects that make edge cracks (spread; in the bite the edge
// is pulled in tension by the middle), the roll force against the slab method, and an edge
// that fails when the material is brittle and not when it is ductile, and the volume averaging against the
// pressure scatter of point-by-point volumes. docs/validation.md has the finer and wider runs.
// @check
import { ok, near, between, done } from './lib.mjs';
import { PlanSim, planParams } from '../../src/mpm/planview/sim.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { karman } from '../../src/mpm/slab.ts';

const W = 10e-3;
function condition(mod = () => {}) {
  const base = defaultParams();
  base.rolling.sheetLength = 8e-3;
  base.damage.model = 'none';
  mod(base);
  return planParams(base, W, 10);
}

// plane stress off the rolls, looked at after every step of every run below: the worst |σ_yy| of
// the points not in contact (the solve closes it to 1 kPa; an 8-step secant left 12 MPa just past
// the exit)
const ps = { worst: 0, looks: 0, where: '' };
function advance(s) {
  s.advance();
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p] || s.failed[p] || s.pc[p] > 0) continue;
    const syy = Math.abs(s.syy[p] - s.pres[p]);
    ps.looks++;
    if (syy > ps.worst) (ps.worst = syy), (ps.where = `step ${s.step}, x ${(s.px[p] * 1e3).toFixed(2)} mm`);
  }
}

// friction on the grid, looked at after a step: nodes with a Coulomb capacity, those sliding at it
// (gfx, gfz: the node's friction over its capacity) or sticking, the violations, and whether the
// points' friction adds up to the nodes'
const fr = { nodes: 0, sliding: 0, sticking: 0, over: 0, reversed: 0, offRoll: 0, sumWorst: 0 };
function frictionLooks(s) {
  const kSym = Math.round(-s.oz / s.h);
  const vR = s.params.rolling.rollSpeed;
  for (let i = 0; i < s.nxN; i++) {
    for (let k = kSym; k < s.nzN; k++) {
      const idx = i * s.nzN + k;
      if (!(s.gcap[idx] > 0) || s.gm[idx] <= 1e-12 * s.mass[0]) continue;
      fr.nodes++;
      const f = Math.hypot(s.gfx[idx], s.gfz[idx]);
      const sx = vR - s.gvx[idx];
      const sz = -s.gvz[idx];
      if (f > 1 + 1e-9) fr.over++;
      if (f >= 1 - 1e-9) fr.sliding++;
      else if (Math.hypot(sx, sz) > 1e-9 * vR) fr.offRoll++; // under the capacity but not at the roll speed
      else fr.sticking++;
      if (sx * s.gfx[idx] + sz * s.gfz[idx] < -1e-12 * vR) fr.reversed++; // pushed past the roll speed
    }
  }
  let fp = 0;
  for (let p = 0; p < s.n; p++) if (s.active[p]) fp += s.fricX[p];
  fr.sumWorst = Math.max(fr.sumWorst, Math.abs(fp - s.frictionNow) / Math.abs(s.frictionNow));
}

// ── one run into the steady phase (a 12 mm strip, so the bite is well into it), then a look
//    averaged over a few hundred steps
const sim = new PlanSim(condition((b) => (b.rolling.sheetLength = 12e-3)));
while ((sim.phase() !== 'steady' || sim.headX() < sim.xExitProbe + 2e-3) && sim.step < 20000) advance(sim);
sim.readForce();
const nb = 5;
const bite = Array.from({ length: nb }, () => [0, 0]);
const edge = [0, 0];
const cols = [0, 1, 2, 3].map(() => [0, 0]); // σxx of the four lattice columns next to the mid-width plane
const prevContact = Uint8Array.from(sim.pc, (v) => (v > 0 ? 1 : 0));
const switches = new Uint16Array(sim.n);
let gapWorst = 0;
let gapCount = 0;
let symVz = 0;
let symVx = 0;
let symNodes = 0;
let force = 0;
let forceSamples = 0;
for (let s = 0; s < 600; s++) {
  advance(sim);
  for (let p = 0; p < sim.n; p++) {
    const c = sim.pc[p] > 0 ? 1 : 0;
    if (c !== prevContact[p]) (switches[p]++, (prevContact[p] = c));
  }
  if (s % 50) continue;
  force += sim.readForce();
  forceSamples++;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p] || sim.failed[p]) continue;
    if (sim.pc[p] > 0) {
      gapWorst = Math.max(gapWorst, Math.abs(sim.thick[p] - sim.gapAt(sim.px[p])) / sim.gap);
      gapCount++;
    }
    const x = sim.px[p];
    // the middle of the bite (from 0.8 to 0.2 of the contact length before the exit)
    if (x > -0.8 * sim.contactLength && x < -0.2 * sim.contactLength) {
      const b = Math.min(nb - 1, Math.floor((sim.pz[p] / (W / 2)) * nb));
      bite[b][0] += sim.sxx[p] - sim.pres[p];
      bite[b][1]++;
      // the outermost millimetre of the width
      if (sim.pz[p] > W / 2 - 1e-3) (edge[0] += sim.sxx[p] - sim.pres[p]), edge[1]++;
      if (sim.lk[p] < 4) (cols[sim.lk[p]][0] += sim.sxx[p] - sim.pres[p]), cols[sim.lk[p]][1]++;
    }
  }
  // grid nodes on the mid-width plane z = 0 that carry material (the ghosts below it carry the mirror image)
  const kSym = Math.round(-sim.oz / sim.h);
  for (let i = 0; i < sim.nxN; i++) {
    const idx = i * sim.nzN + kSym;
    if (sim.gm[idx] <= 0) continue;
    symNodes++;
    symVz = Math.max(symVz, Math.abs(sim.gvz[idx]));
    symVx = Math.max(symVx, Math.abs(sim.gvx[idx]));
  }
  frictionLooks(sim);
}
ok(gapCount > 0 && gapWorst < 1e-9, 'in contact: the thickness is the roll gap', `max |h − gap|/gap ${gapWorst.toExponential(2)} over ${gapCount} looks`);
ok(symNodes > 0 && symVz === 0 && symVx > 0.5 * sim.params.rolling.rollSpeed, 'mid-width plane z = 0: v_z = 0 and v_x free on its nodes', `${symNodes} node looks, max |v_z| ${symVz}, max |v_x| ${symVx.toFixed(3)} m/s`);

const chattering = [...switches].filter((v) => v >= 3).length;
ok(chattering === 0, 'contact is decided by complementarity: no point flips in and out of contact (≥ 3 times in 600 steps)', `${chattering} points, most flips ${Math.max(...switches)}`);
const colSxx = cols.map(([a, c]) => (a / c) * 1e-6);
const [c0, c1] = colSxx;
ok(Math.abs(c0 - c1) < 50, 'the mid-width plane is a mirror: no zigzag between the two columns next to it', `σxx ${c0.toFixed(0)} / ${c1.toFixed(0)} MPa in the bite`);
// near the middle σxx hardly changes across the width (the full-width model: −274, −268, −263, −246 MPa
// in columns 0–3); a fold that adds the ghosts' z-momentum instead of mirroring it drags the middle
// columns down (−356, −335, −249, −221)
const colSpread = Math.max(...colSxx) - Math.min(...colSxx);
ok(colSpread < 60, 'the mid-width plane is a mirror: σxx of the four columns next to it stays level (within 60 MPa)', `σxx ${colSxx.map((v) => v.toFixed(0)).join(', ')} MPa in the bite, spread ${colSpread.toFixed(0)}`);
const sxx = bite.map(([s, c]) => (c ? (s / c) * 1e-6 : NaN));
const mid = sxx[0];
const edgeSxx = (edge[0] / edge[1]) * 1e-6;
ok(mid < -100 && edgeSxx > 30 && edgeSxx - mid > 200, 'in the bite the middle is in longitudinal compression and the outermost mm in tension', `σxx mid → edge ${sxx.map((v) => v.toFixed(0)).join(', ')}; outermost mm ${edgeSxx.toFixed(0)} MPa`);

const prof = sim.exitProfile(sim.xExitProbe, sim.xExitProbe + 2 * sim.h, 5);
between(prof.halfWidth / sim.halfWidth0 - 1, 0.02, 0.15, 'the width spreads (Wusatowski 6.4 % here)');
near(prof.bins[0].thick, sim.gap, 0.01, 'the middle leaves the rolls at the gap thickness');
// the neutral point sits where friction on both faces and the pressure on the sloping rolls balance
between((prof.bins[0].vx / sim.params.rolling.rollSpeed - 1) * 100, 1, 3.3, 'forward slip in the middle [%] (1.6 on this grid; slab method 3.4, section model 2.6–2.9)');

// friction: the capacity per face is μ p_c but at most the shear flow stress k (what the grid does
// with it is looked at in both runs and checked after the μ 0.3 one)
{
  let p = 0;
  while (!(sim.active[p] && sim.pc[p] > 0)) p++;
  const area = sim.dp * sim.dp * (sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p]);
  const pc = sim.pc[p];
  sim.pc[p] = 1e10; // pressed far beyond μ p_c = k
  const k = sim.shearFlow(p);
  const tau = sim.frictionCapacity(p, area) / (2 * area);
  sim.pc[p] = pc;
  ok(Math.abs(tau - k) <= 1e-9 * k, 'friction per face is capped at the shear flow stress k (sticking)', `τ ${(tau * 1e-6).toFixed(3)} MPa, k ${(k * 1e-6).toFixed(3)} MPa`);
}

// roll force per unit width over the half width against the slab method (the middle is near plane strain)
const slab = karman(sim.params.rolling, sim.params.material);
between(force / forceSamples / sim.halfWidth0 / slab.force, 0.9, 1.05, 'roll force per unit width over the half width / slab method (3.03 kN/mm; the edge carries less)');

// ── friction does not depend on the time step: at μ 0.3 the friction a point can take in one step,
//    2τΔt/(ρ_s h), is more than its slip at mass scaling 1e3 (a per-point friction capped at the
//    impulse m|Δv| lost 14 % of the load here). A 5 mm strip, same grid spacing
{
  const load = (ms) => {
    const s = new PlanSim(planParams((() => {
      const b = defaultParams();
      b.rolling.sheetLength = 12e-3;
      b.rolling.mu = 0.3;
      b.damage.model = 'none';
      b.numerics.massScale = ms;
      return b;
    })(), 5e-3, 5));
    while ((s.phase() !== 'steady' || s.headX() < s.xExitProbe + 2e-3) && s.step < 30000) advance(s);
    s.readForce();
    for (let k = 0; k < 500; k++) {
      advance(s);
      if (k % 50 === 0) frictionLooks(s);
    }
    return s.readForce() / s.halfWidth0;
  };
  const f4 = load(1e4);
  const f3 = load(1e3);
  near(f3 / f4, 1, 0.03, `μ 0.3: roll force per unit width at mass scaling 1e3 / 1e4 (${(f4 * 1e-6).toFixed(2)} kN/mm at 1e4)`);
}
ok(fr.nodes > 0 && fr.sliding > 0 && fr.over === 0 && fr.reversed === 0 && fr.offRoll === 0,
  'friction on the grid (μ 0.08 and 0.3): at most the Coulomb capacity per node, never past the roll speed (sticking: on one node, below)',
  `${fr.nodes} node looks, ${fr.sliding} sliding, ${fr.sticking} sticking; over the capacity ${fr.over}, past the roll speed ${fr.reversed}, under it but slipping ${fr.offRoll}`);
ok(fr.sumWorst < 1e-9, "the points' friction adds up to the nodes'", `worst ${fr.sumWorst.toExponential(2)}`);

// ── the Coulomb solve on one node, set by hand (in a run a node sticks only where the neutral point
//    happens to fall on the grid: 1 look in 3788 above, always the mid-width row): a slip under
//    capacity × Δt / m stops at the roll speed with a share of the capacity under 1; a larger one slides
//    by exactly capacity × Δt / m at the full capacity. On a node off the mid-width plane, both ways
{
  const s = new PlanSim(condition());
  const kSym = Math.round(-s.oz / s.h);
  const idx = Math.round(-s.ox / s.h) * s.nzN + kSym + 2; // x ≈ 0, two rows off the mid-width plane
  const vR = s.params.rolling.rollSpeed;
  const m = s.mass[0];
  const c = (0.2 * vR * m) / s.dt; // capacity × Δt / m = 0.2 v_R
  const solve = (vx, vz) => {
    for (const a of [s.gm, s.gvx, s.gvz, s.gcap]) a.fill(0);
    s.gpush.fill(0);
    s.pusherActive = false;
    s.gm[idx] = m;
    s.gvx[idx] = m * vx;
    s.gvz[idx] = m * vz;
    s.gcap[idx] = c;
    s.gridUpdate();
    return { vx: s.gvx[idx], vz: s.gvz[idx], share: Math.hypot(s.gfx[idx], s.gfz[idx]) };
  };
  const stick = solve(vR - 0.1 * vR, 0.05 * vR); // slip 0.11 v_R < 0.2 v_R
  ok(Math.abs(stick.vx - vR) < 1e-12 * vR && Math.abs(stick.vz) < 1e-12 * vR && stick.share < 1, 'Coulomb on a node: a slip under capacity × Δt / m sticks at the roll speed', `v ${stick.vx.toFixed(6)}, ${stick.vz.toExponential(1)} m/s, share ${stick.share.toFixed(3)}`);
  const slide = solve(vR - 0.4 * vR, 0.3 * vR); // slip 0.5 v_R > 0.2 v_R
  const moved = Math.hypot(slide.vx - 0.6 * vR, slide.vz - 0.3 * vR);
  ok(Math.abs(moved - 0.2 * vR) < 1e-9 * vR && Math.abs(slide.share - 1) < 1e-9 && slide.vx < vR, 'Coulomb on a node: a larger slip slides, changed by capacity × Δt / m toward the roll speed', `Δv ${(moved / vR).toFixed(6)} v_R, share ${slide.share.toFixed(6)}`);
}

// ── front tension through the head grip: the total is σf × the head column's cross-section, the
//    exit strip carries σf, and the grip is protected only while the tension is on
{
  const t = new PlanSim(condition((b) => (b.rolling.frontTension = 100e6)));
  let protectedEarly = 0;
  while (t.frontNow === 0 && t.step < 20000) {
    for (let p = 0; p < t.n; p++) if (t.inGrip(p)) protectedEarly++;
    advance(t);
  }
  while (t.headX() < t.xExitProbe + 3e-3 && t.step < 20000) advance(t);
  const load = t.endLoad(2);
  near(load, t.frontNow * t.endSection(2), 1e-3, 'front grip load = σf × the head column cross-section (scale from the start of the step)');
  let f = 0;
  let a = 0;
  for (let p = 0; p < t.n; p++) {
    if (!t.active[p] || t.px[p] < t.xExitProbe || t.px[p] > t.xExitProbe + 1e-3) continue;
    const sec = t.section(p);
    f += (t.sxx[p] - t.pres[p]) * sec;
    a += sec;
  }
  near(f / a / 1e6, t.frontNow / 1e6, 0.1, 'the exit strip carries the front tension [MPa]');
  ok(protectedEarly === 0 && t.frontNow > 0, 'the head grip is an ordinary point until the front tension is on', `${protectedEarly} protected looks before`);
}

// ── the edge: brittle → it fails from the edge (the tensile band); less brittle → nothing
//    fails, unless a notch in the edge concentrates the tension: then it fails at its root.
//    (The limits moved with the volume averaging, T63: point by point the grid's pressure scatter pushed the edge's
//    triaxiality into tension and the edge cracked up to C 0.1 with or without a notch, from a point 0.87 mm in;
//    smoothed, it cracks up to C 0.07 from the outermost column, and at C 0.1 only with the notch.)
//    (The failed band runs along the edge, not across, with the faces split ('dfg') or not: the
//    edge is under an even tension along the bite and fails all at once, and the inside is in
//    compression, so no tip runs inwards — docs/model.md「平面図モデル」, T50.)
function crackRun(cl, notch = 0) {
  const s = new PlanSim(condition((b) => {
    b.damage.model = 'cockcroft-latham';
    b.damage.clCrit = cl;
    if (notch) b.defects = [{ kind: 'void', x: b.rolling.sheetLength / 2, y: W / 2, ax: notch, ay: notch }];
  }));
  while (s.phase() !== 'done' && s.step < 20000 && s.cracks.length === 0) advance(s);
  return s;
}
const brittle = crackRun(0.05);
const first = brittle.cracks[0];
ok(!!first && first.sheetZ > W / 2 - 1.5e-3, 'brittle (Cockcroft-Latham 0.05): the first crack is at the edge', first ? `${((W / 2 - first.sheetZ) * 1e3).toFixed(2)} mm in from the edge, η ${first.eta.toFixed(2)}` : 'no crack');
const plain = crackRun(0.1);
ok(plain.cracks.length === 0, 'Cockcroft-Latham 0.1, straight edge: no crack', `${plain.cracks.length} cracks by step ${plain.step}`);
const notch = 0.5e-3;
const notched = crackRun(0.1, notch);
const c = notched.cracks[0];
const L = notched.params.rolling.sheetLength;
ok(!!c && Math.abs(c.sheetX - L / 2) < notch + 0.5e-3 && c.sheetZ > W / 2 - notch - 0.75e-3, 'Cockcroft-Latham 0.1, notched edge: it cracks at the notch root', c ? `${(c.sheetX * 1e3).toFixed(2)} mm from the head (notch at ${(L / 2 * 1e3).toFixed(2)}), ${((W / 2 - c.sheetZ) * 1e3).toFixed(2)} mm in from the edge (root at ${(notch * 1e3).toFixed(2)})` : 'no crack');
// ── the volume averaging (T63): the pressure of neighbouring points in the bite. Plastic flow is isochoric and the
//    thickness fixes the in-plane divergence in the bite, so point by point the grid locks and the pressure of
//    neighbours scatters (the jump's p95 is about half the mean pressure); smoothing the in-plane volumetric rate over
//    the grid ('rate', the default, as in the section model) brings it under a quarter. The means are unchanged (the
//    load and the exit thickness above hold for both).
{
  const jumps = (jbar) => {
    const s = new PlanSim(condition((b) => {
      b.rolling.sheetLength = 12e-3;
      if (!jbar) b.numerics.jbar = false;
    }));
    while ((s.phase() !== 'steady' || s.headX() < s.xExitProbe + 2e-3) && s.step < 20000) s.advance();
    const d = [];
    let sum = 0;
    let n = 0;
    for (let i = 0; i < s.NI; i++) {
      for (let k = 0; k < s.NK; k++) {
        const q = s.lattice[i * s.NK + k];
        if (q < 0 || !s.active[q] || !(s.px[q] > -s.contactLength && s.px[q] < 0)) continue;
        sum += s.pres[q];
        n++;
        for (const r of [i + 1 < s.NI ? s.lattice[(i + 1) * s.NK + k] : -1, k + 1 < s.NK ? s.lattice[i * s.NK + k + 1] : -1]) {
          if (r >= 0 && s.active[r] && s.px[r] > -s.contactLength && s.px[r] < 0) d.push(Math.abs(s.pres[q] - s.pres[r]));
        }
      }
    }
    d.sort((a, b) => a - b);
    return { mean: sum / n, p95: d[Math.floor(0.95 * (d.length - 1))], pairs: d.length, averaged: s.averaged };
  };
  const rate = jumps(true);
  const point = jumps(false);
  ok(rate.averaged && !point.averaged && rate.pairs > 100, "the default smooths the in-plane volumetric rate ('rate'); J-bar off runs point by point", `${rate.pairs} neighbour pairs in the bite`);
  between(point.p95 / point.mean, 0.35, 1, 'point by point: the pressure jump between neighbours in the bite, over the mean pressure (volumetric locking)');
  between(rate.p95 / rate.mean, 0, 0.25, "'rate': the same jump, smoothed");
}

ok(ps.looks > 0 && ps.worst <= 1e4, 'off the rolls: plane stress, |σ_yy| ≤ 0.01 MPa after every step of every run', `max ${(ps.worst * 1e-6).toExponential(2)} MPa (${ps.where}) over ${ps.looks} looks`);
done();
