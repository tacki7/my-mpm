// The entry crown of the 3D model (Sim3 crownIn, ySize) and the exit's crown and flatness (steady.ts):
// - the lattice: each column's points are packed through the thickness by the parabola h(z) / h0, with the mass
//   to match; the drawn faces, the section and the exit probe's thickness all use the column's size, so at
//   step 0 the probe reads h(z) exactly; a crown as big as the thickness is refused; a tandem's next stand does
//   not take the input again (its shape comes from the strip)
// - in a plane-strain pass (W 2 mm, 4 cells, about 20 s each): the flatness is finite, centred, and nearly zero
//   (every column is the same problem), the exit crown of a flat strip between rigid rolls is nearly zero, and
//   a crowned strip loses most of its crown (the gap is fixed) with less force (the edge columns are reduced less)
//   and comes out longer at the middle (+ flatness there)
// @check
import { ok, near, between, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { faces } from '../../src/mpm/solid/surface.ts';
import { remap3 } from '../../src/mpm/solid/tandem3.ts';
import { READ_STEPS, SolidSampler } from '../../src/mpm/solid/steady.ts';

const base = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 12e-3;
  P.damage.model = 'none';
  return P;
};
const CROWN = 40e-6;

// ── the lattice
const s = new Sim3(solidParams(base(), { width: 4e-3, crownIn: CROWN }));
const h0 = s.params.rolling.h0;
const hw = s.halfWidth0;
const hAt = (z) => h0 - CROWN * (z / hw) ** 2;
let worst = 0;
for (let k = 0; k < s.NK; k++) worst = Math.max(worst, Math.abs(s.ySize[k] - hAt((k + 0.5) * s.dz) / h0));
ok(worst < 1e-12, 'ySize is the parabola h(z) / h0 at the columns', `worst ${worst.toExponential(1)}`);
ok(s.ySize[0] > 0.999 && s.ySize[s.NK - 1] < 1 - 0.9 * (CROWN / h0), 'the mid-width column is h0, the edge column about h0 − crown', `${s.ySize[0].toFixed(5)}, ${s.ySize[s.NK - 1].toFixed(5)}`);
near(2 * s.entryHalfThickness(hw), h0 - CROWN, 1e-12, 'entryHalfThickness at the edge is (h0 − crown) / 2');
// the mass: ρ × the quarter's volume ∫ h/2 dz × L, on the columns
let M = 0;
for (let p = 0; p < s.n; p++) M += s.mass[p];
let V = 0;
for (let k = 0; k < s.NK; k++) V += (hAt((k + 0.5) * s.dz) / 2) * s.dz;
near(M, s.params.material.rho * s.params.numerics.massScale * V * s.params.rolling.sheetLength, 1e-9, 'the mass is the crowned quarter\'s');
// the top face at the head, by column: y = h(z_k) / 2 (the vertex's z is the column's outer side, its y the column's size)
const top = faces(s, []).find((f) => f.name === 'top');
let faceErr = 0;
for (let c = 0; c < top.cols; c++) {
  const v = (top.rows - 1) * top.cols + c;
  faceErr = Math.max(faceErr, Math.abs(top.pos[3 * v + 1] - hAt((c + 0.5) * s.dz) / 2));
}
ok(faceErr < 1e-9, 'the drawn top face lies on h(z) / 2 (the column\'s size, not dp)', `worst ${(faceErr * 1e6).toFixed(3)} µm`);
// the exit probe's thickness on the undeformed strip, column by column
const mid = (s.xHead0 + s.xHead0 - s.params.rolling.sheetLength) / 2;
const ex = s.exitMeasure(mid, s.h);
let probeErr = 0;
for (let k = 0; k < s.NK; k++) probeErr = Math.max(probeErr, Math.abs(2 * ex.halfThickness[k] - hAt(ex.z[k])));
ok(ex && probeErr < 1e-9, 'the probe reads h(z) on the undeformed strip, column by column', `worst ${(probeErr * 1e6).toFixed(3)} µm`);
let sec = 0;
for (let j = 0; j < s.NJ; j++) sec += s.section(s.lattice(0, j, s.NK - 1));
near(sec, (hAt((s.NK - 0.5) * s.dz) / 2) * s.dz, 1e-9, 'a column\'s section is its crowned thickness × dz');

let refused = false;
try {
  new Sim3(solidParams(base(), { width: 4e-3, crownIn: h0 }));
} catch (e) {
  refused = /crown/.test(String(e));
}
ok(refused, 'a crown as big as the thickness is refused');
const next = remap3(s, s.params, 0.75 * h0, 4.2e-3, null);
ok(next.params.solid.crownIn === undefined && Array.from(next.ySize).every((v) => v === 1), 'the next stand of a tandem takes its shape from the strip, not the crown input');

// ── plane-strain passes
function pass(crownIn) {
  const sim = new Sim3(solidParams(base(), { width: 2e-3, planeStrain: true, ...(crownIn ? { crownIn } : {}) }));
  const sampler = new SolidSampler();
  let looks = 0;
  while (sim.step < 40000) {
    for (let k = 0; k < READ_STEPS; k++) sim.advance();
    const look = sampler.look(sim);
    if (look.phase === 'steady') looks++;
    if (looks >= 4 || look.phase === 'done' || look.phase === 'stalled') break;
  }
  return sampler.means(sim);
}
const flat = pass(0);
const crowned = pass(CROWN);
ok(flat && crowned, 'both plane-strain passes reach steady');
if (flat && crowned) {
  const fl = flat.flatness;
  const mean = fl.reduce((a, b) => a + b, 0) / fl.length;
  ok(fl.length === 8 && fl.every(Number.isFinite) && Math.abs(mean) < 1e-6, 'the flatness has a finite value per column, centred on its mean', fl.map((v) => v.toFixed(1)).join(' '));
  ok(Math.max(...fl.map(Math.abs)) < 30, 'with the width held every column is the same problem: the flatness is within 30 I-units', `max ${Math.max(...fl.map(Math.abs)).toFixed(1)}`);
  between(flat.crownOut, -3e-6, 3e-6, 'a flat strip comes out flat (the fitted crown within 3 µm)');
  ok(flat.crownIn === 0 && Math.abs(crowned.crownIn - CROWN) < 1e-12, 'the steady means carry the entry crown');
  // the surface is a fraction of a point's size (dp 125 µm) so a 40 µm crown is not taken out sharply: what is left is
  // within the lattice's stripes (a few µm), a quarter of the input at most
  between(crowned.crownOut, -10e-6, 10e-6, 'rigid rolls with a fixed gap take most of the crown out (10 µm of 40 left at most)');
  ok(crowned.flatness[0] > 0 && crowned.flatness[crowned.flatness.length - 1] < 0, 'the middle, reduced more, comes out longer: the flatness is + at the middle and − at the edge', crowned.flatness.map((v) => v.toFixed(1)).join(' '));
  ok(crowned.force < flat.force, 'the crowned strip needs less force (its edge columns are thinner and reduced less)', `${(crowned.force * 1e-3).toFixed(3)} vs ${(flat.force * 1e-3).toFixed(3)} kN`);
}

done();
