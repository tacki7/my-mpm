// Run one rolling simulation headless and print its diagnostics.
//
//   node tools/run.mjs [--h0 1] [--r 0.25] [--R 100] [--L 16] [--mu 0.08] [--cells 10]
//                      [--mat spcc|s4340|al6061] [--damage johnson-cook|hancock-mackenzie|cockcroft-latham|gtn|localization|none]
//                      [--yield von-mises|gtn] [--preset <id>] [--chi 0.9] [--nonlocal <ℓ mm>]
//                      [--tb 0] [--tf 0] [--every 2000] [--max 400000] [--contact surface|stencil] [--vrc 1]
//                      [--crack none|dfg] [--json]
//
// Lengths in mm, tensions in MPa. An option left out keeps the preset's value (or the
// default): `--preset front-tension` runs with its front tension. Prints a line every
// --every steps and a summary at the end (or one JSON object with --json).
import { Sim } from '../src/mpm/solver.ts';
import { runParams } from './run-params.mjs';
import { summarize } from './run-summary.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

// the preset (or the defaults) and the options given; one left out keeps the preset's value
const P = runParams(args);
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
  if (d.phase === 'done' || d.phase === 'stalled') break;
}
const secs = (performance.now() - t0) / 1000;
const summary = summarize(sim, P, hist, d, secs);
if (json) console.log(JSON.stringify(summary));
else console.log(summary);
