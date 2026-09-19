// The plan-view model (src/mpm/planview/sim.ts) on a coarse 10 mm wide strip: the thickness
// rules (plane stress off the rolls, the gap in contact), the mid-width symmetry plane
// (v_z = 0, v_x free), the width effects that make edge cracks (spread; in the bite the edge
// is pulled in tension by the middle), the roll force against the slab method, and an edge
// that fails when the material is brittle and not when it is ductile. docs/validation.md
// has the finer and wider runs.
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

// ── one run into the steady phase (a 12 mm strip, so the bite is well into it), then a look
//    averaged over a few hundred steps
const sim = new PlanSim(condition((b) => (b.rolling.sheetLength = 12e-3)));
while ((sim.phase() !== 'steady' || sim.headX() < sim.xExitProbe + 2e-3) && sim.step < 20000) sim.advance();
sim.readForce();
const nb = 5;
const bite = Array.from({ length: nb }, () => [0, 0]);
const edge = [0, 0];
const cols = [0, 1].map(() => [0, 0]); // σxx of the two lattice columns next to the mid-width plane
const prevContact = Uint8Array.from(sim.pc, (v) => (v > 0 ? 1 : 0));
const switches = new Uint16Array(sim.n);
let psWorst = 0;
let psCount = 0;
let gapWorst = 0;
let gapCount = 0;
let symVz = 0;
let symVx = 0;
let symNodes = 0;
let force = 0;
let forceSamples = 0;
for (let s = 0; s < 600; s++) {
  sim.advance();
  for (let p = 0; p < sim.n; p++) {
    const c = sim.pc[p] > 0 ? 1 : 0;
    if (c !== prevContact[p]) (switches[p]++, (prevContact[p] = c));
  }
  if (s % 50) continue;
  force += sim.readForce();
  forceSamples++;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p] || sim.failed[p]) continue;
    const syy = sim.syy[p] - sim.pres[p];
    if (sim.pc[p] > 0) {
      gapWorst = Math.max(gapWorst, Math.abs(sim.thick[p] - sim.gapAt(sim.px[p])) / sim.gap);
      gapCount++;
    } else {
      psWorst = Math.max(psWorst, Math.abs(syy));
      psCount++;
    }
    const x = sim.px[p];
    // the middle of the bite (from 0.8 to 0.2 of the contact length before the exit)
    if (x > -0.8 * sim.contactLength && x < -0.2 * sim.contactLength) {
      const b = Math.min(nb - 1, Math.floor((sim.pz[p] / (W / 2)) * nb));
      bite[b][0] += sim.sxx[p] - sim.pres[p];
      bite[b][1]++;
      // the outermost millimetre of the width
      if (sim.pz[p] > W / 2 - 1e-3) (edge[0] += sim.sxx[p] - sim.pres[p]), edge[1]++;
      if (sim.lk[p] < 2) (cols[sim.lk[p]][0] += sim.sxx[p] - sim.pres[p]), cols[sim.lk[p]][1]++;
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
}
ok(psCount > 0 && psWorst < 1e5, 'off the rolls: plane stress, |σ_yy| < 0.1 MPa', `max ${(psWorst * 1e-6).toExponential(2)} MPa over ${psCount} looks`);
ok(gapCount > 0 && gapWorst < 1e-9, 'in contact: the thickness is the roll gap', `max |h − gap|/gap ${gapWorst.toExponential(2)} over ${gapCount} looks`);
ok(symNodes > 0 && symVz === 0 && symVx > 0.5 * sim.params.rolling.rollSpeed, 'mid-width plane z = 0: v_z = 0 and v_x free on its nodes', `${symNodes} node looks, max |v_z| ${symVz}, max |v_x| ${symVx.toFixed(3)} m/s`);

const chattering = [...switches].filter((v) => v >= 3).length;
ok(chattering === 0, 'contact is decided by complementarity: no point flips in and out of contact (≥ 3 times in 600 steps)', `${chattering} points, most flips ${Math.max(...switches)}`);
const [c0, c1] = cols.map(([a, c]) => (a / c) * 1e-6);
ok(Math.abs(c0 - c1) < 50, 'the mid-width plane is a mirror: no zigzag between the two columns next to it', `σxx ${c0.toFixed(0)} / ${c1.toFixed(0)} MPa in the bite`);
const sxx = bite.map(([s, c]) => (c ? (s / c) * 1e-6 : NaN));
const mid = sxx[0];
const edgeSxx = (edge[0] / edge[1]) * 1e-6;
ok(mid < -100 && edgeSxx > 30 && edgeSxx - mid > 200, 'in the bite the middle is in longitudinal compression and the outermost mm in tension', `σxx mid → edge ${sxx.map((v) => v.toFixed(0)).join(', ')}; outermost mm ${edgeSxx.toFixed(0)} MPa`);

const prof = sim.exitProfile(sim.xExitProbe, sim.xExitProbe + 2 * sim.h, 5);
between(prof.halfWidth / sim.halfWidth0 - 1, 0.02, 0.15, 'the width spreads (Wusatowski 6.4 % here)');
near(prof.bins[0].thick, sim.gap, 0.01, 'the middle leaves the rolls at the gap thickness');
// the neutral point sits where friction on both faces and the pressure on the sloping rolls balance
between((prof.bins[0].vx / sim.params.rolling.rollSpeed - 1) * 100, 1, 3.3, 'forward slip in the middle [%] (1.9 on this grid; slab method 3.4, section model 2.6–2.9)');

// friction: μ p_c per face at most the shear flow stress k, and never more impulse than m |Δv| in one step
{
  let p = 0;
  while (!(sim.active[p] && sim.pc[p] > 0)) p++;
  const area = sim.dp * sim.dp * (sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p]);
  const pc = sim.pc[p];
  sim.pc[p] = 1e10; // pressed far beyond μ p_c = k
  const k = sim.shearFlow(p);
  const tau = (sim.frictionFactor(p, area, 1, 0) * 1) / (2 * area); // sliding at 1 m/s
  const still = sim.frictionFactor(p, area, 0, 0); // no slip: the regularised Coulomb would be huge
  sim.pc[p] = pc;
  const want = k / Math.sqrt(1 + (0.01 * sim.params.rolling.rollSpeed) ** 2); // the regularisation's share at 1 m/s
  ok(Math.abs(tau - want) <= 1e-9 * k, 'friction per face is capped at the shear flow stress k (sticking)', `τ ${(tau * 1e-6).toFixed(3)} MPa, k ${(k * 1e-6).toFixed(3)} MPa`);
  ok(Math.abs(still * sim.dt - sim.mass[p]) <= 1e-12 * sim.mass[p], 'friction impulse per step is capped at m |Δv| (it cannot overshoot the roll speed)');
}

// roll force per unit width over the half width against the slab method (the middle is near plane strain)
const slab = karman(sim.params.rolling, sim.params.material);
between(force / forceSamples / sim.halfWidth0 / slab.force, 0.9, 1.05, 'roll force per unit width over the half width / slab method (3.03 kN/mm; the edge carries less)');

// ── front tension through the head grip: the total is σf × the head column's cross-section, the
//    exit strip carries σf, and the grip is protected only while the tension is on
{
  const t = new PlanSim(condition((b) => (b.rolling.frontTension = 100e6)));
  let protectedEarly = 0;
  while (t.frontNow === 0 && t.step < 20000) {
    for (let p = 0; p < t.n; p++) if (t.inGrip(p)) protectedEarly++;
    t.advance();
  }
  while (t.headX() < t.xExitProbe + 3e-3 && t.step < 20000) t.advance();
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
//    (The failed band runs along the edge, not across: with one velocity field the crack
//    faces do not open — docs/model.md.)
function crackRun(cl, notch = 0) {
  const s = new PlanSim(condition((b) => {
    b.damage.model = 'cockcroft-latham';
    b.damage.clCrit = cl;
    if (notch) b.defects = [{ kind: 'void', x: b.rolling.sheetLength / 2, y: W / 2, ax: notch, ay: notch }];
  }));
  while (s.phase() !== 'done' && s.step < 20000 && s.cracks.length === 0) s.advance();
  return s;
}
const brittle = crackRun(0.1);
const first = brittle.cracks[0];
ok(!!first && first.sheetZ > W / 2 - 1.5e-3, 'brittle (Cockcroft-Latham 0.1): the first crack is at the edge', first ? `${((W / 2 - first.sheetZ) * 1e3).toFixed(2)} mm in from the edge, η ${first.eta.toFixed(2)}` : 'no crack');
const plain = crackRun(0.2);
ok(plain.cracks.length === 0, 'Cockcroft-Latham 0.2, straight edge: no crack', `${plain.cracks.length} cracks by step ${plain.step}`);
const notch = 0.5e-3;
const notched = crackRun(0.2, notch);
const c = notched.cracks[0];
const L = notched.params.rolling.sheetLength;
ok(!!c && Math.abs(c.sheetX - L / 2) < notch + 0.5e-3 && c.sheetZ > W / 2 - notch - 0.75e-3, 'Cockcroft-Latham 0.2, notched edge: it cracks at the notch root', c ? `${(c.sheetX * 1e3).toFixed(2)} mm from the head (notch at ${(L / 2 * 1e3).toFixed(2)}), ${((W / 2 - c.sheetZ) * 1e3).toFixed(2)} mm in from the edge (root at ${(notch * 1e3).toFixed(2)})` : 'no crack');
done();
