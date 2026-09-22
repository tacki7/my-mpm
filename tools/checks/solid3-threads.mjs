// The 3D model's team of threads (src/mpm/solid/team.ts on node's worker_threads, tools/lib/solid-team.mjs),
// about a minute in all:
// - a pass on 3 threads is the pass on 1 thread: the steady means, the strip out, the failed points and the
//   step count agree to 1e-9 (the sums over a column's points are taken in a different order, so not bit for bit)
// - the team is faster than the thread alone
// - a tandem of two stands, handoff 'steady', on 2 threads: the team attaches to each stand (the second stand's
//   Sim3 is made for it by remap3) and both stands agree with the thread alone
// - the team's serial mode (the workers' shares one after another in one thread, Team serial) is the thread alone
//   to 1e-9 as well: a stage that depended on a neighbour's work in the same stage (the update once decided a
//   point's owner from a position the neighbour had already moved) shows here every time, not one run in three
// - a Sim3 not made for the team is refused
// @check
import { ok, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { nodeTeam } from '../lib/solid-team.mjs';

const base = (edit = () => {}) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  edit(P);
  return P;
};

/** a whole pass, alone or on a team of `threads` (serial: the team's debug mode); the results of every stand and the seconds */
async function pass(P, threads, stands = 1, handoff = 'done', serial = false) {
  const t0 = performance.now();
  const T = new Tandem3(P, stands, handoff, threads > 1 ? { shared: true, size: threads } : {});
  const team = threads > 1 ? nodeTeam(threads, { serial }) : null;
  if (team) await T.useTeam(team);
  let steps = 0;
  while (!T.done && steps < 200000) {
    if (team) await T.advanceTeam();
    else T.advance();
    steps++;
  }
  team?.close();
  return { results: T.results, steps, secs: (performance.now() - t0) / 1e3, stopped: T.stopped };
}

const flat = (o, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
};
/**
 * the worst relative difference over the numbers of two results (the same keys). `floor`: a number smaller than
 * this is compared to the floor instead of itself (1: in plane strain the spread, the crown and the flatness are zero
 * but for rounding, and their rounding is not a difference worth a FAIL)
 */
function worst(a, b, floor = 0) {
  const A = flat(a);
  const B = flat(b);
  let w = { key: '', err: 0, a: 0, b: 0 };
  for (const k of Object.keys(A)) {
    if (typeof A[k] !== 'number' || /secs|ms/.test(k)) continue;
    if (typeof B[k] !== 'number') return { key: k, err: Infinity, a: A[k], b: B[k] };
    const err = Math.abs(A[k] - B[k]) / Math.max(floor, Math.abs(A[k]));
    if (err > w.err) w = { key: k, err, a: A[k], b: B[k] };
  }
  return w;
}

// ── one pass, 1 against 3 threads
{
  const P = solidParams(base(), { width: 2e-3 });
  const one = await pass(P, 1);
  const three = await pass(P, 3);
  ok(one.results.length === 1 && three.results.length === 1 && one.results[0].phase === 'done' && three.results[0].phase === 'done', 'both passes end with the strip out', `${one.results[0]?.phase} / ${three.results[0]?.phase}`);
  ok(one.steps === three.steps, 'the same number of steps', `${one.steps} / ${three.steps}`);
  const r1 = one.results[0];
  const r3 = three.results[0];
  const w = worst(r1, r3);
  ok(w.err <= 1e-9, `every number of the stand's result within 1e-9 (${w.key} ${w.err.toExponential(2)})`, `${w.a} / ${w.b}`);
  near(r3.steady.force, r1.steady.force, 1e-9, `the steady force (${(r1.steady.force * 1e-3).toFixed(4)} kN)`);
  near(r3.thicknessOut, r1.thicknessOut, 1e-9, 'the thickness out');
  near(r3.widthOut, r1.widthOut, 1e-9, 'the width out');
  ok(r3.nFailed === r1.nFailed && r3.maxDamage === r1.maxDamage || Math.abs(r3.maxDamage - r1.maxDamage) <= 1e-9 * r1.maxDamage, 'the damage and the failed points', `${r1.maxDamage} / ${r3.maxDamage}, ${r1.nFailed} / ${r3.nFailed}`);
  ok(three.secs < one.secs, 'the team is faster', `${one.secs.toFixed(1)} s → ${three.secs.toFixed(1)} s`);
  const serial = await pass(P, 3, 1, 'done', true);
  const ws = worst(r1, serial.results[0]);
  ok(serial.results.length === 1 && ws.err <= 1e-9, `the team's serial mode is the thread alone as well (${ws.key} ${ws.err.toExponential(2)})`, `${ws.a} / ${ws.b}`);
}

// ── two stands, handoff 'steady', 1 against 2 threads
{
  const P = solidParams(base((p) => { p.rolling.lengthMode = 'steady'; }), { width: 1e-3, planeStrain: true });
  const one = await pass(P, 1, 2, 'steady');
  const two = await pass(P, 2, 2, 'steady');
  ok(one.results.length === 2 && two.results.length === 2 && one.stopped === null && two.stopped === null, 'both tandems run both stands', `${one.results.length} / ${two.results.length}, stopped ${one.stopped} / ${two.stopped}`);
  for (let k = 0; k < Math.min(one.results.length, two.results.length); k++) {
    const w = worst(one.results[k], two.results[k], 1);
    ok(w.err <= 1e-9, `stand #${k + 1}: every number within 1e-9 (${w.key} ${w.err.toExponential(2)})`, `${w.a} / ${w.b}`);
  }
}

// ── a Sim3 not made for the team
{
  const team = nodeTeam(2);
  let msg = '';
  try {
    await team.attach(new Sim3(solidParams(base(), { width: 1e-3 })));
  } catch (err) {
    msg = String(err.message);
  } finally {
    team.close();
  }
  ok(/team of 2/.test(msg), 'a Sim3 made alone is refused', msg);
}

done();
