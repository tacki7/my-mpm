// The equivalent strain rate as a field ('rate': src/mpm/solver.ts, Sim3.rate): the deviatoric rate of deformation
// the flow stress sees, at the mill speed. In a steady pass it lives in the roll bite: its mean over the bite is the
// plane-strain estimate (2/√3) ln(h0/h1) · vR / Lc (the strain over the time a point takes through the contact
// length at about the roll speed), and before the bite and past the exit it is small. The 2D section (6 cells,
// L 8 mm) and the 3D model (4 cells, W 2 mm, L 12 mm) agree with each other in the bite. About 40 s.
// @check
import { ok, between, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../../src/mpm/solid/steady.ts';

const P = defaultParams();
const r = P.rolling;
const h1 = r.h0 * (1 - r.reduction);
// ── the 2D section, in its steady part
P.numerics.cellsThrough = 6;
P.rolling.sheetLength = 8e-3;
const sim = new Sim(P);
while (sim.phase() !== 'steady' && sim.step < 40000) for (let k = 0; k < 100; k++) sim.advance();
for (let k = 0; k < 300; k++) sim.advance();
ok(sim.phase() === 'steady', '2D: the pass is steady', `step ${sim.step}`);
const Lc = sim.contactLength;
const estimate = ((2 / Math.sqrt(3)) * Math.log(r.h0 / h1) * r.millSpeed) / Lc;

/** mean of `rate` over the active points with x in [x0, x1] */
function mean(n, active, px, rate, x0, x1) {
  let s = 0;
  let c = 0;
  for (let p = 0; p < n; p++) {
    if (!active[p] || px[p] < x0 || px[p] > x1) continue;
    s += rate[p];
    c++;
  }
  return c ? s / c : NaN;
}
const bite2 = mean(sim.n, sim.active, sim.px, sim.rate, -Lc, 0);
between(bite2 / estimate, 0.6, 1.6, `2D: the mean in the bite is about (2/√3) ln(h0/h1) vR / Lc (${bite2.toFixed(0)} against ${estimate.toFixed(0)} 1/s)`);
// (the short strip's tail is 1.2 mm upstream of the bite by then)
const before2 = mean(sim.n, sim.active, sim.px, sim.rate, -Infinity, -Lc - 0.5 * r.h0);
const after2 = mean(sim.n, sim.active, sim.px, sim.rate, 3 * r.h0, Infinity);
// before: the plastic zone reaches ahead of the contact and the short strip's tail is near it (12 % at 6 cells)
ok(before2 < 0.2 * bite2 && after2 < 0.1 * bite2, '2D: small before the bite and past the exit', `${before2.toFixed(1)} / ${after2.toFixed(1)} 1/s`);
// the display field is the array
const out = new Float32Array(sim.n);
sim.readField('rate', out);
let same = true;
for (let p = 0; p < sim.n; p++) if (Math.abs(out[p] - sim.rate[p]) > 1e-6 * Math.max(1, sim.rate[p])) same = false;
ok(same, "2D: readField('rate') is the point's strain rate");

// ── the 3D model at its third steady look
const P3 = defaultParams();
P3.numerics.cellsThrough = 4;
P3.rolling.sheetLength = 12e-3;
const s3 = new Sim3(solidParams(P3, { width: 2e-3 }));
const sampler = new SolidSampler();
let looks = 0;
while (s3.step < 30000 && looks < 3) {
  for (let k = 0; k < READ_STEPS; k++) s3.advance();
  if (sampler.look(s3).phase === 'steady') looks++;
}
ok(looks >= 3, '3D: steady looks');
const bite3 = mean(s3.n, s3.active, s3.px, s3.rate, -s3.contactLength, 0);
between(bite3 / bite2, 0.7, 1.4, `3D: the mean in the bite is the section's (${bite3.toFixed(0)} against ${bite2.toFixed(0)} 1/s)`);
const before3 = mean(s3.n, s3.active, s3.px, s3.rate, -Infinity, -s3.contactLength - 2 * r.h0);
ok(before3 < 0.1 * bite3, '3D: small before the bite', `${before3.toFixed(1)} 1/s`);
done();
