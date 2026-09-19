// Run the plan-view model (src/mpm/planview/sim.ts) once and print what it says about the
// width: the roll force per unit width in the middle and at the edge, the spread against
// Wusatowski's formula, σxx across the width in the bite and in the rolled strip, the
// pressure differences between neighbouring points in the bite, and the cracks. Not a
// gate check (a 60 mm wide strip takes about a minute).
//
//   node tools/planview.mjs [--W 20] [--cells 20] [--L 16] [--h0 1] [--r 0.25] [--R 100]
//                           [--mu 0.08] [--ms 10000] [--tb 0] [--tf 0]
//                           [--damage none|johnson-cook|hancock-mackenzie|cockcroft-latham] [--cl 0.6]
//                           [--notch <radius mm>] [--json]
//
// Lengths in mm, tensions in MPa; --W is the full width, --cells the grid cells across the
// half width. --notch cuts a semicircular notch of that radius into the edge half-way along
// the strip. Steady values are means over the samples (every 250 steps) in the steady phase.
import { PlanSim, planParams } from '../src/mpm/planview/sim.ts';
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
r.sheetLength = +opt('L', 16) * 1e-3;
r.mu = +opt('mu', r.mu);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
base.numerics.massScale = +opt('ms', base.numerics.massScale);
base.damage.model = opt('damage', 'none');
base.damage.clCrit = +opt('cl', base.damage.clCrit);
const W = +opt('W', 20) * 1e-3;
const notch = +opt('notch', 0) * 1e-3;
if (notch > 0) base.defects = [{ kind: 'void', x: r.sheetLength / 2, y: W / 2, ax: notch, ay: notch }];
const P = planParams(base, W, +opt('cells', 20));
const sim = new PlanSim(P);
say(`plan view: W ${(W * 1e3).toFixed(1)} mm (W/h0 ${(W / r.h0).toFixed(0)}), ${sim.n} points, h ${(sim.h * 1e3).toFixed(3)} mm, dt ${sim.dt.toExponential(3)} s`);

// Wusatowski (1955): W1/W0 = (h1/h0)^(−w), w = 10^(−1.269 (W0/h0) (h0/D)^0.556), D the roll diameter
const wus = Math.pow(1 - r.reduction, -Math.pow(10, -1.269 * (W / r.h0) * Math.pow(r.h0 / (2 * r.rollRadius), 0.556))) - 1;

const t0 = performance.now();
const samples = [];
let phase = '';
while (sim.step < 400000) {
  for (let k = 0; k < 250; k++) sim.advance();
  phase = sim.phase();
  const F = sim.readForce();
  if (phase === 'steady') samples.push({ F, snap: snapshot() });
  if (phase === 'done') break;
}
const secs = (performance.now() - t0) / 1000;

/** one look at the strip: force per unit width by z, σxx by z in the bite and past the exit, spread, pressure jumps */
function snapshot() {
  const nb = 10;
  const Wz = sim.halfWidth0 * 1.05;
  const band = (z) => Math.min(nb - 1, Math.floor((z / Wz) * nb));
  const fz = new Float64Array(nb);
  const bite = Array.from({ length: nb }, () => [0, 0]);
  const past = Array.from({ length: nb }, () => [0, 0]);
  let jumps = [];
  let pMean = 0;
  let nIn = 0;
  const x2 = sim.xExitProbe + 1e-3;
  const x3 = sim.xExitProbe + 5e-3;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    const x = sim.px[p];
    const b = band(sim.pz[p]);
    const detF = sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p];
    if (sim.pc[p] > 0) {
      fz[b] += sim.pc[p] * sim.dp * sim.dp * detF;
      pMean += sim.pres[p];
      nIn++;
      // the pressure against the lattice neighbours ahead and outward
      for (const q of [neighbour(p, 1, 0), neighbour(p, 0, 1)]) if (q >= 0 && sim.active[q] && sim.pc[q] > 0) jumps.push(Math.abs(sim.pres[p] - sim.pres[q]));
    }
    const sxx = sim.sxx[p] - sim.pres[p];
    if (x > -1e-3 && x < 0) (bite[b][0] += sxx), bite[b][1]++;
    if (x > x2 && x < x3) (past[b][0] += sxx), past[b][1]++;
  }
  jumps.sort((a, b) => a - b);
  const exit = sim.exitProfile(sim.xExitProbe, sim.xExitProbe + 2 * sim.h, 5);
  return {
    forcePerWidth: Array.from(fz, (f) => f / (Wz / nb)),
    sxxBite: bite.map(([s, c]) => (c ? s / c : NaN)),
    sxxPast: past.map(([s, c]) => (c ? s / c : NaN)),
    halfWidth: exit.halfWidth,
    centreThick: exit.bins[0].thick,
    pressureMean: nIn ? pMean / nIn : NaN,
    jumpMax: jumps.length ? jumps[jumps.length - 1] : NaN,
    jumpP95: jumps.length ? jumps[Math.floor(0.95 * (jumps.length - 1))] : NaN,
  };
}

function neighbour(p, di, dk) {
  const i = sim.li[p] + di;
  const k = sim.lk[p] + dk;
  if (i < 0 || i >= sim.NI || k < 0 || k >= sim.NK) return -1;
  return sim.lattice[i * sim.NK + k];
}

const mean = (a) => {
  const v = a.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const meanOf = (f) => mean(samples.map((s) => f(s.snap)));
const meanVec = (f) => f(samples[0].snap).map((_, i) => mean(samples.map((s) => f(s.snap)[i])));
const out = {
  W_mm: W * 1e3,
  cells: P.plan.cellsHalfWidth,
  points: sim.n,
  secs,
  steadySamples: samples.length,
  forceHalfWidth_kN: mean(samples.map((s) => s.F)) * 1e-3,
  forcePerWidthMid_kN_per_mm: samples.length ? meanVec((s) => s.forcePerWidth)[0] * 1e-6 : NaN,
  forcePerWidthByZ_kN_per_mm: samples.length ? meanVec((s) => s.forcePerWidth).map((v) => v * 1e-6) : [],
  spread: samples.length ? meanOf((s) => s.halfWidth) / sim.halfWidth0 - 1 : NaN,
  spreadWusatowski: wus,
  centreExitThickness_mm: samples.length ? meanOf((s) => s.centreThick) * 1e3 : NaN,
  sxxBite_MPa: samples.length ? meanVec((s) => s.sxxBite).map((v) => v * 1e-6) : [],
  sxxPast_MPa: samples.length ? meanVec((s) => s.sxxPast).map((v) => v * 1e-6) : [],
  pressureMean_MPa: samples.length ? meanOf((s) => s.pressureMean) * 1e-6 : NaN,
  pressureJumpMax_MPa: samples.length ? meanOf((s) => s.jumpMax) * 1e-6 : NaN,
  pressureJumpP95_MPa: samples.length ? meanOf((s) => s.jumpP95) * 1e-6 : NaN,
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
  say(`${samples.length} steady samples, ${sim.step} steps, ${secs.toFixed(1)} s`);
  say(`force per unit width, mid → edge [kN/mm]: ${f(out.forcePerWidthByZ_kN_per_mm, 2)}   (whole half width ${out.forceHalfWidth_kN.toFixed(2)} kN per roll)`);
  say(`spread W1/W0 − 1: ${(out.spread * 100).toFixed(2)} %   (Wusatowski ${(wus * 100).toFixed(2)} %)`);
  say(`centre exit thickness ${out.centreExitThickness_mm.toFixed(4)} mm`);
  say(`σxx [MPa] mid → edge, bite x ∈ (−1, 0) mm: ${f(out.sxxBite_MPa)}`);
  say(`σxx [MPa] mid → edge, rolled strip 1–5 mm past the probe: ${f(out.sxxPast_MPa)}`);
  say(`pressure in the bite: mean ${out.pressureMean_MPa.toFixed(0)} MPa, neighbour jump p95 ${out.pressureJumpP95_MPa.toFixed(0)} / max ${out.pressureJumpMax_MPa.toFixed(0)} MPa`);
  for (const c of out.cracks) say(`crack at step ${c.step}: ${c.fromHead_mm.toFixed(2)} mm from the head, ${c.fromMid_mm.toFixed(2)} mm from the mid-width, η ${c.eta.toFixed(2)}, ${c.count} points over ${c.alongX_mm.toFixed(2)} mm along x × ${c.acrossZ_mm.toFixed(2)} mm across`);
}
