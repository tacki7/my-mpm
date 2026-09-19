// Coulomb friction on the roll contact counts every normal impulse on a node, the projection's and the
// one followRoll adds so that a touching point follows the roll (1 to 3 % of the force). On the nodes
// that slide, the tangential impulse is μ times the normal one; followRoll's part used to be left out,
// so the sliding nodes carried 0.984 μ here (0.0787 at μ 0.08). Also the points do not sink into the
// rolls, measured along the roll normal: the deformed height |F e_y| grows with shear (0.12 dp at high
// friction) though the edge along n stays out. Standard pass (6 cells) and the high-friction preset
// (4 cells, μ 0.25), a few steady windows each (about 20 s).
// The ratio above uses the solver's own impulses; independently of them, each node one roll holds is
// checked from its velocity before the contact (what projectRoll is given) and after the whole grid
// update (followRoll included): the tangential change is at most μ times the normal one, and the slip
// against the roll neither reverses nor grows. (A node both rolls hold shares each roll's slip by its
// weight, an approximation; it is left out here.)
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';

function pass(name, P) {
  const sim = new Sim(P);
  const { NI, NJ, lattice, rolls, dp, h, ox, oy, nyN } = sim;
  const nNodes = sim.nxN * sim.nyN;
  const mu = P.rolling.mu;
  // the velocity each node had before the contact, from the calls to projectRoll
  const pre = new Map();
  const project = sim.projectRoll;
  sim.projectRoll = function (k, vx, vy, xi, yi, ...rest) {
    pre.set(Math.round((xi - ox) / h) * nyN + Math.round((yi - oy) / h), [vx, vy, xi, yi]);
    return project.call(this, k, vx, vy, xi, yi, ...rest);
  };
  let audited = 0;
  let excess = 0; // largest |Δv_t| / (μ Δv_n) - 1
  let reversed = 0;
  let grown = 0;
  const update = sim.gridUpdate;
  sim.gridUpdate = function () {
    pre.clear();
    update.call(this);
    for (const [idx, [vx, vy, xi, yi]] of pre) {
      const c = sim.gcon[idx];
      if (c !== 1 && c !== 2) continue; // not held, or held by both rolls
      if (sim.pusherActive && sim.gpush[idx]) continue; // the pusher sets vx after the contact
      const roll = rolls[c === 1 ? 0 : 1];
      const d = Math.hypot(xi - roll.cx, yi - roll.cy);
      const [nx, ny] = [(xi - roll.cx) / d, (yi - roll.cy) / d];
      const [ux, uy] = [-roll.omega * roll.R * ny, roll.omega * roll.R * nx];
      const [wx, wy] = [sim.gvx[idx], sim.gvy[idx]];
      const dn = (wx - vx) * nx + (wy - vy) * ny;
      const dt = Math.hypot(wx - vx - dn * nx, wy - vy - dn * ny);
      const s0 = -(vx - ux) * ny + (vy - uy) * nx; // slip along the tangent (−n_y, n_x)
      const s1 = -(wx - ux) * ny + (wy - uy) * nx;
      const scale = Math.abs(dn) + Math.abs(s0) + 1e-30;
      audited++;
      if (dt > mu * dn) excess = Math.max(excess, (dt - mu * dn) / scale);
      if (s0 * s1 < 0 && Math.abs(s1) > 1e-9 * scale) reversed++;
      if (Math.abs(s1) > Math.abs(s0) + 1e-9 * scale) grown++;
    }
  };
  let jn = 0;
  let jt = 0;
  let sliding = 0;
  let sink = 0;
  let windows = 0;
  while (sim.step < 200000 && windows < 3) {
    for (let k = 0; k < 250; k++) {
      sim.advance();
      for (let i = 0; i < nNodes; i++) {
        if (!sim.contactSlip[i]) continue;
        jn += sim.contactJn[i];
        jt += sim.contactJt[i];
        sliding++;
      }
      if (k % 25 !== 0) continue;
      // the outermost points' edge along the roll normal
      for (let i = 0; i < NI; i++) {
        for (const [r, j] of [[0, NJ - 1], [1, 0]]) {
          const q = lattice[i * NJ + j];
          if (q < 0 || !sim.active[q]) continue;
          const roll = rolls[r];
          const [rx, ry] = [sim.px[q] - roll.cx, sim.py[q] - roll.cy];
          const d = Math.hypot(rx, ry);
          const half = 0.5 * dp * Math.abs((rx / d) * sim.f01[q] + (ry / d) * sim.f11[q]);
          sink = Math.max(sink, (roll.R + half - d) / dp);
        }
      }
    }
    const d = sim.diagnostics();
    if (d.phase === 'steady') windows++;
    else if (windows > 0 || d.phase === 'done') break;
  }
  ok(windows >= 2 && sliding > 100, `${name}: steady, nodes sliding on the rolls`, `${windows} windows, ${sliding} node-steps`);
  ok(audited > 1000 && excess < 1e-9, `${name}: from the velocities, |Δv_t| ≤ μ Δv_n on every node one roll holds`, `${audited} node-steps, largest excess ${excess.toExponential(1)} (relative)`);
  ok(reversed === 0 && grown === 0, `${name}: from the velocities, the slip against the roll neither reverses nor grows`, `${reversed} reversed, ${grown} grown`);
  between(jt / jn / mu, 0.999, 1.001, `${name}: tangential / normal impulse on the sliding nodes, over μ = ${mu}`);
  between(sink, 0, 0.02, `${name}: no point edge (along the roll normal) sinks into a roll [dp]`);
}

const std = defaultParams();
std.numerics.cellsThrough = 6;
std.rolling.sheetLength = 8e-3;
pass('standard, 6 cells', std);
const hf = presetById('high-friction').build();
hf.numerics.cellsThrough = 4;
pass('high friction, 4 cells', hf);
done();
