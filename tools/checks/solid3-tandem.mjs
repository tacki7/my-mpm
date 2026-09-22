// The 3D model's tandem, steady length and rolls that follow the pass (src/mpm/solid/tandem3.ts, Sim3.adjustRolls),
// 4 cells, a strip 1 mm wide with the width direction held (the 2D section's problem), about 2.5 min in all:
// - solidScales() is the Sim3's own grid and clock; one stand of Tandem3 is Sim3 with a SolidSampler, bit for bit
// - the length 'steady' gives the steady looks a 'steady' handoff needs
// - two stands, handoff 'steady': the next stand's entry strip is the measured one, and both stands' force per
//   width agree with the section model's tandem (TandemSim) on the same grid — the strain is carried
// - remap3 carries the strip's shape: a strip given a crown and an edge barrel comes out of the handoff with them
// - flattening 'hitchcock' with a constant reduction: the rolls settle, R' and the gap agree with the section
//   model's, and the strip's mean thickness is the target
// @check
import { ok, between, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { TandemSim } from '../../src/mpm/tandem.ts';
import { Sim3, solidParams, solidScales } from '../../src/mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../../src/mpm/solid/steady.ts';
import { STEADY_LOOKS, Tandem3, remap3, steadyLength3 } from '../../src/mpm/solid/tandem3.ts';

const W = 1e-3;
const base = (edit = () => {}) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.lengthMode = 'steady';
  edit(P.rolling);
  return P;
};
const solid = (P) => solidParams(P, { width: W, planeStrain: true });

// ── scales, and one stand is a plain pass
for (const [name, edit] of [['rigid rolls', () => {}], ['rolls that follow the pass', (r) => { r.flattening = 'hitchcock'; r.gapControl = 'reduction'; }]]) {
  const P = solid(base(edit));
  P.rolling.sheetLength = 6e-3;
  delete P.rolling.lengthMode;
  const sim = new Sim3(P);
  const s = solidScales(P);
  ok(s.h === sim.h && s.dt === sim.dt && s.contactLength === sim.contactLength && s.xExitProbe === sim.xExitProbe && s.vIn === sim.vIn && s.rollsAdjusted === sim.rollsAdjusted, `solidScales = Sim3 (${name})`, JSON.stringify(s));
}
{
  const P = solid(base());
  const T = new Tandem3(P, 1);
  const sim = new Sim3(T.base);
  const sampler = new SolidSampler();
  let same = true;
  let looks = 0;
  while (sim.step < 4000) {
    sim.advance();
    const l = T.advance();
    if (sim.step % READ_STEPS !== 0) continue;
    const m = sampler.look(sim);
    looks++;
    same &&= l !== null && l.force === m.force && l.torque === m.torque && l.phase === m.phase;
  }
  ok(same && looks === 8 && T.sim.px[T.sim.n - 1] === sim.px[sim.n - 1], 'one stand of Tandem3 = Sim3 + SolidSampler, bit for bit', `${looks} looks`);
  near(T.base.rolling.sheetLength, steadyLength3(P), 0.01, 'length steady: sheetLength = steadyLength3 up to 0.1 mm');
}

// ── two stands, handoff 'steady', against the section model's tandem
const T2 = new TandemSim(base(), 2, 2000, 'steady');
while (!T2.done && T2.stepOffset + T2.sim.step < 200000) {
  T2.advance();
  // the second stand: three steady readings are enough
  if (T2.stand === 1 && T2.steadyMeans().readings >= 3) break;
}
const ref = [T2.results[0].steadyForce, T2.steadyMeans().force];
const T3 = new Tandem3(solid(base()), 2, 'steady');
// read at the handoff, before the new stand's first step: J vol0 over the lattice cell, and ln J = −p / K
let fill = NaN;
let lnJ = NaN;
T3.onStandDone = ({ stand, next: n }) => {
  if (stand !== 0 || !n) return;
  const q = n.n >> 1;
  fill = (n.F[9 * q] ** 3 * n.vol0[q]) / (n.dp ** 2 * n.dz);
  lnJ = (3 * Math.log(n.F[9 * q])) / (-n.pres[q] / n.el.K);
};
while (!T3.done && T3.stepOffset + T3.sim.step < 200000) {
  T3.advance();
  if (T3.stand === 1 && T3.sampler.count >= 6) break;
}
const r1 = T3.results[0];
ok(r1?.phase === 'steady' && r1.steady.looks >= STEADY_LOOKS && r1.massLost === 0 && !T3.stopped, 'stand 1 handed on while steady, with its steady looks', `${r1?.phase}, ${r1?.steady?.looks} looks`);
near(T3.sim.params.rolling.h0, r1.thicknessOut, 1e-12, 'stand 2 enters with the strip that came out: thickness');
near(T3.sim.params.solid.width, W, 1e-3, '  … and width (held: the entry width)');
near(r1.thicknessOut, T2.results[0].thicknessOut, 5e-3, 'the strip that came out, by volume, against the section model\'s');
between(fill, 1 - 1e-12, 1 + 1e-12, 'a new point fills its lattice cell');
between(lnJ, 1 - 1e-9, 1 + 1e-9, '  … at the volume its parent\'s pressure needs (ln J = −p / K)');
const f1 = r1.steady.force / (2 * r1.steady.halfWidth);
const st2 = T3.sampler.means(T3.sim);
const f2 = st2.force / (2 * st2.halfWidth);
near(f1, ref[0], 0.05, 'stand 1 force per width = the section model\'s');
near(f2, ref[1], 0.06, 'stand 2 force per width = the section model\'s (the strain is carried)');
ok(f2 > f1, 'stand 2 rolls harder than stand 1 would at its thickness: above stand 1', `${(f1 * 1e-6).toFixed(3)} → ${(f2 * 1e-6).toFixed(3)} kN/mm`);

// ── rolls that follow the pass, against the section model
const adj = (r) => { r.flattening = 'hitchcock'; r.gapControl = 'reduction'; };
const A2 = new Sim(new TandemSim(base(adj), 1).base);
while (A2.step < 200000 && !(A2.rollsSettled || A2.phase() === 'done')) A2.advance();
const A3 = new Tandem3(solid(base(adj)), 1);
while (A3.sim.step < 200000 && !(A3.sim.rollsSettled || A3.done)) A3.advance();
const s3 = A3.sim;
ok(s3.rollsSettled && A2.rollsSettled, 'the rolls settle before the tail comes', `3D step ${s3.step}, 2D step ${A2.step}`);
near(s3.roll.R, A2.rolls[0].R, 0.02, "R' = the section model's");
near(s3.gap, A2.gap, 3e-3, "the gap = the section model's");
const target = s3.params.rolling.h0 * (1 - s3.params.rolling.reduction);
near(s3.gauge().thickness, target, 1.5e-3, 'the strip at the gauge is the target thickness');
ok(s3.roll.R > 1.1 * s3.params.rolling.rollRadius && A3.sampler.count <= 1, "a flattened roll: R' above R, and the phase waited for it", `R' ${(s3.roll.R * 1e3).toFixed(1)} mm, ${A3.sampler.count} steady looks at settling`);

// ── the shape goes into the next stand: a strip (W 2 mm, unrolled) given a crown across the width (the top surface
//    12 µm higher at mid-width than at the edge) and an edge barrel (the edge 10 µm wider at mid-thickness); the new
//    strip, on a finer lattice with more columns across, has the same surfaces to a micron
{
  const P = solidParams(base((r) => { r.sheetLength = 4e-3; delete r.lengthMode; }), { width: 2e-3, planeStrain: false });
  const old = new Sim3(P);
  const crown = 12e-6;
  const barrel = 10e-6;
  const hw = old.halfWidth0;
  const ht = P.rolling.h0 / 2;
  for (let p = 0; p < old.n; p++) {
    const zf = old.pz[p] / hw; // 0 mid-width … 1 edge
    const yf = old.py[p] / ht; // 0 mid-thickness … 1 surface
    old.py[p] *= 1 + (crown / ht) * (1 - zf * zf);
    old.pz[p] *= 1 + (barrel / hw) * (1 - yf * yf);
  }
  const top = (s, z) => s.py[s.lattice(s.NI >> 1, s.NJ - 1, Math.min(s.NK - 1, Math.round((z / s.halfWidth0) * s.NK - 0.5)))] + 0.5 * s.dp * s.F[9 * s.lattice(s.NI >> 1, s.NJ - 1, 0) + 4];
  const edge = (s, y) => s.pz[s.lattice(s.NI >> 1, Math.min(s.NJ - 1, Math.round((y / (s.params.rolling.h0 / 2)) * s.NJ - 0.5)), s.NK - 1)] + 0.5 * s.dz * s.F[9 * s.lattice(s.NI >> 1, 0, s.NK - 1) + 8];
  const next = remap3(old, P, 0.8 * P.rolling.h0, 2 * hw * 1.05);
  ok(next.NK > old.NK && next.NJ === old.NJ, 'the new lattice is finer across the width', `${old.NK} → ${next.NK} columns across, ${next.NJ} rows`);
  const crownNew = top(next, 0) - top(next, 0.9 * next.halfWidth0);
  const crownOld = top(old, 0) - top(old, 0.9 * hw);
  near(crownNew, crownOld, 0.15, 'the crown comes through the handoff (top surface, mid-width less 0.9 of the half width)', `${(crownNew * 1e6).toFixed(1)} of ${(crownOld * 1e6).toFixed(1)} µm`);
  const barrelNew = edge(next, 0) - edge(next, 0.9 * next.params.rolling.h0 / 2);
  const barrelOld = edge(old, 0) - edge(old, 0.9 * ht);
  near(barrelNew, barrelOld, 0.15, 'the edge barrel comes through (edge, mid-thickness less 0.9 of the half thickness)', `${(barrelNew * 1e6).toFixed(1)} of ${(barrelOld * 1e6).toFixed(1)} µm`);
  let inside = true;
  for (let p = 0; p < next.n && inside; p++) inside = next.py[p] > 0 && next.pz[p] > 0 && next.py[p] < 0.6 * P.rolling.h0 && next.pz[p] < 1.2 * hw;
  ok(inside, 'every new point is inside the quarter strip');
}
done();
