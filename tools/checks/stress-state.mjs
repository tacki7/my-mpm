// The stress-state quantities of the stress explorer (src/app/stress.ts) against
// closed forms: principal stresses, the Lode parameter, and the plane-strain
// Cockcroft-Latham fracture strain.
// @check
import { ok, near, done } from './lib.mjs';
import { clFractureStrainPlaneStrain, lodeParameter, principal } from '../../src/app/stress.ts';

const p = principal(100, -50, 40, 10);
const c = 25;
const r = Math.hypot(75, 40);
ok(p.s1 >= p.s2 && p.s2 >= p.s3, 'principal stresses are ordered s1 ≥ s2 ≥ s3');
near(p.s1 + p.s2 + p.s3, 100 - 50 + 10, 1e-12, 'the trace is kept');
near(p.s1, c + r, 1e-12, 'in-plane principal s1 = c + r (σzz = 10 is the middle one)');

near(lodeParameter(principal(300, 0, 0, 0)), -1, 1e-12, 'uniaxial tension: Lode −1');
near(lodeParameter(principal(-300, 0, 0, 0)), 1, 1e-12, 'uniaxial compression: Lode +1');
near(lodeParameter(principal(0, 0, 200, 0)), 0, 0, 'pure shear: Lode 0');
// plane-strain J2 flow: σzz is the mean of the in-plane principal stresses
near(lodeParameter(principal(-400, -900, 150, -650)), 0, 1e-12, 'plane strain, σzz = mean of the in-plane stresses: Lode 0');
near(lodeParameter(principal(-500, -500, 0, -500)), 0, 0, 'hydrostatic: Lode 0 (not NaN)');

// σ1/σeq = η + 1/√3 in plane-strain J2: the CL integrand at constant η
const s = principal(-100, -700, 120, -400); // σzz = mean → plane strain
const mean = (s.s1 + s.s2 + s.s3) / 3;
const seq = Math.sqrt(0.5 * ((s.s1 - s.s2) ** 2 + (s.s2 - s.s3) ** 2 + (s.s3 - s.s1) ** 2));
near(s.s1 / seq, mean / seq + 1 / Math.sqrt(3), 1e-12, 'plane strain: σ1/σeq = η + 1/√3');
near(clFractureStrainPlaneStrain(0.6, 1 / 3), 0.6 / (1 / 3 + 1 / Math.sqrt(3)), 1e-12, 'CL εf = C/(η + 1/√3)');
ok(clFractureStrainPlaneStrain(0.6, -0.6) === Infinity, 'CL εf is infinite where σ1 ≤ 0 (η ≤ −1/√3)');
done();
