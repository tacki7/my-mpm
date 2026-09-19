// A sheet the rolls cannot draw in (friction far below the bite angle's) stops once the
// pusher lets go: the phase turns 'stalled' and stays so. With the standard friction it is
// rolled to the end ('done'). The quasi-static indicators are reported on the way.
// Coarse grid (4 cells; a 10 mm strip that stalls, a 16 mm one that is rolled).
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

function run(mu, L) {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = L;
  P.rolling.mu = mu;
  P.damage.model = 'none';
  const sim = new Sim(P);
  let d;
  let releasedAt = null;
  let slowAt = null; // first read after the release with the mean speed under 5 % of the roll speed
  while (sim.step < 60000) {
    for (let k = 0; k < 500; k++) sim.advance();
    if (!sim.pusherActive && releasedAt === null) releasedAt = sim.t;
    let mv = 0;
    let m = 0;
    for (let p = 0; p < sim.n; p++) if (sim.active[p]) (mv += sim.mass[p] * sim.vx[p]), (m += sim.mass[p]);
    if (releasedAt !== null && slowAt === null && Math.abs(mv / m) < 0.05 * P.rolling.rollSpeed) slowAt = sim.t;
    d = sim.diagnostics();
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  return { sim, d, releasedAt, slowAt };
}

const stuck = run(0.005, 10e-3);
ok(stuck.d.phase === 'stalled', 'μ = 0.005 (bite angle needs about 0.025): the sheet stalls once the pusher lets go', `phase ${stuck.d.phase} at ${(stuck.d.t * 1e3).toFixed(2)} ms, pusher released at ${stuck.releasedAt !== null ? (stuck.releasedAt * 1e3).toFixed(2) : '—'} ms`);
ok(stuck.releasedAt !== null && stuck.d.t > stuck.releasedAt, 'it stalls only after the pusher has let go');
// it waits for the roll surface to cross the contact length with the sheet at rest before calling it stalled
const wait = stuck.sim.contactLength / stuck.sim.params.rolling.rollSpeed;
const readGap = 500 * stuck.sim.dt;
ok(stuck.slowAt !== null && stuck.d.t - stuck.slowAt > wait - readGap, 'it is called stalled only after resting for the contact length at roll speed', stuck.slowAt !== null ? `slow at ${(stuck.slowAt * 1e3).toFixed(2)} ms, stalled at ${(stuck.d.t * 1e3).toFixed(2)} ms, wait ${(wait * 1e3).toFixed(2)} ms` : 'never slow');
let mv = 0;
let m = 0;
for (let p = 0; p < stuck.sim.n; p++) if (stuck.sim.active[p]) (mv += stuck.sim.mass[p] * stuck.sim.vx[p]), (m += stuck.sim.mass[p]);
between(mv / m / stuck.sim.params.rolling.rollSpeed, -0.05, 0.05, 'and it has really stopped: mean speed / roll speed');
for (let k = 0; k < 200; k++) stuck.sim.advance();
ok(stuck.sim.phase() === 'stalled', 'stalled stays stalled');

// a 16 mm strip, so the sheet runs on its own for longer than that wait
const rolled = run(0.08, 16e-3);
ok(rolled.d.phase === 'done', 'μ = 0.08: rolled to the end', `phase ${rolled.d.phase} at step ${rolled.d.step}, on its own for ${((rolled.d.t - rolled.releasedAt) * 1e3).toFixed(1)} ms`);
between(rolled.d.inertiaRatio, 0.02, 0.08, 'inertia of the mass-scaled strip over the flow stress, ρ ms V² r / 2k̄ (standard, ms 1e4)');
done();
