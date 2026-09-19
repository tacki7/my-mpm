// The central-burst preset shows a centre crack, and it comes from the stress state, not from the
// weak band alone (about 15 s):
// - thick plate (Δ = mean thickness / contact length ≈ 3.6, 12 cells): the centre flows under hydrostatic
//   tension, the centreline segregation band (ductility 1/50) cracks there, η > 0 at failure
// - the same material, damage constants and band (half width 5 % of h0) in the standard thin sheet
//   (Δ 0.18, 6 cells): the centre flows in compression (η ≈ −0.7), damage never grows (cutoff η 0), no crack
// docs/presets.md has the ductility and grid table: 1/50 is near the threshold at 12 cells (1/20 reaches D 0.44),
// so a change that lowers the centre's triaxiality by a quarter shows here first.
// @check
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { presetById } from '../../src/mpm/presets.ts';

function run(P, stopAtCrack) {
  const sim = new Sim(P);
  let d;
  while (sim.step < 300000) {
    for (let k = 0; k < 250; k++) sim.advance();
    d = sim.diagnostics();
    if (stopAtCrack && sim.cracks.length > 0) break;
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  return { sim, d };
}

const cb = presetById('central-burst').build();
const h0 = cb.rolling.h0;
{
  const { sim } = run(cb, true);
  const c = sim.cracks[0];
  ok(c !== undefined, 'central burst: the plate cracks', `${sim.cracks.length} cracks by step ${sim.step}`);
  if (c) {
    between(Math.abs(c.sheetY) / h0, 0, 0.25, 'central burst: the first crack is at the plate centre (|y| / h0)');
    between(c.eta, 0, 2, 'central burst: under hydrostatic tension when it fails (η)');
  }
}
{
  // the thin standard sheet with the preset's material, damage constants and a band at 5 % of its thickness
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  P.material = { ...cb.material };
  P.damage = { ...cb.damage };
  const band = cb.defects[0];
  const L = P.rolling.sheetLength;
  P.defects = [{ ...band, x: L / 2, ax: L / 2 - 1e-3, ay: (band.ay / h0) * P.rolling.h0 }];
  const { sim, d } = run(P, false);
  ok(d.phase === 'done' && sim.cracks.length === 0, 'the same band in the thin standard sheet does not crack', `${sim.cracks.length} cracks, phase ${d.phase}`);
  between(d.maxDamage, 0, 0.01, 'and its damage hardly grows (the centre flows in compression)');
}
done();
