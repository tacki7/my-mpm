// Stress-state quantities for the stress explorer. Pure functions (no DOM), so
// the node checks can test them. Cauchy stress, plane strain: zz is a principal
// direction.

export interface Principal {
  s1: number;
  s2: number;
  s3: number;
}

/** Principal stresses, s1 ≥ s2 ≥ s3, of the in-plane (xx, yy, xy) state and σzz. */
export function principal(sxx: number, syy: number, sxy: number, szz: number): Principal {
  const c = 0.5 * (sxx + syy);
  const r = Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);
  const v = [c + r, c - r, szz].sort((a, b) => b - a);
  return { s1: v[0], s2: v[1], s3: v[2] };
}

/**
 * Lode parameter (2σ2 − σ1 − σ3)/(σ1 − σ3): −1 in uniaxial tension, +1 in uniaxial
 * compression, 0 in pure shear — and in plane-strain J2 flow, where σzz is the
 * mean of the in-plane principal stresses. 0 when the state is hydrostatic.
 */
export function lodeParameter(p: Principal): number {
  const d = p.s1 - p.s3;
  return d > 1e-9 * (Math.abs(p.s1) + Math.abs(p.s3)) ? (2 * p.s2 - p.s1 - p.s3) / d : 0;
}

/**
 * Cockcroft-Latham as a fracture strain, in plane strain: ∫ max(σ1, 0)/σeq dεp = C with
 * σ1 = σm + σeq/√3 (plane-strain J2 flow) gives εf = C / (η + 1/√3) at constant η.
 * Infinite where σ1 ≤ 0 (η ≤ −1/√3).
 */
export function clFractureStrainPlaneStrain(clCrit: number, eta: number): number {
  const a = eta + 1 / Math.sqrt(3);
  return a > 0 ? clCrit / a : Infinity;
}
