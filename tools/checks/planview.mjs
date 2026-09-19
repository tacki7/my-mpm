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

// ── one run into the steady phase, then a look averaged over a few hundred steps
const sim = new PlanSim(condition());
while (sim.phase() !== 'steady' && sim.step < 20000) sim.advance();
sim.readForce();
const nb = 5;
const bite = Array.from({ length: nb }, () => [0, 0]);
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
    if (x > -1e-3 && x < 0) {
      const b = Math.min(nb - 1, Math.floor((sim.pz[p] / (W / 2)) * nb));
      bite[b][0] += sim.sxx[p] - sim.pres[p];
      bite[b][1]++;
    }
  }
  // grid nodes on or below the mid-width plane that carry material
  const kSym = Math.floor(-sim.oz / sim.h + 1e-9);
  for (let i = 0; i < sim.nxN; i++) for (let k = 0; k <= kSym; k++) {
    const idx = i * sim.nzN + k;
    if (sim.gm[idx] <= 0) continue;
    symNodes++;
    symVz = Math.max(symVz, Math.abs(sim.gvz[idx]));
    symVx = Math.max(symVx, Math.abs(sim.gvx[idx]));
  }
}
ok(psCount > 0 && psWorst < 1e5, 'off the rolls: plane stress, |σ_yy| < 0.1 MPa', `max ${(psWorst * 1e-6).toExponential(2)} MPa over ${psCount} looks`);
ok(gapCount > 0 && gapWorst < 1e-9, 'in contact: the thickness is the roll gap', `max |h − gap|/gap ${gapWorst.toExponential(2)} over ${gapCount} looks`);
ok(symNodes > 0 && symVz === 0 && symVx > 0.5 * sim.params.rolling.rollSpeed, 'mid-width plane: v_z = 0 and v_x free on its nodes', `${symNodes} node looks, max |v_z| ${symVz}, max |v_x| ${symVx.toFixed(3)} m/s`);

const sxx = bite.map(([s, c]) => (c ? (s / c) * 1e-6 : NaN));
const mid = sxx[0];
const outer = Math.max(sxx[nb - 2], sxx[nb - 3]);
ok(mid < -50 && outer > 20, 'in the bite the middle is in longitudinal compression and the edge zone in tension', `σxx mid → edge ${sxx.map((v) => v.toFixed(0)).join(', ')} MPa`);

const prof = sim.exitProfile(sim.xExitProbe, sim.xExitProbe + 2 * sim.h, 5);
between(prof.halfWidth / sim.halfWidth0 - 1, 0.02, 0.15, 'the width spreads (Wusatowski 6.4 % here)');
near(prof.bins[0].thick, sim.gap, 0.01, 'the middle leaves the rolls at the gap thickness');
// the neutral point sits where friction on both faces and the pressure on the sloping rolls balance
between((prof.bins[0].vx / sim.params.rolling.rollSpeed - 1) * 100, 1, 3.3, 'forward slip in the middle [%] (1.9 on this grid; slab method 3.4, section model 2.6–2.9)');

// roll force per unit width over the half width against the slab method (the middle is near plane strain)
const slab = karman(sim.params.rolling, sim.params.material);
between(force / forceSamples / sim.halfWidth0 / slab.force, 0.7, 1.3, 'roll force per unit width / slab method (3.03 kN/mm)');

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
