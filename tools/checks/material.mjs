// Constitutive laws against closed forms: flow stress, the J2 radial return,
// the damage laws of Banerjee (arXiv:1201.2439) and the stress invariants.
// @check
import { ok, near, between, done } from './lib.mjs';
import {
  elasticConstants,
  flowStress,
  hmFractureStrain,
  jcFractureStrain,
  plasticIncrement,
  stressState,
} from '../../src/mpm/material.ts';
import { DAMAGE_4340, STEEL_4340, STEEL_SPCC } from '../../src/mpm/params.ts';

// Elastic constants of 4340 from the paper's K and μ.
const el = elasticConstants(STEEL_4340);
near(el.K, 173.3e9, 1e-9, '4340: bulk modulus from E, ν equals the paper K = 173.3 GPa');
near(el.G, 80e9, 1e-9, '4340: shear modulus equals the paper μ = 80 GPa');

// Flow stress at room temperature and the reference rate.
near(flowStress(STEEL_4340, 0.1, 1, 294).sy, 792e6 + 510e6 * Math.pow(0.1, 0.26), 1e-12, 'Johnson-Cook σy(εp = 0.1)');
near(flowStress(STEEL_SPCC, 0.2, 1, 294).sy, 560e6 * Math.pow(0.21, 0.22), 1e-12, 'Swift σy(εp = 0.2)');
near(
  flowStress(STEEL_4340, 0, 1000, 294).sy,
  792e6 * (1 + 0.014 * Math.log(1000)),
  1e-12,
  'rate factor 1 + C ln(ε̇/ε̇0) at 1000 /s',
);

// Radial return: the returned state lies on the yield surface.
for (const [mat, name] of [
  [STEEL_4340, 'Johnson-Cook'],
  [STEEL_SPCC, 'Swift'],
]) {
  const G = elasticConstants(mat).G;
  for (const ep of [0, 0.05, 0.5]) {
    const y0 = flowStress(mat, ep, 1, 294).sy;
    const q = 1.6 * y0;
    const d = plasticIncrement(mat, G, q, ep, 1, 294);
    const res = q - 3 * G * d - flowStress(mat, ep + d, 1, 294).sy;
    ok(d > 0 && Math.abs(res) < 1e-6 * q, `${name}: return to the yield surface from q = 1.6 σy at εp = ${ep}`, `Δεp ${d.toExponential(4)}, residual ${res.toExponential(2)} Pa`);
  }
  ok(plasticIncrement(mat, G, 0.9 * flowStress(mat, 0.1, 1, 294).sy, 0.1, 1, 294) === 0, `${name}: elastic trial state gives Δεp = 0`);
}

// Johnson-Cook fracture strain of 4340 (D1..D5 from the paper).
near(jcFractureStrain(DAMAGE_4340, 1 / 3, 1, 0), 0.05 + 3.44 * Math.exp(-2.12 / 3), 1e-12, 'JC εf at η = 1/3 (uniaxial tension)');
near(jcFractureStrain(DAMAGE_4340, 0, 1, 0), 3.49, 1e-12, 'JC εf at η = 0 (shear)');
ok(jcFractureStrain(DAMAGE_4340, -0.5, 1, 0) > jcFractureStrain(DAMAGE_4340, 0.5, 1, 0), 'JC εf is larger under compression than tension (D3 < 0)');
near(hmFractureStrain(0), 1.65, 1e-12, 'Hancock-MacKenzie εf(0) = 1.65');

// Stress invariants.
let s = stressState(100e6, 0, 0, 0);
near(s.seq, 100e6, 1e-12, 'uniaxial tension: σeq = σ');
near(s.eta, 1 / 3, 1e-12, 'uniaxial tension: η = 1/3');
s = stressState(-100e6, -100e6, 0, -100e6);
ok(s.seq < 1e-3 && s.eta === 0, 'hydrostatic state: σeq = 0 and η reported as 0');
s = stressState(0, 0, 50e6, 0);
near(s.s1, 50e6, 1e-12, 'pure shear: σ1 = τ');
between(stressState(200e6, 100e6, 0, 150e6).eta, 0.5, 2, 'plane-strain tension state has high triaxiality');

done();
