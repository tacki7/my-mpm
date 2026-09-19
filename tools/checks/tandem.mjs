// Tandem rolling (src/mpm/tandem.ts), on short coarse sheets (4 cells, 4 to 12 mm; about 15 s):
// - one stand is the single pass bit for bit (every point array and the diagnostics), and its result is
//   tools/run.mjs's means over reads every READ_STEPS, however often the page reads diagnostics()
// - the remap to the next stand keeps the mass; εp and damage keep their means through the thickness
//   (per lattice row) and along the sheet (per tenth of the material) and their largest values; every old
//   point has a new one; the pressure and stresses carried over stay put while the sheet moves freely
//   towards the next rolls (they are the rolled sheet's residual stresses, in balance: F = I instead of
//   √J I would drop the pressure at the first step)
// - the same with the rows sheared by high friction
// - damage adds up over the stands, and a crack of the first stand is still there in the second
// @check
import { ok, between, near, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams, DAMAGE_4340 } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';
import { READ_STEPS, TandemSim } from '../../src/mpm/tandem.ts';

const short = (P) => {
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 4e-3;
  return P;
};
// steps until the current stand ends (inside advance(), at its own reading), reading diagnostics every 100
// steps as the page does
function toEnd(t) {
  const s0 = t.stand;
  let k = 0;
  while (t.stand === s0 && !t.done && k < 400000) {
    t.advance();
    if (++k % 100 === 0) t.diagnostics();
  }
}

// ── one stand = the single pass, bit for bit (12 mm, for steady reads)
{
  const P = short(defaultParams());
  P.rolling.sheetLength = 12e-3;
  const page = new Sim(P); // read every 100 steps, as the page does
  const tool = new Sim(P); // read every READ_STEPS, as tools/run.mjs does
  const t = new TandemSim(P, 1);
  const reads = [];
  let same = true;
  let d;
  do {
    for (let k = 0; k < READ_STEPS; k++) {
      page.advance();
      tool.advance();
      t.advance();
      if (k % 100 === 99) {
        const { stand, stands, ...rest } = t.diagnostics();
        if (JSON.stringify(rest) !== JSON.stringify(page.diagnostics()) || stand !== 0 || stands !== 1) same = false;
      }
    }
    d = tool.diagnostics();
    reads.push(d);
  } while (d.phase !== 'done');
  const b = t.sim;
  const arrays = ['px', 'py', 'vx', 'vy', 'f00', 'f01', 'f10', 'f11', 'sxx', 'syy', 'sxy', 'szz', 'pres', 'ep', 'dJC', 'dHM', 'dCL', 'temp', 'failed'];
  const diff = arrays.filter((k) => page[k].some((v, i) => !Object.is(v, b[k][i])) || tool[k].some((v, i) => !Object.is(v, b[k][i])));
  ok(diff.length === 0 && same, 'one stand: every point array and every diagnostics read equal the single pass', diff.join(' ') || `${tool.step} steps`);
  const r = t.results[0];
  const steady = reads.filter((x) => x.phase === 'steady');
  const mean = (v) => v.reduce((a, x) => a + x, 0) / v.length;
  ok(
    t.done && t.results.length === 1 && r.phase === 'done' && r.steps === tool.step && steady.length >= 2 &&
      r.steadyForce === mean(steady.map((x) => x.rollForce)) && r.steadyTorque === mean(steady.map((x) => x.rollTorque)) &&
      r.exitThickness === mean(steady.filter((x) => x.exitThickness).map((x) => x.exitThickness)) && r.forwardSlip === mean(steady.map((x) => x.forwardSlip)),
    `one stand: it ends at the step run.mjs reads 'done', and its result is run.mjs's means over ${steady.length} steady reads, bit for bit (the page read it every 100 steps)`,
    `${r.steps} / ${tool.step} steps`,
  );
}

// ── the remap: what it keeps
function remapCheck(name, P) {
  const t = new TandemSim(P, 2);
  let ev = null;
  t.onStandDone = (e) => (ev = e);
  toEnd(t);
  const old = ev?.sim;
  ok(ev && ev.result.phase === 'done' && old.phase() === 'done' && ev.next === t.sim && t.stand === 1 && t.sim.step === 0 && t.parentOf === ev.parentOf && t.stepOffset === old.step,
    `${name}: stand 1 done, the next stand set up at step 0, onStandDone told`);
  const sim = t.sim;
  const par = t.parentOf;
  let mOld = 0;
  let mNew = 0;
  for (let p = 0; p < old.n; p++) if (old.active[p]) mOld += old.mass[p];
  for (let q = 0; q < sim.n; q++) mNew += sim.mass[q];
  near(mNew, mOld, 1e-12, `${name}: the total mass is kept`);
  const kids = new Int32Array(old.n);
  for (let q = 0; q < sim.n; q++) kids[par[q]]++;
  let orphans = 0;
  for (let p = 0; p < old.n; p++) if (old.active[p] && kids[p] === 0) orphans++;
  ok(par.length === sim.n && orphans === 0, `${name}: every old point has a new one (children per point ${(sim.n / old.n).toFixed(2)})`, `${orphans} without`);
  const r = t.results[0];
  near(sim.params.rolling.h0, r.thicknessOut, 1e-12, `${name}: stand 2's entry thickness is the measured one (${(r.thicknessOut * 1e3).toFixed(4)} mm)`);

  // means per lattice row (through the thickness), mass-weighted, and the largest; along the sheet, the mean
  // over each tenth of the material (the columns' means, cut at the same fractions of the length in both:
  // 32 old columns and 57 new ones do not split into tenths alike)
  const profile = (s, f) => {
    const rows = new Float64Array(s.NJ);
    const rw = new Float64Array(s.NJ);
    const cols = new Float64Array(s.NI);
    const cw = new Float64Array(s.NI);
    let max = 0;
    for (let p = 0; p < s.n; p++) {
      if (!s.active[p]) continue;
      const v = f(s, p);
      const m = s.mass[p];
      rows[s.lj[p]] += m * v;
      rw[s.lj[p]] += m;
      cols[s.li[p]] += m * v;
      cw[s.li[p]] += m;
      max = Math.max(max, v);
    }
    const tenths = new Float64Array(10);
    for (let i = 0; i < s.NI; i++) {
      const [a, b] = [i / s.NI, (i + 1) / s.NI];
      for (let k = Math.floor(10 * a); k < 10 && k / 10 < b; k++) tenths[k] += (cols[i] / cw[i]) * (Math.min(b, (k + 1) / 10) - Math.max(a, k / 10)) * 10;
    }
    return { rows: Array.from(rows, (v, i) => v / rw[i]), tenths: Array.from(tenths), max };
  };
  const worst = (a, b) => Math.max(...a.map((v, i) => Math.abs(b[i] - v) / Math.max(...a.map(Math.abs))));
  // εp to 1 %. The damage along the sheet swings from column to column with the grid (a peak every few
  // columns where the rows cross the grid, 10 × the valleys at high friction), and each old column goes to
  // NI'/NI = 1.8 to 2.3 new ones as a whole number, 2 or 3: a tenth's mean moves by up to 7 %, a row's
  // (over the whole length) by 1 % (docs/model.md「タンデム」)
  for (const [what, f, row, tenth] of [
    ['εp', (s, p) => s.ep[p], 0.01, 0.01],
    ['damage', (s, p) => s.governingDamage(p), 0.02, 0.1],
  ]) {
    const a = profile(old, f);
    const b = profile(sim, f);
    ok(a.max > 0 && b.max === a.max, `${name}: the largest ${what} is kept`, `${a.max.toPrecision(4)} → ${b.max.toPrecision(4)}`);
    between(worst(a.rows, b.rows), 0, row, `${name}: ${what} per lattice row (through the thickness), largest change / largest row`);
    between(worst(a.tenths, b.tenths), 0, tenth, `${name}: ${what} per tenth of the material along the sheet, largest change / largest tenth`);
  }

  // the carried stresses stay put while the sheet moves freely (a few hundred steps, before the rolls)
  const stress = (s, q) => [s.pres[q], s.sxx[q], s.syy[q]];
  const s0 = Array.from({ length: sim.n }, (_, q) => stress(sim, q));
  let sum2 = 0;
  for (const v of s0) for (const x of v) sum2 += x * x;
  const rms = Math.sqrt(sum2 / (3 * sim.n));
  for (let k = 0; k < 300; k++) t.advance();
  const ph = t.sim.phase();
  let d2 = 0;
  for (let q = 0; q < sim.n; q++) stress(sim, q).forEach((x, c) => (d2 += (x - s0[q][c]) ** 2));
  const moved = Math.sqrt(d2 / (3 * sim.n));
  ok(ph === 'approach' && rms > 1e7, `${name}: 300 steps on, the sheet has not reached the rolls; residual stresses ${(rms * 1e-6).toFixed(0)} MPa rms`, ph);
  between(moved / rms, 0, 0.15, `${name}: the carried p, σxx and σyy move by (rms, of their rms)`);
  return t;
}

const two = remapCheck('standard', short(defaultParams()));
// damage adds up: the second stand's largest damage is not below the first's
toEnd(two);
ok(two.done && two.results.length === 2 && two.results[1].maxDamage >= two.results[0].maxDamage && two.results[1].h0 < two.results[0].h0,
  'two stands: done, thinner in the second, damage adds up', two.results.map((r) => `h0 ${(r.h0 * 1e3).toFixed(3)} mm, D ${r.maxDamage.toFixed(4)}`).join('; '));

// the stands do not depend on how the caller reads: two tandems, one read every 100 steps (a page), one never,
// end their stands at the same steps with the same results, and stand 2's points are the same bit for bit
{
  const P = short(defaultParams());
  const a = new TandemSim(P, 2);
  const b = new TandemSim(P, 2);
  let k = 0;
  while (!a.done || !b.done) {
    if (!a.done) a.advance();
    if (!b.done) b.advance();
    if (++k % 100 === 0) a.diagnostics();
  }
  const same = ['px', 'py', 'sxx', 'pres', 'ep', 'dJC'].every((f) => a.sim[f].every((v, i) => Object.is(v, b.sim[f][i])));
  ok(JSON.stringify(a.results) === JSON.stringify(b.results) && same && a.stepOffset === b.stepOffset,
    'two stands: read every 100 steps or never, the stands end at the same steps with the same results and points',
    a.results.map((r) => `${r.steps} steps, F ${(r.steadyForce ?? 0) * 1e-6}`).join('; '));
}

// high friction: the rows shear in the bite
remapCheck('high friction', short(presetById('high-friction').build()));

// ── a crack of the first stand is in the second: a centreline band that fails in compression too
{
  const P = short(defaultParams());
  P.damage = { ...DAMAGE_4340, etaCutoff: -10 };
  P.defects = [{ kind: 'weak', x: 2e-3, y: 0, ax: 1.2e-3, ay: 0.13e-3, ductility: 1e-3 }];
  const t = new TandemSim(P, 2);
  let before = 0;
  let failedBefore = 0;
  t.onStandDone = (e) => {
    before = e.sim.cracks.length;
    failedBefore = e.sim.failed.reduce((s, v) => s + v, 0);
  };
  toEnd(t);
  const s = t.sim;
  const failed = s.failed.reduce((a, v) => a + v, 0);
  const counted = s.cracks.reduce((a, c) => a + c.count, 0);
  ok(before > 0 && s.step === 0 && s.cracks.length === before && t.cracks.every((c) => c.stand === 0), 'a crack of stand 1: its records are there at the start of stand 2, marked stand 1', `${before} records`);
  ok(failed > failedBefore && counted === failed && s.crackCentroids().length === before, 'and its failed points (more of them on the finer lattice), each in its crack', `${failedBefore} → ${failed} failed points`);
}
done();
