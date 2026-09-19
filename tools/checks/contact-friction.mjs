// Coulomb friction on the roll contact counts every normal impulse on a node, the projection's and the
// one followRoll adds so that a touching point follows the roll (1 to 3 % of the force). On the nodes
// that slide, the tangential impulse is μ times the normal one; followRoll's part used to be left out,
// so the sliding nodes carried 0.0790 at μ 0.08. Also the points do not sink into the rolls, measured
// along the roll normal: the deformed height |F e_y| grows with shear (0.12 dp at high friction) though
// the edge along n stays out. Standard pass (6 cells) and the high-friction preset (4 cells, μ 0.25),
// a few steady windows each (about 20 s).
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';

function pass(name, P) {
  const sim = new Sim(P);
  const { NI, NJ, lattice, rolls, dp } = sim;
  const nNodes = sim.nxN * sim.nyN;
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
  const mu = P.rolling.mu;
  ok(windows >= 2 && sliding > 100, `${name}: steady, nodes sliding on the rolls`, `${windows} windows, ${sliding} node-steps`);
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
