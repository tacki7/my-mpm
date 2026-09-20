// The edge's ductility scatter (`plan.edgeScatter`, docs/model.md「端の延性のばらつき」): a seeded,
// reproducible unevenness of the ductility in a band along each edge. It is off by default, and
// this check pins the three things that lets it be trusted as a condition:
//   - amount 0 (the default) leaves the strip bit-identical to the one every earlier run had
//   - the same seed draws the same strip twice, a different seed a different one
//   - with it on, the one long edge crack of a uniform edge breaks into several short ones apart
//     from each other — the reason the condition exists (docs/validation.md「端の延性のばらつき」)
// The last one is read at C = 0.13 (1 crack uniform → 3 scattered), not at the C = 0.15 of the
// stage-1 design note: at 0.15 a uniform edge reaches dCL 0.99 and whether it cracks turns on the
// last per cent, which is no basis for a gate.
// @check
import { createHash } from 'node:crypto';
import { ok, done } from './lib.mjs';
import { PlanSim } from '../../src/mpm/planview/sim.ts';
import { PLAN_DEFAULTS, planCondition } from '../../src/mpm/planview/condition.ts';
import { SAMPLE_STEPS, SteadySampler } from '../../src/mpm/planview/steady.ts';
import { defaultParams } from '../../src/mpm/params.ts';

/** 20 % of the ductility over a 1 mm band, one value per 1 mm of strip: the stage-1 setting */
const SCATTER = { edgeAmount: 0.2, edgeWidth: 1e-3, edgeLength: 1e-3, edgeSeed: 1 };

function condition({ W, cells, L, cl }, over = {}) {
  const base = defaultParams();
  base.rolling.sheetLength = L;
  base.damage.model = 'cockcroft-latham';
  base.damage.clCrit = cl;
  return planCondition(base, { ...PLAN_DEFAULTS, width: W, cells, notch: 0, ...over });
}

/** every array the scatter can reach: the drawn ductility, the points' state, and what has cracked */
function fingerprint(s) {
  const h = createHash('sha1');
  for (const a of [s.duct, s.px, s.pz, s.vx, s.vz, s.crackId]) {
    h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }
  return h.digest('hex').slice(0, 12);
}

// ── the cheap runs: a 10 mm strip carried a few hundred steps into the bite. The ductility is in
//    the fingerprint, so a seed that did not reach the points would show up here even before any
//    point has failed.
const SMALL = { W: 10e-3, cells: 10, L: 8e-3, cl: 0.13 };
function shortRun(over) {
  const P = condition(SMALL, over);
  const s = new PlanSim(P);
  while (s.step < 400) s.advance();
  return fingerprint(s);
}

const before = (() => {
  const P = condition(SMALL);
  delete P.plan.edgeScatter;
  const s = new PlanSim(P);
  while (s.step < 400) s.advance();
  return fingerprint(s);
})();
const off = shortRun({});
ok(off === before, 'amount 0 (the default) is bit-identical to no edgeScatter at all', `${off} vs ${before}`);

const seed1 = shortRun(SCATTER);
const seed1again = shortRun(SCATTER);
const seed2 = shortRun({ ...SCATTER, edgeSeed: 2 });
ok(seed1 === seed1again, 'the same seed draws the same strip twice', `${seed1} then ${seed1again}`);
ok(seed1 !== seed2, 'a different seed draws a different strip', `seed 1 ${seed1}, seed 2 ${seed2}`);
ok(seed1 !== off, 'the scatter reaches the points at all', `on ${seed1}, off ${off}`);

// ── the runs that crack: a 20 mm strip to the end of the steady window, the way tools/planview.mjs
//    runs it. A uniform edge at C = 0.13 cracks once; the scatter breaks that into three.
const WIDE = { W: 20e-3, cells: 16, L: 16e-3, cl: 0.13 };
function cracksOf(over) {
  const s = new PlanSim(condition(WIDE, over));
  const sampler = new SteadySampler();
  while (s.step < 40000) {
    for (let k = 0; k < SAMPLE_STEPS; k++) s.advance();
    if (sampler.look(s) === 'done') break;
  }
  return s.cracks.map((c) => ({ step: c.step, x: c.sheetX * 1e3, z: c.sheetZ * 1e3, n: c.count }));
}
const where = (cs) => cs.map((c) => `step ${c.step}, ${c.x.toFixed(2)} mm from the head, ${c.n} points`).join('; ') || 'none';

const uniform = cracksOf({});
ok(uniform.length === 1, 'a uniform edge at C = 0.13 cracks once', where(uniform));

const scattered = cracksOf(SCATTER);
ok(scattered.length >= 3, 'the scatter breaks that one crack into three or more', where(scattered));
const gaps = scattered.slice(1).map((c, i) => Math.abs(c.x - scattered[i].x));
ok(gaps.length > 0 && Math.min(...gaps) >= 1, 'and they sit apart along the strip, not in one band', `gaps ${gaps.map((g) => g.toFixed(2)).join(', ')} mm`);

const other = cracksOf({ ...SCATTER, edgeSeed: 2 });
const same = other.length === scattered.length && other.every((c, i) => Math.abs(c.x - scattered[i].x) < 0.01);
ok(!same, 'another seed cracks elsewhere', `seed 1: ${where(scattered)} | seed 2: ${where(other)}`);

done();
