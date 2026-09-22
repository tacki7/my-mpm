// The roll's bending (src/mpm/solid/rollBend.ts, Sim3.updateBend; docs/model.md「ロールの撓み」):
// - the beam solver against the closed forms of a simply supported beam: a point load at the middle and a
//   uniform load, bending plus Timoshenko shear; zero at the supports; a longer span bends more
// - in a pass (W 2 mm, R 10 mm, barrel 60 mm, 4 cells, about 20 s each way): the pass reaches 'steady', the roll
//   bends away from the strip, more at the mid-width than at the strip's edge, and the strip comes out thicker
//   than with a rigid roll by about twice the deflection (both rolls bend); a barrel shorter than the strip is refused
// @check
import { ok, near, between, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { ROLL_E, ROLL_NU } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { READ_STEPS, SolidSampler } from '../../src/mpm/solid/steady.ts';
import { beamDeflection, shearCoefficient } from '../../src/mpm/solid/rollBend.ts';

// ── the beam
const beam = { D: 0.02, span: 0.06, E: ROLL_E, nu: ROLL_NU };
const I = (Math.PI * beam.D ** 4) / 64;
const A = (Math.PI * beam.D ** 2) / 4;
const G = beam.E / (2 * (1 + beam.nu));
const kGA = shearCoefficient(beam.nu) * G * A;
const L = beam.span;
const dz = L / 400;
const n = Math.round(L / 2 / dz);

// a point load P at the middle: q_0 = P / dz counts the whole force on the mid-node
const P = 3000;
const point = beamDeflection([P / dz], dz, beam, n + 3);
const dPoint = (P * L ** 3) / (48 * beam.E * I) + (P * L) / (4 * kGA);
near(point[0], dPoint, 2e-3, 'a point load at the middle: the deflection there is P L³ / 48EI + P L / 4κGA');
ok((P * L) / (4 * kGA) / dPoint > 0.15, 'the shear is a good part of it on a roll this stubby (D / span = 1/3)', `${(((P * L) / (4 * kGA) / dPoint) * 100).toFixed(0)} %`);
ok(point[n] === 0 && point[n + 1] === 0 && point[n + 2] === 0, 'zero at the support and beyond');
// a quarter of the span from the middle (a = L/4 from the support): P a (3L² − 4a²) / 48EI, and the shear slope V / κGA = P / 2κGA
const a = L / 4;
const dq = (P * a * (3 * L * L - 4 * a * a)) / (48 * beam.E * I) + (P * a) / (2 * kGA);
near(point[n / 2], dq, 3e-3, 'a point load: the deflection a quarter of the span from the middle');

// a uniform load q over the whole span
const q = 5e4;
const uniform = beamDeflection(new Float64Array(n + 1).fill(q), dz, beam, n + 1);
near(uniform[0], (5 * q * L ** 4) / (384 * beam.E * I) + (q * L * L) / (8 * kGA), 2e-3, 'a uniform load: 5 q L⁴ / 384EI + q L² / 8κGA at the middle');

// the same strip load with the supports further out bends more
const wide = beamDeflection([P / dz], dz, { ...beam, span: 1.5 * L }, 2);
ok(wide[0] > 2.5 * point[0], 'the same load on a span 1.5 times longer deflects more than 2.5 times as much (L³ in bending)', `${(wide[0] / point[0]).toFixed(2)}×`);

// ── in a pass
function pass(rollBend) {
  const P0 = defaultParams();
  P0.numerics.cellsThrough = 4;
  P0.rolling.sheetLength = 12e-3;
  P0.rolling.rollRadius = 10e-3;
  P0.damage.model = 'none';
  const sim = new Sim3(solidParams(P0, { width: 2e-3, planeStrain: false, ...(rollBend ? { rollBend } : {}) }));
  const sampler = new SolidSampler();
  let looks = 0;
  while (sim.step < 40000) {
    for (let k = 0; k < READ_STEPS; k++) sim.advance();
    const look = sampler.look(sim);
    if (look.phase === 'steady') looks++;
    if (looks >= 4 || look.phase === 'done' || look.phase === 'stalled') break;
  }
  return { sim, st: sampler.means(sim), phase: sim.phase() };
}

let refused = false;
try {
  pass({ barrel: 1e-3 });
} catch (e) {
  refused = /wider/.test(String(e));
}
ok(refused, 'a barrel shorter than the strip is refused');

const rigid = pass(null);
const bent = pass({ barrel: 60e-3 });
ok(rigid.st && rigid.st.rollBend === null, 'a rigid roll reports no deflection');
ok(bent.st !== null && bent.sim.bendSettled, 'the bending pass reaches steady (the deflection settled)', `phase ${bent.phase}`);
if (bent.st && rigid.st) {
  const { centre, edge } = bent.st.rollBend;
  between(centre, 2e-6, 20e-6, 'the roll bends a few µm away from the strip (R 10 mm, 3 kN on 60 mm)');
  ok(centre > edge && edge > 0, "more at the mid-width than at the strip's edge, both away from the strip", `${(centre * 1e6).toFixed(3)} vs ${(edge * 1e6).toFixed(3)} µm`);
  const dh = 2 * (bent.st.halfThickness[0] - rigid.st.halfThickness[0]);
  near(dh, 2 * centre, 0.35, 'the strip comes out thicker by about twice the deflection (both rolls bend)');
  ok(bent.st.force < rigid.st.force, 'the force is lower with the smaller reduction', `${(bent.st.force * 1e-3).toFixed(3)} vs ${(rigid.st.force * 1e-3).toFixed(3)} kN`);
}

done();
