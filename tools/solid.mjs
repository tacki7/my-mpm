// One pass of the three-dimensional model (src/mpm/solid/sim3.ts), headless.
//   node tools/solid.mjs [--W 8] [--L 12] [--cells 4] [--r 0.25] [--R 100] [--h0 1] [--mu 0.08] [--mat spcc]
//                        [--plane-strain] [--max 200000] [--json]
// Lengths in mm, the reduction as a fraction. The steady values are read as the page reads them (steady.ts).
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { Sim3, solidParams } from '../src/mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../src/mpm/solid/steady.ts';
import { karman } from '../src/mpm/slab.ts';

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
if (has('mat')) base.material = { ...MATERIALS[opt('mat')] };
if (has('damage')) base.damage.model = opt('damage');
base.numerics.cellsThrough = +opt('cells', 4);
if (has('ms')) base.numerics.massScale = +opt('ms');
const P = solidParams(base, { width: +opt('W', 8) * 1e-3, planeStrain: has('plane-strain') });
const json = has('json');
const maxSteps = +opt('max', 400000);

const t0 = performance.now();
const sim = new Sim3(P);
const say = (s) => { if (!json) console.log(s); };
say(`points ${sim.n} (${sim.NI} × ${sim.NJ} × ${sim.NK}), grid ${sim.nxN} × ${sim.nyN} × ${sim.nzN}, h ${(sim.h * 1e3).toFixed(4)} mm, dt ${sim.dt.toExponential(3)} s, gap ${(sim.gap * 1e3).toFixed(4)} mm, Lc ${(sim.contactLength * 1e3).toFixed(3)} mm`);
const sampler = new SolidSampler();
const every = +opt('every', 2000);
while (sim.step < maxSteps) {
  for (let k = 0; k < READ_STEPS; k++) sim.advance();
  const look = sampler.look(sim);
  if (sim.step % every === 0) say(`step ${sim.step} t ${(sim.t * 1e3).toFixed(2)} ms ${look.phase} F ${(look.force * 1e-3).toFixed(3)} kN, half width ${look.halfWidth ? (look.halfWidth * 1e3).toFixed(4) : '—'} mm, centre thickness ${look.centreHalfThickness ? (2 * look.centreHalfThickness * 1e3).toFixed(4) : '—'} mm`);
  if (look.phase === 'done' || look.phase === 'stalled') break;
}
const st = sampler.means(sim);
const secs = (performance.now() - t0) / 1e3;
const slab = karman(P.rolling, P.material);
const out = {
  points: sim.n,
  steps: sim.step,
  secs,
  msPerStep: (secs * 1e3) / sim.step,
  phase: sim.phase(),
  steady: st && {
    looks: st.looks,
    force_kN: st.force * 1e-3,
    forcePerWidth_kN_per_mm: (st.force / (2 * st.halfWidth)) * 1e-6,
    forcePerEntryWidth_kN_per_mm: (st.force / P.solid.width) * 1e-6,
    slabPlaneStrain_kN_per_mm: slab.force * 1e-6,
    torque_Nm: st.torque,
    width_mm: 2 * st.halfWidth * 1e3,
    spread_percent: st.spread * 100,
    centreThickness_mm: 2 * st.halfThickness[0] * 1e3,
    edgeThickness_mm: 2 * st.halfThickness[st.halfThickness.length - 1] * 1e3,
    forwardSlip: st.forwardSlip,
    forceByZ_kN_per_mm: st.forceByZ.map((v) => +(v * 1e-6).toFixed(4)),
  },
  maxDamage: sim.maxDamage(),
  failed: sim.nFailed,
};
console.log(json ? JSON.stringify(out) : out);
