// Failed points under compression (a closed crack in the bite) carry about the pressure the material there
// would: a failed point in compression takes part in the volume averaging ('rate'), and one in tension keeps its
// own rate (an opening crack must not dilate its intact neighbours). On its own rate, the grid's point-to-point
// scatter of tr L gave closed cracks 1.7 to 3.6 times the pressure of the uncut sheet at the same points (up
// to 2.5 GPa). Standard pass, 4 cells, 6 mm, damage off; points cut at the start: a band through the
// thickness (2 columns) and a block at the mid-plane (5 columns × 3 rows); about 10 s.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

function pass(cut) {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 6e-3;
  P.damage = { ...P.damage, model: 'none' };
  const sim = new Sim(P);
  const { NI, NJ, lattice } = sim;
  const i0 = Math.floor(NI / 2) - 1;
  const sets = { band: [], block: [] };
  for (const i of [i0, i0 + 1]) for (let j = 0; j < NJ; j++) sets.band.push(lattice[i * NJ + j]);
  // the block sits in the other half of the sheet, clear of the band
  const k0 = Math.floor(NI / 4);
  for (let i = k0 - 2; i <= k0 + 2; i++) for (let j = NJ / 2 - 2; j <= NJ / 2; j++) sets.block.push(lattice[i * NJ + j]);
  if (cut) {
    let id = 0;
    for (const pts of Object.values(sets)) {
      for (const q of pts) {
        sim.failed[q] = 1;
        sim.crackId[q] = id;
        sim.sxx[q] = sim.syy[q] = sim.szz[q] = sim.sxy[q] = 0;
      }
      sim.cracks.push({ id, t: 0, step: 0, x: 0, y: 0, sheetX: 0, sheetY: 0, eta: 0, s1: 0, seq: 0, ep: 0, criterion: 'none', count: pts.length });
      id++;
    }
  }
  const pmax = { band: 0, block: 0 };
  while (sim.step < 100000 && sim.phase() !== 'done') {
    for (let k = 0; k < 50; k++) {
      sim.advance();
      for (const [name, pts] of Object.entries(sets)) for (const q of pts) pmax[name] = Math.max(pmax[name], sim.pres[q]);
    }
  }
  const finite = [sim.px, sim.py, sim.pres].every((a) => a.every(Number.isFinite));
  return { pmax, done: sim.phase() === 'done', finite };
}

const uncut = pass(false);
const cut = pass(true);
ok(cut.done && cut.finite && uncut.done, 'the cut sheet is rolled through, every value finite');
for (const name of ['band', 'block']) {
  between(cut.pmax[name] / uncut.pmax[name], 0, 1.5, `${name}: the largest pressure on the cut points / on the same points uncut (${(uncut.pmax[name] * 1e-9).toFixed(2)} GPa)`);
}
done();
