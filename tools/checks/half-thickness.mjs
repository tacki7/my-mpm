// The half-thickness section model (rolling.halfThickness, docs/model.md「板厚方向の対称モデル（2 次元）」): the top half
// of the sheet on a grid whose row iy = 1 is the mid-plane, the ghost row under it folded onto its mirror image, the
// top roll alone. About 25 s:
// - with an even number of cells the half grid is the top half of the whole grid and the points coincide, so the
//   steady force, torque, exit thickness, forward slip and neutral point agree with the whole model to rounding
//   (measured 6e-13 to 1e-11 relative on the default pass at 6 cells, 8 mm, 2026-09-23: the whole model's mean of
//   two rolls and its tie-break on the plane are the only differences); the bound is 1e-9
// - it is faster (half the points: 1.86× here)
// - central-burst with 'dfg' (8 cells, band ductility 1/100, as crack-fields.mjs): the cracks start on the plane and
//   their faces carry no tension on average (σyy just above the failed points: mean ≤ 30 MPa, none over 120 MPa; the
//   single field carries a mean over 100 MPa), and the failed points end up squeezed (a closed crack, as the whole
//   model's pair is)
// - a two-stand tandem in the half model keeps the mass to 1e-12 and hands the whole thickness on (the next stand's h0
//   is the thickness that came out, 2 × the half's area, and its sheet has the half's mass)
// - the whole model is untouched: the default 6-cell 8-mm pass's steady force is what it was before the option
//   existed (3.239085928983561 kN/mm, node 24, 2026-09-23), to 1e-12
// Calibrated on copies (2026-09-23): with the ghost row not folded (foldGhosts skipped) the force is 4.7 % off, the
// slip 30 % off and the faces carry 92 MPa on average (8 items fail); without the tie-break on the plane's nodes
// (assignFields) a face carries 138 MPa (the largest-face item fails).
// @check
import { ok, near, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { TandemSim } from '../../src/mpm/tandem.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';

// the default pass as tools/run.mjs --cells 6 --L 8 reads it (diagnostics every 2000 steps, the steady means)
function pass(half) {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  if (half) P.rolling.halfThickness = true;
  const t0 = performance.now();
  const s = new Sim(P);
  const steady = [];
  let d;
  do {
    for (let k = 0; k < 2000; k++) s.advance();
    d = s.diagnostics();
    if (d.phase === 'steady') steady.push(d);
  } while (d.phase !== 'done' && d.phase !== 'stalled' && s.step < 400000);
  const secs = (performance.now() - t0) / 1000;
  const mean = (f) => steady.map(f).filter((v) => v != null).reduce((a, v) => a + v, 0) / Math.max(1, steady.filter((h) => f(h) != null).length);
  return {
    s,
    secs,
    phase: d.phase,
    reads: steady.length,
    force: mean((h) => h.rollForce),
    torque: mean((h) => h.rollTorque),
    thickness: mean((h) => h.exitThickness),
    slip: mean((h) => h.forwardSlip),
    neutral: mean((h) => h.neutralX),
  };
}

// ── the whole model, untouched; the half model agrees with it and is faster
{
  const whole = pass(false);
  const half = pass(true);
  near(whole.force * 1e-6, 3.239085928983561, 1e-12, 'the whole model: the steady force of the default 6-cell 8-mm pass is what it was [kN/mm]');
  ok(half.s.half && half.s.rolls.length === 1 && half.s.NJ === whole.s.NJ / 2 && half.s.n === whole.s.n / 2, 'half: one roll, half the rows and points', `${half.s.n} of ${whole.s.n} points`);
  ok(whole.phase === 'done' && half.phase === 'done' && whole.reads === half.reads && whole.reads >= 1, 'both passes run to the end with the same steady reads', `${half.reads} reads`);
  near(half.force, whole.force, 1e-9, 'half: the steady roll force agrees with the whole model [N/m]');
  near(half.torque, whole.torque, 1e-9, 'half: the steady torque agrees [N·m/m]');
  near(half.thickness, whole.thickness, 1e-9, 'half: the exit thickness (2 × the top half) agrees [m]');
  near(half.slip, whole.slip, 1e-9, 'half: the forward slip agrees');
  near(half.neutral, whole.neutral, 1e-9, 'half: the neutral point agrees [m]');
  between(half.secs / whole.secs, 0, 0.8, `half: faster (half's ${half.secs.toFixed(2)} s over the whole's ${whole.secs.toFixed(2)} s)`);
  // the whole sheet's plastic work and the kinetic ratio read alike
  const dw = whole.s.diagnostics();
  const dh = half.s.diagnostics();
  near(dh.plasticWork, dw.plasticWork, 1e-9, 'half: the plastic work reported is the whole sheet’s [J/m]');
}

// ── central-burst cracks on the plane: 'dfg' opens them
{
  // σyy at the point right above the highest failed point of each cracked column (the face on this side of the plane)
  const faceSyy = (sim) => {
    const { NI, NJ, lattice } = sim;
    const out = [];
    for (let i = 0; i < NI; i++) {
      let hi = -1;
      for (let j = 0; j < NJ; j++) {
        const q = lattice[i * NJ + j];
        if (q >= 0 && sim.failed[q]) hi = j;
      }
      if (hi < 0 || hi === NJ - 1) continue;
      const q = lattice[i * NJ + hi + 1];
      if (q >= 0 && !sim.failed[q]) out.push(sim.syy[q] - sim.pres[q]);
    }
    return out;
  };
  const burst = (mode) => {
    const P = presetById('central-burst').build();
    P.numerics.cellsThrough = 8;
    P.defects[0].ductility = 0.01;
    P.numerics.crackFields = mode;
    P.rolling.halfThickness = true;
    const s = new Sim(P);
    let contacts = 0;
    while (s.phase() !== 'done' && s.step < 100000) {
      s.advance();
      contacts += s.fieldContacts;
    }
    const f = faceSyy(s);
    // where the cracks began: the lattice row of their first point (0 is the row on the plane)
    const rows = s.cracks.map((c) => Math.round(c.sheetY / s.dp - 0.5));
    return { s, f, mean: f.reduce((a, b) => a + b, 0) / Math.max(1, f.length), max: Math.max(...f), contacts, rows };
  };
  const one = burst('none');
  const two = burst('dfg');
  ok(one.s.cracks.length >= 2 && one.rows.every((r) => r === 0), 'half, central-burst: the cracks start on the plane (lattice row 0)', `${one.s.cracks.length} cracks, rows ${one.rows.join(' ')}`);
  ok(one.f.length >= 4 && one.mean > 100e6, 'half, single field: tension across the faces (the case the next items check)', `${one.f.length} face points, mean ${(one.mean * 1e-6).toFixed(0)} MPa, max ${(one.max * 1e-6).toFixed(0)} MPa`);
  ok(two.s.cracks.length >= 2 && two.rows.every((r) => r === 0) && two.f.length >= 4, "half, 'dfg': cracks on the plane with faces", `${two.s.cracks.length} cracks, ${two.f.length} face points`);
  // measured 2026-09-23: 5 faces, mean 12 MPa, max 91 MPa (the last crack's, still in the transient a crack's face
  // carries for about 1000 steps); the whole model's faces are −64 to 25 MPa (crack-fields.mjs). The single field
  // carries a mean of 177 MPa
  between(two.mean * 1e-6, -300, 30, "half, 'dfg': the mean σyy across the faces [MPa] (no tension carried on average)");
  between(two.max * 1e-6, -1000, 120, "half, 'dfg': the largest σyy across the faces [MPa]");
  ok(two.contacts > 0, "half, 'dfg': the two fields met at the plane's mirror nodes", `${two.contacts} node-steps in contact`);
  // the crack's failed point is closed and squeezed at the end (the whole model's pair is), not dilated (a failed
  // point torn along x, as before the tie-break on the plane's nodes: J > 1 and no pressure)
  const failedP = [];
  for (let p = 0; p < two.s.n; p++) if (two.s.failed[p] && two.s.active[p]) failedP.push(two.s.pres[p] * 1e-6);
  between(Math.max(...failedP), 20, 2000, "half, 'dfg': the failed points are under pressure at the end (a closed crack) [MPa]");
}

// ── a two-stand tandem in the half model
{
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.rolling.halfThickness = true;
  const t = new TandemSim(P, 2);
  const first = t.sim;
  let massFirst = 0;
  for (let p = 0; p < first.n; p++) massFirst += first.mass[p];
  while (!t.done && t.stepOffset + t.sim.step < 400000) t.advance();
  const r = t.results;
  ok(t.done && r.length === 2 && t.stopped === null, 'half, 2 stands: both stands ran to the end', `${r.length} results, stopped ${t.stopped}`);
  const second = t.sim;
  let massSecond = 0;
  for (let p = 0; p < second.n; p++) massSecond += second.mass[p];
  ok(second.half && second.rolls.length === 1, 'half, 2 stands: the second stand is a half model too');
  near(massSecond, massFirst, 1e-12, 'half, 2 stands: the mass is handed on [kg/m]');
  near(second.params.rolling.h0, r[0].thicknessOut, 1e-12, "half, 2 stands: the second stand's entry thickness is the first's exit thickness [m]");
  between(r[0].thicknessOut / P.rolling.h0, 0.7, 0.8, 'half, 2 stands: the thickness handed on is the whole sheet’s (h0 × about 1 − r)');
  ok(r[0].exitThickness === null || Math.abs(r[0].exitThickness / r[0].thicknessOut - 1) < 0.01, "half, 2 stands: the exit gauge's thickness (when read) agrees with the area's", `${r[0].exitThickness} vs ${r[0].thicknessOut}`);
  // the second stand's sheet, as it ended: the top half of its exit thickness (the top row's centres half a spacing
  // below h2 / 2), nothing below the plane
  const hi = second.py.reduce((m, y, p) => (second.active[p] ? Math.max(m, y) : m), 0);
  const lo = second.py.reduce((m, y, p) => (second.active[p] ? Math.min(m, y) : m), Infinity);
  between(2 * hi, 0.8 * r[1].thicknessOut, r[1].thicknessOut, "half, 2 stands: the second stand's sheet lies in y ∈ [0, h / 2] (its top, 2 × the highest centre against its exit thickness) [m]");
  between(lo, 0, 0.1 * second.params.rolling.h0, 'the same: its bottom [m]');
}

done();
