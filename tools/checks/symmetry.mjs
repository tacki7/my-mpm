// The thickness-symmetry mode (numerics.symmetry) solves the upper half of the sheet with y = 0 a
// symmetry plane, and must give the same pass as the full section (docs/model.md「板厚方向の対称モード」).
//
// The standard pass at 6 cells, 8 mm long, run both ways (about 20 s): the steady roll force, the exit
// thickness and the neutral point agree to 0.2 % and the largest damage to 1e-9, and the half section
// keeps its invariants — one roll, no point below the plane, no v_y on the plane's node row, and no
// point inside where the mirrored (bottom) roll would be.
//
// The two folds the mode cannot do without are what this pins: without the ghost rows being cleared
// every step, the stale velocities there are folded back in as momentum and the pass blows up within a
// few steps; without the normalised J-bar sums being written back to the ghosts, pass 2 reads the raw
// sums there. Both show up as a force far outside 0.2 % (see the report of T72 for the measured values).
// The third is the reading: the force and the torque are already a mean over the two rolls, so the half
// section takes the top roll's as they are and must not double them.
// @check
import { ok, near, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { symmetryUnavailable } from '../../src/mpm/symmetry.ts';

const EVERY = 2000;

function baseParams() {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  return P;
}

/** one pass; `bad` collects the broken invariants of the half section (checked every 500 steps) */
function run(symmetry) {
  const P = baseParams();
  P.numerics.symmetry = symmetry;
  const sim = new Sim(P);
  const bad = [];
  const steady = [];
  let d;
  // where the bottom roll would be: the mirror of the top one
  const top = sim.rolls[0];
  while (sim.step < 400000) {
    for (let k = 0; k < EVERY; k++) {
      sim.advance();
      if (symmetry && sim.step % 500 === 0) invariants(sim, top, bad);
    }
    d = sim.diagnostics();
    if (d.phase === 'steady') steady.push(d);
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  const mean = (f) => steady.map(f).filter((v) => v != null).reduce((s, v, _, a) => s + v / a.length, 0);
  return {
    force: mean((h) => h.rollForce),
    thickness: mean((h) => h.exitThickness),
    neutral: mean((h) => h.neutralX),
    maxDamage: d.maxDamage,
    n: sim.n,
    rolls: sim.rolls.length,
    steady: steady.length,
    bad,
  };
}

function invariants(sim, top, bad) {
  if (bad.length >= 3) return;
  const { n, active, px, py, gvy, nyN, nxN, kSym, dp, f01, f11 } = sim;
  for (let p = 0; p < n; p++) {
    if (!active[p]) continue;
    if (py[p] < 0) {
      bad.push(`step ${sim.step}: point ${p} is below the plane (y = ${py[p]})`);
      break;
    }
    // the mirrored roll sits at (top.cx, −top.cy): the point's edge must stay outside it
    const rp = 0.5 * dp * Math.hypot(f01[p], f11[p]);
    if (Math.hypot(px[p] - top.cx, py[p] + top.cy) - top.R - rp < 0) {
      bad.push(`step ${sim.step}: point ${p} is inside the mirrored roll`);
      break;
    }
  }
  for (let i = 0; i < nxN; i++) {
    if (gvy[i * nyN + kSym] !== 0) {
      bad.push(`step ${sim.step}: v_y ${gvy[i * nyN + kSym]} on the plane's node row, column ${i}`);
      break;
    }
  }
}

const full = run(false);
const half = run(true);

ok(half.rolls === 1 && full.rolls === 2, 'the half section carries one roll, the full section two', `${half.rolls} / ${full.rolls}`);
ok(half.n === full.n / 2, 'the half section has half the points', `${half.n} of ${full.n}`);
ok(half.steady > 0 && full.steady > 0, 'both passes reach the steady phase', `${half.steady} / ${full.steady} reads`);
ok(half.bad.length === 0, 'the half section keeps its invariants', half.bad.join('; ') || 'none broken');
near(half.force, full.force, 2e-3, 'steady roll force');
near(half.thickness, full.thickness, 2e-3, 'exit thickness');
near(half.neutral, full.neutral, 2e-3, 'neutral point');
near(half.maxDamage, full.maxDamage, 1e-9, 'largest damage');

ok(symmetryUnavailable(baseParams()) === null, 'the standard pass can be folded');
const odd = baseParams();
odd.numerics.cellsThrough = 5;
odd.numerics.ppc = 1;
ok(/even/.test(symmetryUnavailable(odd) ?? ''), 'an odd number of point rows is refused', symmetryUnavailable(odd) ?? 'accepted');
const off = baseParams();
off.defects = [{ kind: 'void', x: 4e-3, y: 0.2e-3, ax: 0.1e-3, ay: 0.1e-3 }];
ok(/mid-plane/.test(symmetryUnavailable(off) ?? ''), 'a defect off the mid-plane is refused', symmetryUnavailable(off) ?? 'accepted');
const dfg = baseParams();
dfg.numerics.crackFields = 'dfg';
ok(/dfg/.test(symmetryUnavailable(dfg) ?? ''), 'the crack faces are refused', symmetryUnavailable(dfg) ?? 'accepted');
const nl = baseParams();
nl.damage.nonlocalLength = 1e-3;
ok(/nonlocal/.test(symmetryUnavailable(nl) ?? ''), 'the nonlocal average is refused', symmetryUnavailable(nl) ?? 'accepted');
// the guard is what the constructor uses: an impossible condition must not run silently
let threw = '';
try {
  new Sim({ ...off, numerics: { ...off.numerics, symmetry: true } });
} catch (e) {
  threw = String(e.message ?? e);
}
ok(/mid-plane/.test(threw), 'the constructor refuses a condition that cannot be folded', threw || 'it built a Sim');
done();
