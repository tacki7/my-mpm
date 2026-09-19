// Tandem rolling headless: the same pass over --stands stands, the material state carried from each
// stand to the next (src/mpm/tandem.ts). Prints a line per stand (or one JSON object with --json).
//
//   node tools/tandem.mjs --stands 3 [the options of tools/run.mjs]
//
// Each stand's summary is the one tools/run.mjs prints for a pass (tools/run-summary.mjs), plus its
// entry sheet and the thickness of the sheet it let out; with --stands 1 it is run.mjs's.
import { READ_STEPS, TandemSim } from '../src/mpm/tandem.ts';
import { runParams } from './run-params.mjs';
import { summarize } from './run-summary.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const stands = +opt('stands', 1);
const every = +opt('every', READ_STEPS);
const maxSteps = +opt('max', 400000);
const json = flag('json');
const P = runParams(args.filter((a, i) => a !== '--stands' && args[i - 1] !== '--stands'));

// the stand ends inside advance(), at its own reading every `every` steps; these reads of diagnostics() come
// at the same steps (blocks of `every` from the stand's step 0), so a stand's summary is run.mjs's for the pass
const tandem = new TandemSim(P, stands, every);
const out = [];
const log = (s) => { if (!json) console.log(s); };
let hist = [];
let t0 = performance.now();
const report = (sim, d, res) => {
  const secs = (performance.now() - t0) / 1000;
  const summary = summarize(sim, sim.params, hist, d, secs);
  const stand = res ? res.stand : tandem.stand;
  const entry = {
    stand: stand + 1,
    h0_mm: sim.params.rolling.h0 * 1e3,
    sheetLength_mm: sim.params.rolling.sheetLength * 1e3,
    thicknessOut_mm: res ? res.thicknessOut * 1e3 : null,
    ...summary,
    // one stand: the records as run.mjs prints them (no stand field)
    cracks: stands > 1 ? summary.cracks.map((c) => ({ ...c, stand: (c.stand ?? stand) + 1 })) : summary.cracks,
  };
  out.push(entry);
  log(
    `stand ${stand + 1}/${stands}: h0 ${entry.h0_mm.toFixed(4)} mm, L ${entry.sheetLength_mm.toFixed(2)} mm, ${summary.particles} points, ${summary.steps} steps (${secs.toFixed(1)} s), ` +
      `F ${summary.steadyForce_kN_per_mm.toFixed(3)} kN/mm, exit ${summary.exitThickness_mm.toFixed(4)} mm, out ${entry.thicknessOut_mm?.toFixed(4) ?? '-'} mm, ` +
      `slip ${(summary.forwardSlip * 100).toFixed(2)} %, Dmax ${summary.maxDamage.toFixed(3)}, failed ${summary.failed}, cracks ${summary.cracks.length}, ${d.phase}` +
      (res ? `, mass lost ${(res.massLost * 100).toFixed(2)} %${res.separated ? ', separated' : ''}` : ''),
  );
  hist = [];
  t0 = performance.now();
};
// the ended stand's last read, at the step its reading found it done
tandem.onStandDone = (e) => {
  const d = e.sim.diagnostics();
  hist.push(d);
  report(e.sim, d, e.result);
};
while (!tandem.done) {
  const stand = tandem.stand;
  for (let k = 0; k < every && !tandem.done && tandem.stand === stand; k++) tandem.advance();
  if (tandem.done || tandem.stand !== stand) continue;
  hist.push(tandem.sim.diagnostics());
  if (tandem.sim.step >= maxSteps) {
    report(tandem.sim, hist[hist.length - 1], null);
    break;
  }
}
if (tandem.stopped) log(`stopped after stand ${tandem.results.length}: ${tandem.stopped}`);
if (json) console.log(JSON.stringify({ stands, every, stopped: tandem.stopped, results: out, stand: tandem.results }));
