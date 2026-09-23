// One pass of the three-dimensional model (src/mpm/solid/sim3.ts), headless.
//   node tools/solid.mjs [--W 8] [--L 12] [--cells 4] [--r 0.25] [--R 100] [--h0 1] [--mu 0.08] [--mat spcc]
//                        [--tb 0] [--tf 0] [--plane-strain] [--max 200000] [--json]
//                        [--length steady] [--stands 3] [--handoff done|steady]
//                        [--flatten hitchcock] [--rollE 206] [--control reduction] [--bend <barrel mm> [--span <mm>]] [--crown <µm>]
//                        [--threads N]
// --threads N: the step by a team of N threads (src/mpm/solid/team.ts on worker_threads; this thread is one of them).
// --length steady: the strip as long as the steady looks need (--L is not used). --stands: a tandem, every stand
// the same condition, the strip carried from stand to stand (src/mpm/solid/tandem3.ts).
// Lengths in mm, tensions in MPa, the reduction as a fraction. The steady values are read as the page reads them (steady.ts).
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { solidParams } from '../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../src/mpm/solid/tandem3.ts';
import { karman } from '../src/mpm/slab.ts';
import { nodeTeam } from './lib/solid-team.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => (has(n) ? args[args.indexOf(`--${n}`) + 1] : d);
const base = defaultParams();
const r = base.rolling;
r.h0 = +opt('h0', 1) * 1e-3;
r.reduction = +opt('r', 0.25);
r.rollRadius = +opt('R', 100) * 1e-3;
r.sheetLength = +opt('L', 12) * 1e-3;
r.mu = +opt('mu', 0.08);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
if (opt('length', 'fixed') === 'steady') r.lengthMode = 'steady';
if (opt('flatten', 'none') === 'hitchcock') r.flattening = 'hitchcock';
if (has('rollE')) r.rollE = +opt('rollE') * 1e9;
if (opt('control', 'gap') === 'reduction') r.gapControl = 'reduction';
if (has('mat')) base.material = { ...MATERIALS[opt('mat')] };
if (has('damage')) base.damage.model = opt('damage');
base.numerics.cellsThrough = +opt('cells', 4);
if (has('ms')) base.numerics.massScale = +opt('ms');
const P = solidParams(base, { width: +opt('W', 8) * 1e-3, planeStrain: has('plane-strain'), ...(has('bend') ? { rollBend: { barrel: +opt('bend') * 1e-3, span: +opt('span', 0) * 1e-3 } } : {}), ...(has('crown') ? { crownIn: +opt('crown') * 1e-6 } : {}) });
const json = has('json');
const maxSteps = +opt('max', 400000);

const t0 = performance.now();
const threads = +opt('threads', 1);
const tandem = new Tandem3(P, +opt('stands', 1), opt('handoff', 'done'), threads > 1 ? { shared: true, size: threads } : {});
const team = threads > 1 ? nodeTeam(threads) : null;
if (team) await tandem.useTeam(team);
const say = (s) => { if (!json) console.log(s); };
const intro = (sim, k) => say(`${tandem.stands > 1 ? `#${k + 1}: h0 ${(sim.params.rolling.h0 * 1e3).toFixed(4)} mm, W ${(sim.params.solid.width * 1e3).toFixed(4)} mm, L ${(sim.params.rolling.sheetLength * 1e3).toFixed(2)} mm, ` : ''}points ${sim.n} (${sim.NI} × ${sim.NJ} × ${sim.NK}), grid ${sim.nxN} × ${sim.nyN} × ${sim.nzN}, h ${(sim.h * 1e3).toFixed(4)} mm, dt ${sim.dt.toExponential(3)} s, gap ${(sim.gap * 1e3).toFixed(4)} mm, Lc ${(sim.contactLength * 1e3).toFixed(3)} mm`);
intro(tandem.sim, 0);
tandem.onStandDone = (e) => { if (e.next) intro(e.next, e.stand + 1); };
const every = +opt('every', 2000);
let steps = 0;
let sim = tandem.sim;
while (steps < maxSteps && !tandem.done) {
  sim = tandem.sim;
  const look = team ? await tandem.advanceTeam() : tandem.advance();
  steps++;
  if (look && sim.step % every === 0) say(`step ${sim.step} t ${(sim.t * 1e3).toFixed(2)} ms ${look.phase} F ${(look.force * 1e-3).toFixed(3)} kN, half width ${look.halfWidth ? (look.halfWidth * 1e3).toFixed(4) : '—'} mm, centre thickness ${look.centreHalfThickness ? (2 * look.centreHalfThickness * 1e3).toFixed(4) : '—'} mm`);
}
const secs = (performance.now() - t0) / 1e3;
team?.close();
const slab = karman(P.rolling, P.material);
const steadyOut = (st, width) => st && {
  looks: st.looks,
  force_kN: st.force * 1e-3,
  forcePerWidth_kN_per_mm: (st.force / (2 * st.halfWidth)) * 1e-6,
  forcePerEntryWidth_kN_per_mm: (st.force / width) * 1e-6,
  slabPlaneStrain_kN_per_mm: slab.force * 1e-6,
  torque_Nm: st.torque,
  width_mm: 2 * st.halfWidth * 1e3,
  spread_percent: st.spread * 100,
  centreThickness_mm: 2 * st.halfThickness[0] * 1e3,
  edgeThickness_mm: 2 * st.halfThickness[st.halfThickness.length - 1] * 1e3,
  forwardSlip: st.forwardSlip,
  forceByZ_kN_per_mm: st.forceByZ.map((v) => +(v * 1e-6).toFixed(4)),
  rollBend_um: st.rollBend && { centre: st.rollBend.centre * 1e6, edge: st.rollBend.edge * 1e6 },
  crownIn_um: st.crownIn * 1e6,
  crownOut_um: st.crownOut * 1e6,
  thicknessByZ_mm: st.halfThickness.map((v) => +(2 * v * 1e3).toFixed(5)),
  exitZ_mm: st.exitZ.map((v) => +(v * 1e3).toFixed(4)),
  flatness_I: st.flatness.map((v) => +v.toFixed(1)),
};
// a single pass that ran out of steps has no result yet: its sampler's means
const st = tandem.results[0]?.steady ?? (tandem.stands === 1 ? tandem.sampler.means(sim) : null);
const out = {
  points: tandem.results[0]?.particles ?? sim.n,
  steps,
  secs,
  msPerStep: (secs * 1e3) / steps,
  phase: sim.phase(),
  rollRadius_mm: sim.roll.R * 1e3,
  gap_mm: sim.gap * 1e3,
  rollsSettled: sim.rollsSettled,
  bendSettled: sim.bendSettled,
  gauge: sim.gauge(sim.xExitProbe),
  sheetLength_mm: tandem.base.rolling.sheetLength * 1e3,
  steady: steadyOut(st, P.solid.width),
  maxDamage: sim.maxDamage(),
  failed: sim.nFailed,
};
if (tandem.stands > 1) {
  delete out.steady;
  out.stopped = tandem.stopped;
  out.stands = tandem.results.map((s) => ({
    stand: s.stand + 1,
    h0_mm: s.h0 * 1e3,
    width_mm: s.width * 1e3,
    sheetLength_mm: s.sheetLength * 1e3,
    points: s.particles,
    steps: s.steps,
    phase: s.phase,
    rollRadius_mm: s.rollRadius * 1e3,
    gap_mm: s.gap * 1e3,
    rollsSettled: s.rollsSettled,
    thicknessOut_mm: s.thicknessOut * 1e3,
    widthOut_mm: s.widthOut * 1e3,
    massLost: s.massLost,
    separated: s.separated,
    maxDamage: s.maxDamage,
    failed: s.nFailed,
    steady: steadyOut(s.steady, s.width),
  }));
}
console.log(json ? JSON.stringify(out) : out);
if (!json && tandem.stands > 1) for (const s of out.stands) console.log(`#${s.stand}`, s.steady && { ...s.steady, forceByZ_kN_per_mm: undefined });
