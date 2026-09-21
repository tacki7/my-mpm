// Tandem with the handoff at the steady state (src/mpm/tandem.ts, handoff 'steady'), 4 cells (about 10 s):
// - a stand with another after it ends while it rolls steadily, with STEADY_READS steady readings, well before
//   the whole sheet is through; the last stand rolls its sheet to the end
// - the next sheet is the steady stretch repeated: every new point's parent is in the stretch (past the roll
//   centres by h0, a contact length short of the head), every point of the stretch has (h0 / h1)² new ones a
//   repeat, and the largest εp and damage of the new sheet are the stretch's (not the head end's)
// - its length is steadyLength, its mass ρ h1 L, and it is long enough: the second stand gets to a 'steady'
//   handoff too
// - the second stand's steady force is the whole-sheet handoff's (3.664 kN/mm, docs/validation.md「タンデム」)
// - a stand's mean deformation resistance (StandResult.meanFlowStress) is the slab method's 2k mean, within −1 to +3 %
// - a sheet too short to get there is carried whole, bit for bit as with handoff 'done'
// - lengthMode 'steady': the first sheet is steadyLength long whatever length is given, and a single pass on it
//   has STEADY_READS steady readings
// @check
import { ok, between, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { karman } from '../../src/mpm/slab.ts';
import { READ_STEPS, STEADY_READS, TandemSim, steadyLength, steadySample, withSteadyLength } from '../../src/mpm/tandem.ts';

const params = (L) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = L;
  return P;
};

{
  const t = new TandemSim(params(14e-3), 3, READ_STEPS, 'steady');
  const ends = [];
  const maxOf = (sim, f, keep = () => true) => {
    let m = 0;
    for (let p = 0; p < sim.n; p++) if (keep(p)) m = Math.max(m, f(sim, p));
    return m;
  };
  const D = (s, p) => s.governingDamage(p);
  const EP = (s, p) => s.ep[p];
  // read at the handoff: the next sheet is rolled on from here
  t.onStandDone = (e) => {
    const sample = e.result.phase === 'steady' ? steadySample(e.sim) : null;
    const max = e.next && { ep: maxOf(e.next, EP), D: maxOf(e.next, D) };
    ends.push({ ...e, sample, max, readings: t.steadyMeans().readings });
  };
  while (ends.length < 2 && !t.done) t.advance();
  const [a, b] = ends;

  ok(a.result.phase === 'steady' && a.readings >= STEADY_READS, 'stand 1 hands on while steady', `${a.result.phase}, ${a.readings} steady readings, step ${a.result.steps}`);
  ok(a.sim.phase() === 'steady' && a.sim.tailX() < -a.sim.contactLength, 'its tail has not reached the bite');
  between(a.result.steps, 6000, 12000, 'stand 1 steps (17132 to roll the whole sheet)');

  // the stretch and the parents
  const old = a.sim;
  const next = a.next;
  const [i0, i1] = a.sample;
  const colX = (i) => {
    let s = 0;
    for (let j = 0; j < old.NJ; j++) s += old.px[old.lattice[i * old.NJ + j]];
    return s / old.NJ;
  };
  ok(colX(i0) >= old.params.rolling.h0 && colX(i1) <= old.headX() - old.contactLength, 'the stretch: h0 past the roll centres to a contact length short of the head', `x ${(colX(i0) * 1e3).toFixed(2)} to ${(colX(i1) * 1e3).toFixed(2)} mm, head ${(old.headX() * 1e3).toFixed(2)} mm`);
  const kids = new Int32Array(old.n);
  let outside = 0;
  let rowOff = 0;
  for (let q = 0; q < next.n; q++) {
    const p = a.parentOf[q];
    kids[p]++;
    if (old.li[p] < i0 || old.li[p] > i1) outside++;
    if (old.lj[p] !== next.lj[q]) rowOff++;
  }
  ok(outside === 0 && rowOff === 0, "every new point's parent is in the stretch, in its own row", `${outside} outside, ${rowOff} in another row`);
  const share = (old.params.rolling.h0 / next.params.rolling.h0) ** 2;
  const repeats = next.NI / share / (i1 - i0 + 1);
  let lo = Infinity;
  let hi = 0;
  for (let p = 0; p < old.n; p++) {
    if (old.li[p] < i0 || old.li[p] > i1) continue;
    lo = Math.min(lo, kids[p]);
    hi = Math.max(hi, kids[p]);
  }
  ok(lo >= Math.floor(share) * Math.floor(repeats) && hi <= Math.ceil(share) * Math.ceil(repeats), 'every point of the stretch has (h0/h1)² new ones a repeat', `${lo} to ${hi} children, share ${share.toFixed(2)} × ${repeats.toFixed(2)} repeats`);

  const inStretch = (p) => old.li[p] >= i0 && old.li[p] <= i1;
  ok(a.max.ep === maxOf(old, EP, inStretch), "the new sheet's largest εp is the stretch's");
  ok(a.max.D === maxOf(old, D, inStretch), "the new sheet's largest damage is the stretch's", `${a.max.D.toFixed(5)}; the old sheet's, head end and all, ${maxOf(old, D).toFixed(5)}`);

  // length and mass
  const L = steadyLength(next.params, READ_STEPS);
  ok(next.params.rolling.sheetLength === L, 'the next sheet is steadyLength long', `${(L * 1e3).toFixed(2)} mm`);
  let M = 0;
  for (let q = 0; q < next.n; q++) M += next.mass[q];
  const r = next.params;
  near(M, r.material.rho * r.numerics.massScale * r.rolling.h0 * L, 1e-12, 'its mass is ρ h1 L');
  near(a.result.thicknessOut, 0.7479e-3, 2e-3, "stand 1's sheet out, over the stretch (0.7479 mm over the whole sheet's middle half)");

  // the second stand gets there too, and rolls as after a whole-sheet handoff
  ok(b.result.phase === 'steady' && b.readings >= STEADY_READS, 'stand 2 hands on while steady (its sheet is long enough)', `${b.result.phase}, ${b.readings} steady readings, step ${b.result.steps}`);
  near(b.result.steadyForce, 3.664e6, 0.02, "stand 2's steady force is the whole-sheet handoff's");
  near(b.result.thicknessOut, 0.5601e-3, 3e-3, "stand 2's sheet out is the whole-sheet handoff's");

  // the mean deformation resistance in the bite (2k along the contact length, at the points' own εp) is the slab
  // method's with the strain of the stand before, a little over it (the redundant shear: +0.2 to +0.5 % at 6 cells, +1.4 % at 4)
  const c = 2 / Math.sqrt(3);
  const slab1 = karman(a.sim.params.rolling, a.sim.params.material).twoKMean;
  const slab2 = karman(b.sim.params.rolling, b.sim.params.material, 2000, c * Math.log(a.sim.params.rolling.h0 / b.sim.params.rolling.h0)).twoKMean;
  between(a.result.meanFlowStress / slab1, 0.99, 1.03, "stand 1's mean deformation resistance over the slab method's 2k mean");
  between(b.result.meanFlowStress / slab2, 0.99, 1.03, "stand 2's, the slab method's with stand 1's strain brought in");
}

// ── too short a sheet: carried whole, as with 'done'
{
  const run = (handoff) => {
    const t = new TandemSim(params(6e-3), 2, READ_STEPS, handoff);
    let end = null;
    t.onStandDone = (e) => (end ??= e);
    while (!end) t.advance();
    return end;
  };
  const s = run('steady');
  const d = run('done');
  const same = ['px', 'py', 'ep', 'pres', 'sxx', 'dJC', 'mass'].every((k) => s.next[k].length === d.next[k].length && s.next[k].every((v, i) => v === d.next[k][i]));
  ok(s.result.phase === 'done' && same, "a 6 mm sheet never gets there: the whole sheet is carried, bit for bit as with 'done'", `${s.result.phase}, ${s.next.n} points`);
}

// ── lengthMode 'steady': the length is worked out, and it is enough
{
  const P = params(3e-3); // far too short as given
  P.rolling.lengthMode = 'steady';
  const t = new TandemSim(P, 1);
  const L = steadyLength(P, READ_STEPS);
  const got = t.sim.params.rolling.sheetLength;
  ok(got >= L && got < L + 1.0001e-4 && L > 3e-3 && P.rolling.sheetLength === 3e-3, "lengthMode 'steady': the sheet is steadyLength long, up to 0.1 mm (the params given are not touched)", `${(L * 1e3).toFixed(2)} → ${(got * 1e3).toFixed(4)} mm`);
  ok(withSteadyLength(t.sim.params).rolling.sheetLength === got, 'working it out twice changes nothing');
  ok(withSteadyLength(params(3e-3)).rolling.sheetLength === 3e-3, "without the mode the length is the params'");
  while (!t.done) t.advance();
  ok(t.steadyMeans().readings >= STEADY_READS && t.results[0].steadyForce > 0, 'a single pass on it gets to the steady state with its readings', `${t.steadyMeans().readings} steady readings`);
}

done();
