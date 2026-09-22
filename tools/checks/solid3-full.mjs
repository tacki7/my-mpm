// The 3D model with the whole thickness solved (SolidSettings.fullThickness: both rolls, no plane of symmetry
// at the mid-thickness; docs/model.md「3 次元モデル」「板厚の全体」), W 2 mm, L 8 mm, 4 cells, about 2 minutes on M2 (the full
// model's pass has twice the points; the gate's own limit below for CI's slower cores):
// - the grid and the lattice: rows of nodes both ways about y = 0, twice the lattice rows, the points from
//   −h0/2 to h0/2, the bottom face drawn
// - a whole pass in the full model is the quarter model's pass (the conditions are symmetric about the
//   mid-thickness): the steady force, torque, thickness, spread and slip agree to 1e-9 (the mirrored half is the
//   same arithmetic on the same numbers, up to the order of the sums), the step count is the same
// - a two-stand tandem with handoff 'steady' (W 1 mm, plane strain, as solid3-threads.mjs) in the full model
//   agrees with the quarter's, stand by stand
// - the quarter model is untouched: its steady force at these conditions is the value measured before the full
//   model was added (node tools/solid.mjs --W 2 --L 8 --cells 4 --json, 2026-09-23)
// Calibration (2026-09-23, copies of the tree): with the halving of the rolls' sums removed (rollShare = 1) the
// force, the torque and the thickness come out doubled and FAIL; with the bottom roll's mirror removed (sr = 1
// in p2g, gridNodes and followNodes) the lower half is not rolled, the pass never reaches steady and the step
// count and the results FAIL.
// @check 480s
import { ok, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { faces } from '../../src/mpm/solid/surface.ts';

/** the quarter model's steady force at W 2 mm, L 8 mm, 4 cells, measured on the tree before the full model was added [N] */
const QUARTER_FORCE = 5816.531863522108;

const base = (edit = () => {}) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 8e-3;
  edit(P);
  return P;
};

/** a whole pass (or tandem): the results of every stand and the step count */
function pass(P, stands = 1, handoff = 'done') {
  const T = new Tandem3(P, stands, handoff);
  let steps = 0;
  while (!T.done && steps < 200000) {
    T.advance();
    steps++;
  }
  return { results: T.results, steps, stopped: T.stopped, sim: T.sim };
}

const flat = (o, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
};
/** the worst relative difference over the numbers of two results (the same keys); `floor` as solid3-threads.mjs */
function worst(a, b, floor = 0) {
  const A = flat(a);
  const B = flat(b);
  let w = { key: '', err: 0, a: 0, b: 0 };
  for (const k of Object.keys(A)) {
    if (typeof A[k] !== 'number' || /secs|ms|particles/.test(k)) continue;
    if (typeof B[k] !== 'number') return { key: k, err: Infinity, a: A[k], b: B[k] };
    const err = Math.abs(A[k] - B[k]) / Math.max(floor, Math.abs(A[k]));
    if (err > w.err) w = { key: k, err, a: A[k], b: B[k] };
  }
  return w;
}

// ── the grid and the lattice
{
  const q = new Sim3(solidParams(base(), { width: 2e-3 }));
  const f = new Sim3(solidParams(base(), { width: 2e-3, fullThickness: true }));
  ok(f.fullThickness && !q.fullThickness, 'the setting is read', `${q.fullThickness} / ${f.fullThickness}`);
  ok(f.nyN === 2 * (q.nyN - 2) + 1 && f.gyOff === q.nyN - 2 && q.gyOff === 1, 'rows of nodes both ways about y = 0', `${q.nyN} → ${f.nyN}, gyOff ${q.gyOff} → ${f.gyOff}`);
  ok(f.NJ === 2 * q.NJ && f.NK === q.NK && f.NI === q.NI && f.n === 2 * q.n, 'twice the lattice rows through the thickness', `${q.NI} × ${q.NJ} × ${q.NK} → ${f.NI} × ${f.NJ} × ${f.NK}`);
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < f.n; p++) {
    if (f.py[p] < lo) lo = f.py[p];
    if (f.py[p] > hi) hi = f.py[p];
  }
  const h0 = f.params.rolling.h0;
  near(hi, h0 / 2 - f.dp / 2, 1e-9, 'the top row of points at h0/2 − dp/2');
  near(lo, -(h0 / 2 - f.dp / 2), 1e-9, 'the bottom row of points at −(h0/2 − dp/2)');
  near(f.yMax, q.yMax, 1e-12, 'the same reach above the strip');
  const fq = faces(q, []).map((x) => x.name);
  const ff = faces(f, []).map((x) => x.name);
  ok(!fq.includes('bottom') && ff.includes('bottom'), 'the bottom face is drawn in the full model only', `${fq.join(',')} / ${ff.join(',')}`);
  const bottom = faces(f, []).find((x) => x.name === 'bottom');
  let yb = 0;
  for (let v = 0; v < bottom.rows * bottom.cols; v++) yb += bottom.pos[3 * v + 1];
  near(yb / (bottom.rows * bottom.cols), -h0 / 2, 1e-6, 'the bottom face at −h0/2');
}

// ── a whole pass: the full model is the quarter's
const Pq = solidParams(base(), { width: 2e-3 });
const Pf = solidParams(base(), { width: 2e-3, fullThickness: true });
const q = pass(Pq);
const f = pass(Pf);
{
  ok(q.results.length === 1 && f.results.length === 1 && q.results[0].phase === 'done' && f.results[0].phase === 'done', 'both passes end with the strip out', `${q.results[0]?.phase} / ${f.results[0]?.phase}`);
  ok(q.steps === f.steps, 'the same number of steps', `${q.steps} / ${f.steps}`);
  const rq = q.results[0];
  const rf = f.results[0];
  const w = worst(rq, rf);
  ok(w.err <= 1e-9, `every number of the stand's result within 1e-9 (${w.key} ${w.err.toExponential(2)})`, `${w.a} / ${w.b}`);
  near(rf.steady.force, rq.steady.force, 1e-9, `the steady force (${(rq.steady.force * 1e-3).toFixed(4)} kN)`);
  near(rf.steady.torque, rq.steady.torque, 1e-9, 'the steady torque');
  near(rf.thicknessOut, rq.thicknessOut, 1e-9, 'the thickness out');
  near(rf.widthOut, rq.widthOut, 1e-9, 'the width out');
  near(rf.steady.forwardSlip, rq.steady.forwardSlip, 1e-9, 'the forward slip');
  // the exit's thickness by column: half the distance between the faces, the top face's height in the quarter
  const hq = rq.steady.halfThickness;
  const hf = rf.steady.halfThickness;
  let e = 0;
  for (let k = 0; k < hq.length; k++) e = Math.max(e, Math.abs(hf[k] - hq[k]) / hq[k]);
  ok(hq.length === hf.length && e <= 1e-9, 'the exit thickness by column', `worst ${e.toExponential(2)}`);
  // the strip stays about the mid-thickness: the mass above and below within rounding
  let above = 0;
  let below = 0;
  for (let p = 0; p < f.sim.n; p++) if (f.sim.active[p]) (f.sim.py[p] >= 0 ? (above += f.sim.mass[p]) : (below += f.sim.mass[p]));
  near(below, above, 1e-9, 'the mass below the mid-thickness is the mass above');
  near(rq.steady.force, QUARTER_FORCE, 1e-9, 'the quarter model is untouched (the steady force pinned before the change)');
}

// ── a two-stand tandem, handoff 'steady'
{
  const Tq = pass(solidParams(base((p) => { p.rolling.lengthMode = 'steady'; }), { width: 1e-3, planeStrain: true }), 2, 'steady');
  const Tf = pass(solidParams(base((p) => { p.rolling.lengthMode = 'steady'; }), { width: 1e-3, planeStrain: true, fullThickness: true }), 2, 'steady');
  ok(Tq.results.length === 2 && Tf.results.length === 2 && Tq.stopped === null && Tf.stopped === null, 'both tandems run both stands', `${Tq.results.length} / ${Tf.results.length}, stopped ${Tq.stopped} / ${Tf.stopped}`);
  for (let k = 0; k < Math.min(Tq.results.length, Tf.results.length); k++) {
    const w = worst(Tq.results[k], Tf.results[k], 1);
    ok(w.err <= 1e-9, `stand #${k + 1}: every number within 1e-9 (${w.key} ${w.err.toExponential(2)})`, `${w.a} / ${w.b}`);
  }
  ok(Tf.sim.fullThickness && Tf.sim.NJ === 2 * Tq.sim.NJ, 'the second stand is made in the full model too', `${Tq.sim.NJ} / ${Tf.sim.NJ} rows`);
}

done();
