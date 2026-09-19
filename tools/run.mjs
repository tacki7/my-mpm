// Run one rolling simulation headless and print its diagnostics.
//
//   node tools/run.mjs [--h0 1] [--r 0.25] [--R 100] [--L 16] [--mu 0.08] [--cells 10]
//                      [--mat spcc|s4340|al6061] [--damage johnson-cook|hancock-mackenzie|cockcroft-latham|gtn|localization|none]
//                      [--yield von-mises|gtn] [--preset <id>] [--chi 0.9] [--nonlocal <ℓ mm>]
//                      [--tb 0] [--tf 0] [--every 2000] [--max 400000] [--json]
//
// Lengths in mm, tensions in MPa. Prints a line every --every steps and a summary
// at the end (or one JSON object with --json).
import { Sim } from '../src/mpm/solver.ts';
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { presetById } from '../src/mpm/presets.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const preset = opt('preset', null);
const P = preset ? presetById(preset).build() : defaultParams();
const r = P.rolling;
r.h0 = +opt('h0', r.h0 * 1e3) * 1e-3;
r.reduction = +opt('r', r.reduction);
r.rollRadius = +opt('R', r.rollRadius * 1e3) * 1e-3;
r.sheetLength = +opt('L', r.sheetLength * 1e3) * 1e-3;
r.mu = +opt('mu', r.mu);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
P.numerics.cellsThrough = +opt('cells', P.numerics.cellsThrough);
P.numerics.massScale = +opt('ms', P.numerics.massScale);
if (flag('nojbar')) P.numerics.jbar = false;
const mat = opt('mat', null);
if (mat) P.material = { ...MATERIALS[mat] };
P.damage.model = opt('damage', P.damage.model);
P.damage.yield = opt('yield', P.damage.yield);
P.material.chi = +opt('chi', P.material.chi); // Taylor-Quinney coefficient: 0 = no heating
P.damage.nonlocalLength = +opt('nonlocal', P.damage.nonlocalLength * 1e3) * 1e-3; // mm
P.damage.gtn.nucleation = opt('nucleation', P.damage.gtn.nucleation);
const every = +opt('every', 2000);
const maxSteps = +opt('max', 400000);
const json = flag('json');

const t0 = performance.now();
const sim = new Sim(P);
const log = (s) => { if (!json) console.log(s); };
log(`particles ${sim.n}, grid ${sim.nxN}x${sim.nyN}, h ${(sim.h * 1e3).toFixed(4)} mm, dt ${sim.dt.toExponential(3)} s, gap ${(sim.gap * 1e3).toFixed(4)} mm, Lc ${(sim.contactLength * 1e3).toFixed(3)} mm`);
const hist = [];
let d;
while (sim.step < maxSteps) {
  for (let k = 0; k < every; k++) sim.advance();
  d = sim.diagnostics();
  hist.push(d);
  log(`step ${d.step} t ${(d.t * 1e3).toFixed(3)} ms ${d.phase.padEnd(8)} head ${(d.headX * 1e3).toFixed(2)} tail ${(d.tailX * 1e3).toFixed(2)} F ${(d.rollForce * 1e-6).toFixed(4)} kN/mm T ${(d.rollTorque).toFixed(1)} N  push ${(d.pusherForce * 1e-6).toFixed(4)} h1 ${d.exitThickness ? (d.exitThickness * 1e3).toFixed(4) : '-'} fs ${d.forwardSlip != null ? (d.forwardSlip * 100).toFixed(2) + '%' : '-'} xn ${d.neutralX != null ? (d.neutralX * 1e3).toFixed(3) : '-'} Dmax ${d.maxDamage.toFixed(3)} failed ${d.nFailed} cracks ${d.cracks}`);
  if (d.phase === 'done') break;
}
const secs = (performance.now() - t0) / 1000;
const steady = hist.filter((h) => h.phase === 'steady');
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const summary = {
  particles: sim.n,
  steps: sim.step,
  secs,
  msPerStep: (secs * 1000) / sim.step,
  phase: d.phase,
  steadyForce_kN_per_mm: mean(steady.map((h) => h.rollForce)) * 1e-6,
  steadyTorque_N: mean(steady.map((h) => h.rollTorque)),
  exitThickness_mm: mean(steady.filter((h) => h.exitThickness).map((h) => h.exitThickness)) * 1e3,
  forwardSlip: mean(steady.filter((h) => h.forwardSlip != null).map((h) => h.forwardSlip)),
  neutralX_mm: mean(steady.filter((h) => h.neutralX != null).map((h) => h.neutralX)) * 1e3,
  maxDamage: d.maxDamage,
  failed: d.nFailed,
  ...porosity(),
  ...heating(),
  cracks: sim.cracks,
};
if (json) console.log(JSON.stringify(summary));
else console.log(summary);

// the largest porosity and where that point sat in the undeformed sheet (GTN)
function porosity() {
  let k = -1;
  for (let p = 0; p < sim.n; p++) if (sim.active[p] && (k < 0 || sim.por[p] > sim.por[k])) k = p;
  if (k < 0 || !(sim.por[k] > 0)) return {};
  return {
    maxPorosity: sim.por[k],
    maxPorosityAt_mm: { fromHead: (sim.xHead0 - sim.x0[k]) * 1e3, fromMidPlane: sim.y0[k] * 1e3 },
  };
}

// temperature rise of the rolled sheet: mean over its middle (the ends are not steady) and the largest (--chi)
function heating() {
  if (!(P.material.chi > 0)) return {};
  const L = P.rolling.sheetLength;
  let sum = 0;
  let n = 0;
  let max = 0;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    const dT = sim.temp[p] - P.material.tRoom;
    if (dT > max) max = dT;
    const s = sim.xHead0 - sim.x0[p];
    if (s < 0.15 * L || s > 0.85 * L) continue;
    sum += dT;
    n++;
  }
  return { dTmean_K: sum / Math.max(1, n), dTmax_K: max };
}
