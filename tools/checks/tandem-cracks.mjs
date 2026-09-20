// Tandem rolling (src/mpm/tandem.ts), the cracks across the stands, on short coarse sheets (4 cells, 4 mm;
// about 15 s):
// - a crack through the thickness stops the tandem (a mill stops at a strip break)
// - a crack record with no point left keeps its start as the centroid
// - one stand leaves the crack records as the single pass has them
// - each crack record keeps the area that failed into it in each stand (the mass of its failed points over ρ):
//   a crack of stand 1 that does not grow adds 0 in stand 2 (the finer lattice's recount is not growth), and
//   what fails in stand 2, into an old crack or a new one, counts there; a crack of stand 1 is in stand 2
//   with its records and points
// The stand a crack is born in is read from a damage that crosses 1, so a point left at D just under 1 at the
// end of a stand is a coin toss between the two builds of node (the last bit of Math.exp / log, as CLAUDE.md
// has it for Chrome and node): the ductility of the milder band below keeps the highest damage of a point that
// did not fail at about 0.69 at the end of stand 1, far from 1. Moving it near the boundary is what made this
// check pass on macOS and fail on the CI (ubuntu) once. When you move these conditions, check the CI too.
// @check
import { ok, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams, DAMAGE_4340 } from '../../src/mpm/params.ts';
import { TandemSim } from '../../src/mpm/tandem.ts';

const short = (P) => {
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 4e-3;
  return P;
};
function toEnd(t) {
  const s0 = t.stand;
  while (t.stand === s0 && !t.done) t.advance();
}

// ── a crack through the thickness: the strip is broken, the tandem stops there (a mill stops at a strip break)
{
  const P = short(defaultParams());
  P.damage = { ...DAMAGE_4340, etaCutoff: -10 };
  P.defects = [{ kind: 'weak', x: 2e-3, y: 0, ax: 0.15e-3, ay: 0.6e-3, ductility: 1e-3 }];
  const t = new TandemSim(P, 2);
  let ev = null;
  t.onStandDone = (e) => (ev = e);
  toEnd(t);
  ok(t.done && t.stopped === 'separated' && t.results.length === 1 && t.results[0].separated && ev.next === null && t.stand === 0,
    'a crack through the thickness in stand 1: the tandem stops, separated', `${t.stopped}, ${t.results.length} results`);
}

// ── a crack record with no point left (it would be one whose points left the grid): its centroid is where it started
{
  const s = new Sim(short(defaultParams()));
  s.cracks.push({ id: 0, t: 0, step: 0, x: 1e-3, y: 2e-4, sheetX: 0, sheetY: 0, eta: 0, s1: 0, seq: 0, ep: 0, criterion: 'johnson-cook', count: 0 });
  const [c] = s.crackCentroids();
  ok(c.x === 1e-3 && c.y === 2e-4, 'a crack record without points: the centroid is its start, not NaN', `${c.x}, ${c.y}`);
}


// ── one stand with a crack: the records are the single pass's (no stand field added)
{
  const P = short(defaultParams());
  P.damage = { ...DAMAGE_4340, etaCutoff: -10 };
  P.defects = [{ kind: 'weak', x: 2e-3, y: 0, ax: 1.2e-3, ay: 0.13e-3, ductility: 1e-3 }];
  const a = new Sim(P);
  const t = new TandemSim(P, 1);
  while (!t.done) {
    a.advance();
    t.advance();
  }
  ok(a.cracks.length > 0 && JSON.stringify(t.sim.cracks) === JSON.stringify(a.cracks), 'one stand with cracks: the crack records are the single pass\'s, as they are', `${a.cracks.length} records`);
}

// ── crack areas by stand (mass of the failed points over ρ): a crack that does not grow in stand 2 keeps its area
// (the finer lattice's recount is not growth); what fails in stand 2, into an old crack or a new one, counts there
function bands(du2) {
  const P = short(defaultParams());
  P.damage = { ...DAMAGE_4340, etaCutoff: -10 };
  P.defects = [
    { kind: 'weak', x: 2e-3, y: 0, ax: 0.6e-3, ay: 0.13e-3, ductility: 1e-3 },
    { kind: 'weak', x: 2e-3, y: 0, ax: 1.2e-3, ay: 0.13e-3, ductility: du2 },
  ];
  const t = new TandemSim(P, 2);
  t.start = null;
  t.onStandDone = (e) => {
    if (!e.next) return;
    const failed = (s) => s.failed.reduce((x, v) => x + v, 0);
    t.start = { records: e.sim.cracks.length, failedBefore: failed(e.sim), failed: failed(e.next), counted: e.next.cracks.reduce((x, c) => x + c.count, 0), centroids: e.next.crackCentroids().length, marks: e.sim.cracks.every((c) => c.stand === 0) };
  };
  while (!t.done) t.advance();
  return t;
}
{
  const t = bands(0.05); // the milder band stays below D = 1: nothing fails in stand 2
  const [r0, r1] = t.results;
  const rec = t.sim.cracks;
  ok(rec.length === 1 && rec[0].stand === 0 && rec[0].areaByStand.length === 2 && rec[0].areaByStand[0] > 0 && rec[0].areaByStand[1] === 0,
    'a crack of stand 1 that does not grow: its area in stand 2 is 0 (the recount on the finer lattice is not growth)', JSON.stringify(rec.map((c) => [c.stand, c.count, c.areaByStand])));
  ok(r0.cracksBorn === 1 && r0.crackGrowth === rec[0].areaByStand[0] && r1.cracksBorn === 0 && r1.crackGrowth === 0,
    'and the stand results: 1 crack born in stand 1 with its area, nothing in stand 2', `${r0.cracksBorn} / ${r1.cracksBorn} born, growth ${r0.crackGrowth.toExponential(3)} / ${r1.crackGrowth} m²`);
  // the crack of stand 1 at the start of stand 2
  const st = t.start;
  ok(st && st.records > 0 && st.marks, 'a crack of stand 1: its records are there at the start of stand 2, marked stand 1', `${st?.records} records`);
  ok(st && st.failed > st.failedBefore && st.counted === st.failed && st.centroids === st.records, 'and its failed points (more of them on the finer lattice), each in its crack', `${st?.failedBefore} → ${st?.failed} failed points`);
}
{
  const t = bands(0.03); // the milder band fails in stand 2: the old cracks grow and new ones start
  const [r0, r1] = t.results;
  const rec = t.sim.cracks;
  const born2 = rec.filter((c) => c.stand === 1);
  const sum1 = rec.reduce((a, c) => a + c.areaByStand[1], 0);
  ok(r1.cracksBorn === born2.length && born2.length > 0 && born2.every((c) => c.areaByStand[0] === 0 && c.areaByStand[1] > 0),
    'cracks born in stand 2: marked stand 2, their area in stand 2 only', JSON.stringify(rec.map((c) => [c.stand, c.count, c.areaByStand.map((v) => +v.toExponential(2))])));
  ok(rec.some((c) => c.stand === 0 && c.areaByStand[1] > 0) && r1.crackGrowth > 0 && Math.abs(sum1 - r1.crackGrowth) <= 1e-12 * r1.crackGrowth,
    'a crack of stand 1 that grows: the new area is in its stand 2 share, and the stand result is the sum over the records', `${r1.crackGrowth.toExponential(3)} m² in stand 2, ${r0.crackGrowth.toExponential(3)} in stand 1`);
}
done();
