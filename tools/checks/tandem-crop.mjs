// Tandem with the middle of the strip cut out for the next stand (handoff 'crop': src/mpm/tandem.ts cropColumns /
// cropOut, src/mpm/solid/tandem3.ts cropColumns3 / cropOut3), 4 cells, about 3 min:
// - the crop is the middle of the strip, as long as the next stand needs to get steady (steadyLength at the entry
//   thickness h0 (1 − r)); a strip no longer than that has no crop (it is carried whole, as with 'done')
// - the stand ends ('cropped') once the crop is out of the rolls, before the tail is; the next strip is the crop's
//   columns only (their mass), about steadyLength long, and gets steady (a 'crop' handoff again, then the last
//   stand to the end)
// - the stands' steady forces are the 'steady' handoff's (the same strip in the bite): the section model and the
//   3D model (W 1 mm, the width held)
// @check 600s
import { ok, between, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { READ_STEPS, TandemSim, cropColumns, steadyLength } from '../../src/mpm/tandem.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3, cropColumns3, steadyLength3 } from '../../src/mpm/solid/tandem3.ts';

const base = (L) => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = L;
  return P;
};

// ── the section model: 3 stands, a strip 20 mm long
{
  const T = new TandemSim(base(20e-3), 3, READ_STEPS, 'crop');
  const crop = T.crop;
  const s = T.sim;
  const next = { ...base(20e-3) };
  next.rolling.h0 *= 1 - next.rolling.reduction;
  const need = steadyLength(next, READ_STEPS);
  ok(crop !== null, 'a strip 20 mm long has a crop', JSON.stringify(crop));
  if (crop) {
    const cols = crop[1] - crop[0] + 1;
    near((cols - 2) * s.dp, need * (1 - s.params.rolling.reduction), 0.05, 'the crop is steadyLength of the next stand, at the entry pitch');
    ok(Math.abs(crop[0] - (s.NI - 1 - crop[1])) <= 1, 'the crop is the middle of the strip', `columns ${crop[0]} … ${crop[1]} of ${s.NI}`);
  }
  ok(cropColumns(new TandemSim(base(8e-3), 2, READ_STEPS, 'crop').sim) === null, 'a strip no longer than the crop has none (carried whole)');
  let massCrop = NaN;
  let tailOut = NaN;
  T.onStandDone = ({ stand, sim, next: n }) => {
    if (stand !== 0 || !n || !crop) return;
    massCrop = 0;
    for (let i = crop[0]; i <= crop[1]; i++) {
      for (let j = 0; j < sim.NJ; j++) {
        const p = sim.lattice[i * sim.NJ + j];
        if (p >= 0 && sim.active[p]) massCrop += sim.mass[p];
      }
    }
    let m = 0;
    for (let p = 0; p < n.n; p++) m += n.mass[p];
    massCrop = m / massCrop;
    // the tail of the strip: still in the rolls or before them
    tailOut = Math.min(...Array.from({ length: sim.NJ }, (_, j) => sim.px[sim.lattice[j]]).filter(Number.isFinite)) - sim.xExitProbe;
  };
  while (!T.done && T.stepOffset + T.sim.step < 400000) T.advance();
  const R = T.results;
  ok(R.length === 3 && R[0].phase === 'cropped' && R[1].phase === 'cropped' && R[2].phase === 'done' && !T.stopped, 'stands 1 and 2 handed on their crops, the last rolled to the end', R.map((r) => r.phase).join(', '));
  near(massCrop, 1, 1e-9, 'the next strip is the crop\'s mass');
  ok(tailOut < 0, 'handed on before the tail was out of the rolls', `tail ${(tailOut * 1e3).toFixed(2)} mm from the exit probe`);
  ok(R.every((r) => r.steadyForce > 0), 'every stand gets steady');
  const S = new TandemSim(base(20e-3), 3, READ_STEPS, 'steady');
  while (!S.done && S.stepOffset + S.sim.step < 400000) S.advance();
  for (let k = 0; k < 3; k++) near(R[k].steadyForce, S.results[k].steadyForce, 0.02, `stand ${k + 1} force = the 'steady' handoff's`, `${(R[k].steadyForce * 1e-6).toFixed(3)} vs ${(S.results[k].steadyForce * 1e-6).toFixed(3)} kN/mm`);
}

// ── the 3D model: 2 stands, W 1 mm with the width held, a strip 16 mm long
{
  const P = solidParams(base(16e-3), { width: 1e-3, planeStrain: true });
  const T = new Tandem3(P, 2, 'crop');
  const crop = T.crop;
  const next = { ...P, rolling: { ...P.rolling, h0: P.rolling.h0 * (1 - P.rolling.reduction) }, solid: { ...P.solid } };
  const need = steadyLength3(next);
  ok(crop !== null && crop[0] > 0 && crop[1] < T.sim.NI - 1, 'a 3D strip 16 mm long has a crop in its middle', JSON.stringify(crop));
  ok(cropColumns3(new Sim3(solidParams(base(6e-3), { width: 1e-3, planeStrain: true }))) === null, 'a short one has none');
  let length = NaN;
  T.onStandDone = ({ stand, next: n }) => {
    if (stand === 0 && n) length = n.params.rolling.sheetLength;
  };
  while (!T.done && T.stepOffset + T.sim.step < 400000) T.advance();
  const R = T.results;
  ok(R.length === 2 && R[0].phase === 'cropped' && R[1].phase === 'done' && !T.stopped, 'stand 1 handed on its crop, stand 2 rolled to the end', R.map((r) => r.phase).join(', '));
  between(length / need, 1, 1.2, 'the next strip is about steadyLength3 long', `${(length * 1e3).toFixed(2)} vs ${(need * 1e3).toFixed(2)} mm`);
  const S = new Tandem3(P, 2, 'steady');
  while (!S.done && S.stepOffset + S.sim.step < 400000) S.advance();
  for (let k = 0; k < 2; k++) {
    const f = R[k].steady?.force ?? NaN;
    const g = S.results[k].steady?.force ?? NaN;
    near(f, g, 0.02, `3D stand ${k + 1} force = the 'steady' handoff's`, `${(f * 1e-3).toFixed(3)} vs ${(g * 1e-3).toFixed(3)} kN`);
  }
}
done();
