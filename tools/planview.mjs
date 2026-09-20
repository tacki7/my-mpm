// Run the plan-view model (src/mpm/planview/sim.ts) once and print what it says about the
// width: the roll force per unit width in the middle and at the edge, the spread against
// Wusatowski's formula, σxx across the width in the bite and in the rolled strip, the
// pressure differences between neighbouring points in the bite, and the cracks. Not a
// gate check (a 100 mm wide strip takes a few minutes).
//
//   node tools/planview.mjs [--W 20] [--cells 20] [--L 28] [--gap 8] [--h0 1] [--r 0.25] [--R 100]
//                           [--mu 0.08] [--ms 10000] [--cfl 0.4] [--tb 0] [--tf 0]
//                           [--damage none|johnson-cook|hancock-mackenzie|cockcroft-latham] [--cl 0.6]
//                           [--notch <radius mm>] [--crack none|dfg] [--nojbar] [--max 4000000] [--json]
//                           [--escatter <%>] [--ewidth <mm>] [--elen <mm>] [--eseed <n>]
//
// Lengths in mm, tensions in MPa; --W is the full width, --cells the grid cells across the
// half width. --notch cuts a semicircular notch of that radius into the edge half-way along
// the strip. --crack dfg splits the points near a crack into two velocity fields (docs/model.md
// 「亀裂の面」). --nojbar turns the volume averaging off and runs the volumes point by point, as the plan view did
// before T63 (docs/model.md「体積の平均化」); 'total' has no meaning here and smooths the rate like 'rate'. Steady values are means over the samples (every 250 steps) in the steady phase while
// the head is at least a gap past the exit and the tail at least a gap before the entry: the gap is
// 8 mm or the half width, whichever is more (--gap sets it): the middle's load settles only a half
// width past the exit and falls again within about a half width of the entry. A strip too short for
// the window has no samples (lengthen it with --L to twice the gap and 8 mm).
import { PlanSim } from '../src/mpm/planview/sim.ts';
import { PLAN_DEFAULTS, planCondition } from '../src/mpm/planview/condition.ts';
import { SAMPLE_STEPS, SteadySampler, steadyGap, steadyLength } from '../src/mpm/planview/steady.ts';
import { defaultParams } from '../src/mpm/params.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const json = args.includes('--json');
const say = (s) => { if (!json) console.log(s); };

const base = defaultParams();
const r = base.rolling;
r.h0 = +opt('h0', 1) * 1e-3;
r.reduction = +opt('r', r.reduction);
r.rollRadius = +opt('R', 100) * 1e-3;
r.sheetLength = +opt('L', 28) * 1e-3;
const gapOpt = opt('gap', null);
const gapGiven = gapOpt === null ? null : +gapOpt * 1e-3;
const maxSteps = +opt('max', 4e6);
r.mu = +opt('mu', r.mu);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
base.numerics.massScale = +opt('ms', base.numerics.massScale);
base.numerics.cfl = +opt('cfl', base.numerics.cfl);
base.damage.model = opt('damage', 'none');
base.damage.clCrit = +opt('cl', base.damage.clCrit);
if (args.includes('--nojbar')) base.numerics.jbar = false;
const crack = opt('crack', 'none');
if (crack !== 'none' && crack !== 'dfg') throw new Error(`--crack ${crack}: none or dfg`);
base.numerics.crackFields = crack;
const W = +opt('W', 20) * 1e-3;
const notch = +opt('notch', 0) * 1e-3;
const P = planCondition(base, {
  ...PLAN_DEFAULTS,
  width: W,
  cells: +opt('cells', 20),
  notch,
  edgeAmount: +opt('escatter', 0) / 100,
  edgeWidth: +opt('ewidth', PLAN_DEFAULTS.edgeWidth * 1e3) * 1e-3,
  edgeLength: +opt('elen', PLAN_DEFAULTS.edgeLength * 1e3) * 1e-3,
  edgeSeed: +opt('eseed', PLAN_DEFAULTS.edgeSeed),
});
const sc = P.plan.edgeScatter;
const sim = new PlanSim(P);
say(`volumes ${sim.averaged ? "smoothed over the grid (the plan view's only scheme; 'total' smooths too)" : 'point by point (J-bar off)'}`);
if (sc.amount > 0) say(`edge scatter: ductility ×(1 − ${(sc.amount * 100).toFixed(0)} % · u) within ${(sc.width * 1e3).toFixed(2)} mm of each edge, one value per ${sc.length > 0 ? `${(sc.length * 1e3).toFixed(2)} mm` : 'point'}, seed ${sc.seed}`);
say(`plan view: W ${(W * 1e3).toFixed(1)} mm (W/h0 ${(W / r.h0).toFixed(0)}), ${sim.n} points, h ${(sim.h * 1e3).toFixed(3)} mm, dt ${sim.dt.toExponential(3)} s`);

// Wusatowski (1955): W1/W0 = (h1/h0)^(−w), w = 10^(−1.269 (W0/h0) (h0/D)^0.556), D the roll diameter
const wus = Math.pow(1 - r.reduction, -Math.pow(10, -1.269 * (W / r.h0) * Math.pow(r.h0 / (2 * r.rollRadius), 0.556))) - 1;

const t0 = performance.now();
// the steady looks, read the same way as the page does (src/mpm/planview/steady.ts)
const sampler = new SteadySampler(gapGiven);
const gap = gapGiven ?? steadyGap(sim.halfWidth0);
while (sim.step < maxSteps) {
  for (let k = 0; k < SAMPLE_STEPS; k++) sim.advance();
  if (sampler.look(sim) === 'done') break;
}
const secs = (performance.now() - t0) / 1000;
const m = sampler.means(sim.halfWidth0);
const out = {
  W_mm: W * 1e3,
  cells: P.plan.cellsHalfWidth,
  points: sim.n,
  secs,
  steps: sim.step,
  steadySamples: m.samples,
  steadyLooks: m.looks,
  gap_mm: gap * 1e3,
  forceHalfWidth_kN: m.forceHalfWidth * 1e-3,
  forcePerWidthMid_kN_per_mm: m.samples ? m.forcePerWidthByZ[0] * 1e-6 : NaN,
  forcePerWidthByZ_kN_per_mm: m.forcePerWidthByZ.map((v) => v * 1e-6),
  forcePerWidthByColumn_kN_per_mm: m.forcePerWidthByColumn.map((v) => v * 1e-6),
  spread: m.spread,
  spreadWusatowski: wus,
  centreExitThickness_mm: m.centreExitThickness * 1e3,
  sxxBite_MPa: m.sxxBite.map((v) => v * 1e-6),
  sxxPast_MPa: m.sxxPast.map((v) => v * 1e-6),
  pressureMean_MPa: m.pressureMean * 1e-6,
  pressureJumpMax_MPa: m.pressureJumpMax * 1e-6,
  pressureJumpP95_MPa: m.pressureJumpP95 * 1e-6,
  edgeScatter: sc.amount > 0 ? { amount: sc.amount, width_mm: sc.width * 1e3, length_mm: sc.length * 1e3, seed: sc.seed } : null,
  cracks: sim.cracks.map((c) => {
    let xs = [Infinity, -Infinity];
    let zs = [Infinity, -Infinity];
    for (let p = 0; p < sim.n; p++) if (sim.crackId[p] === c.id) {
      const sx = sim.xHead0 - sim.x0[p];
      xs = [Math.min(xs[0], sx), Math.max(xs[1], sx)];
      zs = [Math.min(zs[0], sim.z0[p]), Math.max(zs[1], sim.z0[p])];
    }
    return { step: c.step, x_mm: c.x * 1e3, z_mm: c.z * 1e3, fromHead_mm: c.sheetX * 1e3, fromMid_mm: c.sheetZ * 1e3, eta: c.eta, count: c.count, alongX_mm: (xs[1] - xs[0]) * 1e3, acrossZ_mm: (zs[1] - zs[0]) * 1e3 };
  }),
};
if (json) console.log(JSON.stringify(out));
else {
  const f = (a, d = 0) => a.map((v) => v.toFixed(d).padStart(6)).join('');
  say(`${m.samples} of ${m.looks} steady samples (the head ≥ ${(gap * 1e3).toFixed(0)} mm past the exit and the tail as far before the entry), ${sim.step} steps, ${secs.toFixed(1)} s`);
  if (!m.samples) say(`no steady sample: lengthen the strip (--L) to ${(steadyLength(sim.halfWidth0) * 1e3).toFixed(0)} mm or more (twice the gap and 8 mm)`);
  say(`force per unit width, mid → edge, bands of whole lattice columns [kN/mm]: ${f(out.forcePerWidthByZ_kN_per_mm, 2)}   (whole half width ${out.forceHalfWidth_kN.toFixed(2)} kN per roll)`);
  if (out.forcePerWidthByColumn_kN_per_mm.length <= 40) say(`  per lattice column: ${f(out.forcePerWidthByColumn_kN_per_mm, 2)}`);
  // Wusatowski's fit is for narrow strips; past W/h0 ≈ 20 it gives no spread at all
  say(`spread W1/W0 − 1: ${(out.spread * 100).toFixed(2)} %${W / r.h0 < 20 ? `   (Wusatowski ${(wus * 100).toFixed(2)} %)` : ''}`);
  say(`centre exit thickness ${out.centreExitThickness_mm.toFixed(4)} mm`);
  say(`σxx [MPa] mid → edge, bite x ∈ (−1, 0) mm: ${f(out.sxxBite_MPa)}`);
  say(`σxx [MPa] mid → edge, rolled strip 1–5 mm past the probe: ${f(out.sxxPast_MPa)}`);
  say(`pressure in the bite: mean ${out.pressureMean_MPa.toFixed(0)} MPa, neighbour jump p95 ${out.pressureJumpP95_MPa.toFixed(0)} / max ${out.pressureJumpMax_MPa.toFixed(0)} MPa`);
  for (const c of out.cracks) say(`crack at step ${c.step}: ${c.fromHead_mm.toFixed(2)} mm from the head, ${c.fromMid_mm.toFixed(2)} mm from the mid-width, η ${c.eta.toFixed(2)}, ${c.count} points over ${c.alongX_mm.toFixed(2)} mm along x × ${c.acrossZ_mm.toFixed(2)} mm across`);
}
