// Rolls that follow the pass (src/mpm/solver.ts adjustRolls, docs/model.md「ロール偏平と圧下率一定」), 4 cells, L 20 mm
// (about 50 s):
// - Hitchcock's constant, and karmanFlattened's R' is Hitchcock's for its own force
// - rigid rolls and a fixed gap (the default, and the same written out): never 'adjusting', the rolls are the
//   params', and the sheet comes out thicker than h0 (1 − r) (what the constant reduction is for)
// - flattening 'hitchcock': the rolls settle, R' is Hitchcock's radius for the steady force the MPM computed
//   (the two are solved together), larger than R and near the slab method's coupled answer; the force is above
//   the rigid rolls'; settled rolls are held (R', the gap, no surface velocity)
// - gapControl 'reduction' (at 40 %, where the gap the rolls start from is not enough): the sheet's thickness in
//   the steady phase is h0 (1 − r) within 0.1 %, by a gap below it; no steady stretch for a tandem at the settling
// - a tandem with both: the entry thickness of stand 2 is stand 1's target (one thickness, by area, for the gap and
//   the handoff), its sheet starts before its flattened rolls' bite; both hold in its first stand, every stand gets its reduction on its own entry thickness, and a 'steady' handoff
//   takes only sheet that went through the settled rolls
// @check
import { ok, between, near, done } from './lib.mjs';
import { defaultParams, hitchcockC, hitchcockRadius } from '../../src/mpm/params.ts';
import { karman, karmanFlattened } from '../../src/mpm/slab.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { READ_STEPS, TandemSim, steadySample } from '../../src/mpm/tandem.ts';

const params = (rolling = {}) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 20e-3;
  Object.assign(P.rolling, rolling);
  return P;
};

/** one pass: the steady means (force by steps, the thickness at the exit probe every 500 steps), the phases seen, the rolls at the end */
function pass(P) {
  const sim = new Sim(P);
  const phases = new Set();
  let F = 0;
  let nF = 0;
  let H = 0;
  let nH = 0;
  let movedAfterSettle = false;
  let held = null;
  // the steady stretch a tandem would hand on, past what went through the settled rolls [m] (≤ 0: none of it), and how often there was one
  let over = -Infinity;
  let samples = 0;
  while (sim.phase() !== 'done' && sim.step < 60000) {
    for (let k = 0; k < 100; k++) sim.advance();
    const w = sim.readWindow();
    const ph = sim.phase();
    phases.add(ph);
    if (sim.rollsSettled && sim.rollsAdjusted) {
      const now = [sim.rolls[0].R, sim.gap, sim.rolls[0].vR ?? 0, sim.rolls[0].vcy ?? 0];
      const sample = ph === 'steady' ? steadySample(sim) : null;
      if (sample) {
        let x = 0;
        for (let j = 0; j < sim.NJ; j++) x += sim.px[sim.lattice[sample[1] * sim.NJ + j]];
        over = Math.max(over, x / sim.NJ - sim.settledLength());
        samples++;
      }
      held ??= now;
      if (now.some((v, i) => v !== held[i]) || now[2] !== 0 || now[3] !== 0) movedAfterSettle = true;
    }
    if (ph !== 'steady') continue;
    F += w.force * w.steps;
    nF += w.steps;
    if (sim.step % 500 === 0) {
      // the gauge's band for every pass (a whole period of the point columns; the adjusted rolls' default)
      const ex = sim.exitMeasure(sim.xExitProbe, (2.2 * sim.dp) / (1 - P.rolling.reduction));
      if (ex) {
        H += ex.thickness;
        nH++;
      }
    }
  }
  return { sim, phases, force: F / nF, exit: H / nH, movedAfterSettle, over, samples };
}

const r0 = defaultParams().rolling;
near(hitchcockC(r0), 2.2498e-11, 1e-4, "Hitchcock's C = 16 (1 − ν²) / (π E) for the steel roll (E 206 GPa, ν 0.3) [1/Pa]");
near(hitchcockC({ ...r0, rollE: 550e9 }), (2.2498e-11 * 206) / 550, 1e-4, 'C goes as 1 / E (a carbide roll, 550 GPa)');
const coupled = karmanFlattened(r0, defaultParams().material);
const rigidSlab = karman(r0, defaultParams().material);
near(coupled.rollRadius, hitchcockRadius(r0, coupled.slab.force, r0.h0 * r0.reduction), 1e-8, "karmanFlattened: R' is Hitchcock's radius for its own force");
ok(coupled.rollRadius > 1.2 * r0.rollRadius && coupled.slab.force > 1.1 * rigidSlab.force, 'the slab method with flattened rolls: a larger radius and a larger force', `R' ${(coupled.rollRadius * 1e3).toFixed(2)} mm, ${(coupled.slab.force * 1e-6).toFixed(3)} against ${(rigidSlab.force * 1e-6).toFixed(3)} kN/mm`);

const target = r0.h0 * (1 - r0.reduction);

// ── rigid rolls, a fixed gap
const rigid = pass(params());
{
  const written = pass(params({ flattening: 'none', gapControl: 'gap' }));
  ok(!rigid.sim.rollsAdjusted && !rigid.phases.has('adjusting') && rigid.sim.rolls[0].R === r0.rollRadius && rigid.sim.gap === target, "the default: rigid rolls at the params' radius and gap, never 'adjusting'");
  ok(written.force === rigid.force && written.exit === rigid.exit && written.sim.step === rigid.sim.step, "flattening 'none' and gapControl 'gap' written out are the default, bit for bit");
  between(rigid.exit / target, 1.001, 1.01, 'with a fixed gap the sheet comes out thicker than h0 (1 − r): the elastic recovery');
}

// ── Hitchcock
{
  const f = pass(params({ flattening: 'hitchcock' }));
  const R = f.sim.rolls[0].R;
  ok(f.phases.has('adjusting') && f.sim.rollsSettled && f.phases.has('steady'), "flattening 'hitchcock': 'adjusting', then settled and 'steady'");
  near(R, hitchcockRadius(r0, f.force, r0.h0 - f.sim.gap), 5e-3, "R' is Hitchcock's radius for the steady force the MPM computed");
  between(R / coupled.rollRadius, 1.0, 1.04, "R' over the slab method's coupled R' (the MPM's force is the larger)");
  between(f.force / rigid.force, 1.1, 1.3, 'the force with flattened rolls over the rigid rolls');
  ok(f.sim.gap === target, 'the gap is not touched');
  ok(!f.movedAfterSettle, "settled rolls are held: R', the gap, no surface velocity");
  ok(f.samples > 0 && f.over <= 0, "a tandem's steady stretch is never sheet that went through rolls that still moved", `${f.samples} stretches, the furthest ${(f.over * 1e3).toFixed(2)} mm past the settled rolls' sheet`);
  near(f.sim.contactLength, Math.sqrt(R * (r0.h0 - f.sim.gap) - (r0.h0 - f.sim.gap) ** 2 / 4), 1e-12, "the contact length is R''s");
}

// ── constant reduction, at 40 %: the gap the rolls start from (presetRolls) is 0.1 % off there, and with the
// gap's integration cut the thickness never gets within CTL_TOL_H (no 'steady' phase at all)
{
  const c = pass(params({ gapControl: 'reduction', reduction: 0.4 }));
  const h1 = r0.h0 * 0.6;
  ok(c.phases.has('adjusting') && c.sim.rollsSettled && c.phases.has('steady') && c.sim.rolls[0].R === r0.rollRadius, "gapControl 'reduction': 'adjusting', then settled and 'steady', the radius not touched");
  // the control holds the mean within CTL_TOL_H (0.05 %) and the thickness now within four times that: 0.078 % and 0.123 % measured
  near(c.exit, h1, 2e-3, 'the sheet comes out at h0 (1 − r)');
  between(c.sim.gap / h1, 0.99, 0.999, 'by a gap below h0 (1 − r)');
  ok(!c.movedAfterSettle, 'settled rolls are held');
}

// ── a tandem with both (its first stand is the single pass with both)
{
  const P = params({ flattening: 'hitchcock', gapControl: 'reduction', sheetLength: 24e-3 });
  const t = new TandemSim(P, 2, READ_STEPS, 'steady');
  const ends = [];
  t.onStandDone = (e) => {
    const sample = e.result.phase === 'steady' ? steadySample(e.sim) : null;
    let xLast = NaN;
    if (sample) {
      let s = 0;
      for (let j = 0; j < e.sim.NJ; j++) s += e.sim.px[e.sim.lattice[sample[1] * e.sim.NJ + j]];
      xLast = s / e.sim.NJ;
    }
    // the next stand as it starts: its rolls (from the slab method with the strain brought in) and where its sheet lies
    const start = e.next && { R: e.next.rolls[0].R, head: e.next.headX(), h: e.next.h, Lc: e.next.contactLength, phase: e.next.phase(), ep0: e.next.params.rolling.entryStrain };
    ends.push({ ...e, xLast, rolledSettled: e.sim.settledLength(), start });
  };
  while (!t.done) t.advance();
  const [a, b] = ends;
  ok(a.result.phase === 'steady' && a.result.rollsSettled, 'stand 1 hands on while steady, its rolls settled', `step ${a.result.steps}`);
  ok(a.xLast <= a.rolledSettled, 'the stretch it hands on went through the settled rolls', `to x ${(a.xLast * 1e3).toFixed(2)} mm, ${(a.rolledSettled * 1e3).toFixed(2)} mm rolled since`);
  near(a.result.exitThickness, a.result.h0 * (1 - r0.reduction), 1.5e-3, "stand 1's sheet at its reduction");
  near(a.result.rollRadius, hitchcockRadius(r0, a.result.steadyForce, r0.h0 - a.result.gap), 5e-3, "and its R' is Hitchcock's for its steady force");
  // the thickness the gap is held on is the one handed on (by area): the chain is h0 (1 − r)^k. With the gauge on the
  // points' edges stand 2 came in 0.37 % thinner than stand 1's sheet was held at, and every stand's reduction was off
  near(b.result.h0, a.result.h0 * (1 - r0.reduction), 1e-3, "stand 2's entry thickness is stand 1's target");
  ok(a.start.phase === 'approach' && a.start.head < -a.start.Lc - 0.4 * a.start.h && a.start.R > 1.4 * r0.rollRadius && a.start.ep0 > 0.3, "stand 2's sheet starts before the bite of its flattened rolls, which start from the strain brought in", `R' ${(a.start.R * 1e3).toFixed(1)} mm, εp ${a.start.ep0.toFixed(3)}, head ${(a.start.head * 1e3).toFixed(2)} mm, Lc ${(a.start.Lc * 1e3).toFixed(2)} mm`);
  between(b.result.rollRadius / a.start.R, 0.97, 1.03, "and end within 3 % of where they started");
  ok(b.result.rollsSettled && b.result.steadyForce > 0, 'stand 2 settles too and has steady readings');
  near(b.result.exitThickness, b.result.h0 * (1 - r0.reduction), 1.5e-3, "stand 2's sheet at its reduction of its own entry thickness");
  ok(b.result.rollRadius > a.result.rollRadius, "stand 2's R' is the larger (a harder sheet, a smaller draft)", `${(a.result.rollRadius * 1e3).toFixed(1)} → ${(b.result.rollRadius * 1e3).toFixed(1)} mm`);
}

done();
