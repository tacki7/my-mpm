// Material instability indicators, two of the failure criteria of Banerjee (2012):
// loss of ellipticity of the elastic-plastic tangent (the acoustic tensor turns
// singular for some band normal, so a shear band can form) and Drucker's stability
// postulate σ̇ : Dp > 0. Pure functions of the state the solver keeps.
//
// J2 flow with isotropic hardening H = dσy/dεp, plane strain. The tangent is
//
//   C_ep = K I⊗I + 2G I_dev − 6G²/(3G + H) n̂⊗n̂,   n̂ = s/|s|   (|n̂| = 1)
//
// For a band normal n = (cos θ, sin θ) in the x-y plane the acoustic tensor
// A = n·C_ep·n splits into the in-plane 2×2 block and A_zz = G (n̂ has no xz, yz
// part), and with the elastic block A_e = G I + (K + G/3) n⊗n
//
//   det A(θ) / det A_e = 1 − 6G/(3G + H) (|a|² − β (a·n)²),   a = n̂·n,   β = (K + G/3)/(K + 4G/3)
//
// (det A_e = G (K + 4G/3) does not depend on θ). In the principal axes of the in-plane
// block of n̂ (values λ1 ≥ λ2) the bracket is a concave quadratic in c = cos 2θ', so the
// minimum over θ is found in closed form. For in-plane plastic flow (s_zz = 0) the
// minimum is H/(3G + H) at ±45° to the principal axes: a band needs H ≤ 0 (Rudnicki &
// Rice 1975). The tangent leaves out the stress terms of the objective rate, which are
// of order σ/G.
import type { Elastic } from './material.ts';

export interface Localization {
  /** min over the band normal of det A / det A_e: 1 elastic, ≤ 0 a band can form */
  ratio: number;
  /** angle of that band normal from +x [rad], in (−π/2, π/2]; the other band is its mirror in the principal axes */
  theta: number;
}

/**
 * Loss of ellipticity for the deviatoric stress (sxx, syy, sxy, szz) [Pa] with the
 * hardening modulus H [Pa]; H = Infinity for a point that is not flowing (elastic).
 */
export function localization(el: Elastic, H: number, sxx: number, syy: number, sxy: number, szz: number): Localization {
  const { K, G } = el;
  const ss = sxx * sxx + syy * syy + szz * szz + 2 * sxy * sxy;
  if (!(H < Infinity) || !(ss > 0)) return { ratio: 1, theta: 0 };
  const k = (6 * G) / (3 * G + H);
  const beta = (K + G / 3) / (K + (4 * G) / 3);
  const inv = 1 / Math.sqrt(ss);
  const nxx = sxx * inv;
  const nyy = syy * inv;
  const nxy = sxy * inv;
  // principal axes of the in-plane block
  const m0 = 0.5 * (nxx + nyy);
  const m1 = Math.hypot(0.5 * (nxx - nyy), nxy); // (λ1 − λ2)/2
  const thetaP = 0.5 * Math.atan2(2 * nxy, nxx - nyy);
  // bracket g(c) = (λ1² + λ2²)/2 + (λ1² − λ2²)/2 c − β (m0 + m1 c)², with (λ1² − λ2²)/2 = 2 m0 m1
  let c = 0;
  if (m1 > 1e-12) {
    c = (m0 * (1 - beta)) / (beta * m1);
    if (c > 1) c = 1;
    else if (c < -1) c = -1;
  }
  const g = m0 * m0 + m1 * m1 + 2 * m0 * m1 * c - beta * (m0 + m1 * c) * (m0 + m1 * c);
  let theta = thetaP + 0.5 * Math.acos(c);
  if (theta > Math.PI / 2) theta -= Math.PI;
  else if (theta <= -Math.PI / 2) theta += Math.PI;
  return { ratio: 1 - k * g, theta };
}

/**
 * Drucker's second-order work of one plastic step, Δσ : Δεp = (Δs : N) Δεp with the flow
 * direction N = (3/2) s/q at the end of the step [Pa]. `ds*` is the change of the deviatoric
 * stress over the step against the rotated start (the Jaumann rate); the pressure drops out
 * because N is deviatoric. Divided by Δεp² it is σ̇ : Dp / ε̇p², which for proportional
 * loading is the slope of the flow stress H; negative means unstable (softening).
 */
export function druckerWork(
  dsxx: number,
  dsyy: number,
  dsxy: number,
  dszz: number,
  sxx: number,
  syy: number,
  sxy: number,
  szz: number,
  q: number,
  dep: number,
): number {
  if (!(dep > 0) || !(q > 0)) return 0;
  return (1.5 * (dsxx * sxx + dsyy * syy + 2 * dsxy * sxy + dszz * szz) * dep) / q;
}
