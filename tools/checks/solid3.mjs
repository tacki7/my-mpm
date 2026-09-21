// The three-dimensional model (src/mpm/solid/sim3.ts, docs/model.md「3 次元モデル」), 4 cells, L 12 mm, each run
// stopped after its third steady look (about 1.5 min in all):
// - with the width direction held (planeStrain) it is the 2D section's problem: the roll force per width and the
//   exit thickness agree with Sim on the same grid
// - with the width free the strip spreads: W1 > W0, less force per width than plane strain, the load falling
//   from the mid-width to the edge, the exit thickness the gap's; the volume of the steel is kept
// - a narrower strip spreads more (relative to its width)
// @check
import { ok, between, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../../src/mpm/solid/steady.ts';

const base = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 12e-3;
  return P;
};

/** a 3D pass up to its third steady look: the steady means and the sim */
function pass3(solid) {
  const sim = new Sim3(solidParams(base(), solid));
  const sampler = new SolidSampler();
  let looks = 0;
  while (sim.step < 30000) {
    for (let k = 0; k < READ_STEPS; k++) sim.advance();
    const look = sampler.look(sim);
    if (look.phase === 'steady') looks++;
    if (looks >= 3 || look.phase === 'done' || look.phase === 'stalled') break;
  }
  return { sim, st: sampler.means(sim) };
}

// ── the 2D section on the same grid: steady force by steps, exit thickness every 500 steps
const P2 = base();
const s2 = new Sim(P2);
let F = 0;
let nF = 0;
let H = 0;
let nH = 0;
while (s2.phase() !== 'done' && s2.step < 40000) {
  for (let k = 0; k < 100; k++) s2.advance();
  const w = s2.readWindow();
  if (s2.phase() !== 'steady') continue;
  F += w.force * w.steps;
  nF += w.steps;
  if (s2.step % 500 === 0) {
    const ex = s2.exitMeasure(s2.xExitProbe, (2.2 * s2.dp) / (1 - P2.rolling.reduction));
    if (ex) {
      H += ex.thickness;
      nH++;
    }
  }
}
const force2 = F / nF;
const exit2 = H / nH;
ok(nF > 0 && nH > 0, 'the 2D section has steady readings to compare with', `${(force2 * 1e-6).toFixed(3)} kN/mm, ${(exit2 * 1e3).toFixed(4)} mm`);

// ── the width held: the section's problem
{
  const W = 1e-3;
  const { st } = pass3({ width: W, planeStrain: true });
  ok(st && st.looks >= 3, 'plane strain: steady looks');
  near(st.force / W, force2, 0.04, 'plane strain: the roll force per width is the 2D section\'s');
  // the two gauges differ (the section's: by area over a band; here: the outer surface of the points' columns)
  near(2 * st.halfThickness[0], exit2, 1.2e-2, 'plane strain: the exit thickness is the 2D section\'s');
  // (the gauge reads the edge points' own stretch too: 1e-4)
  near(st.halfWidth, W / 2, 5e-4, 'plane strain: the width does not change');
}

// ── the width free
const spreadOf = {};
for (const W of [2e-3, 4e-3]) {
  const { sim, st } = pass3({ width: W });
  ok(st && st.looks >= 3, `W ${W * 1e3} mm: steady looks`);
  spreadOf[W] = st.spread;
  between(st.spread, 0.03, 0.2, `W ${W * 1e3} mm: the strip spreads`);
  ok(st.force / (2 * st.halfWidth) < force2, `W ${W * 1e3} mm: less force per width than plane strain`, `${((st.force / (2 * st.halfWidth)) * 1e-6).toFixed(3)} against ${(force2 * 1e-6).toFixed(3)} kN/mm`);
  between((2 * st.halfThickness[0]) / sim.gap, 0.985, 1.01, `W ${W * 1e3} mm: the mid-width exit thickness is the gap's`);
  const inside = st.forceByZ.filter((q) => q > 0);
  ok(inside[0] > inside[inside.length - 2], `W ${W * 1e3} mm: the load per width falls from the mid-width to the edge`);
  // plastic flow keeps volume; the elastic part is ~1e-3
  let v = 0;
  let v0 = 0;
  for (let p = 0; p < sim.n; p++) {
    const f = sim.F;
    const o = 9 * p;
    const J = f[o] * (f[o + 4] * f[o + 8] - f[o + 5] * f[o + 7]) - f[o + 1] * (f[o + 3] * f[o + 8] - f[o + 5] * f[o + 6]) + f[o + 2] * (f[o + 3] * f[o + 7] - f[o + 4] * f[o + 6]);
    v += J * sim.vol0[p];
    v0 += sim.vol0[p];
  }
  near(v, v0, 5e-3, `W ${W * 1e3} mm: the volume of the steel is kept`);
}
ok(spreadOf[2e-3] > spreadOf[4e-3], 'the narrower strip spreads more', `${(spreadOf[2e-3] * 100).toFixed(2)} % at 2 mm, ${(spreadOf[4e-3] * 100).toFixed(2)} % at 4 mm`);

done();
