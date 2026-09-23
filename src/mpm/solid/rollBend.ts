// The bending of a roll under the strip's load, as a beam (docs/model.md「ロールの撓み」): a solid cylinder of
// diameter D, simply supported at z = ±span/2 (the barrel's ends, or the bearings), loaded by the strip about its
// middle. Euler-Bernoulli bending plus Timoshenko shear: a roll is stubby (D / span of a third or so), so the
// shear adds a fifth or more to the deflection. Pure arithmetic on a grid along z, so it is checked in node
// against the closed forms (tools/checks/roll-bend.mjs). The load and the deflection are symmetric about z = 0,
// so one half is enough: q_k at z_k = k dz.
export interface Beam {
  /** the roll's diameter [m] */
  D: number;
  /** the distance between the supports [m] */
  span: number;
  /** Young's modulus [Pa] and Poisson's ratio of the roll */
  E: number;
  nu: number;
}

/** Cowper's shear coefficient of a solid circular section */
export const shearCoefficient = (nu: number): number => (6 * (1 + nu)) / (7 + 6 * nu);

/**
 * The deflection of the roll's axis away from the strip [m] at z_k = k dz, k = 0 .. nOut − 1, under the load
 * q_k [N/m] (one half of a load symmetric about z = 0; nothing beyond q's last node), zero at the supports and
 * beyond them. The load is integrated by the trapezoid rule on the grid, which puts half of q_0 on the half z ≥ 0:
 * with a nodal force F_k at z_k the load is q_k = F_k / dz, q_0 counting the whole force on the mid-node.
 */
export function beamDeflection(q: ArrayLike<number>, dz: number, beam: Beam, nOut: number): Float64Array {
  const out = new Float64Array(nOut);
  const zS = beam.span / 2;
  if (!(zS > 0) || !(dz > 0)) return out;
  const { E, nu, D } = beam;
  const I = (Math.PI * D ** 4) / 64;
  const A = (Math.PI * D * D) / 4;
  const G = E / (2 * (1 + nu));
  const kGA = shearCoefficient(nu) * G * A;
  // the grid to the support: n cells of dz, the last one shortened to end at zS
  const n = Math.max(1, Math.ceil(zS / dz - 1e-9));
  const z = (i: number) => Math.min(i * dz, zS);
  const qAt = (i: number) => (i < q.length ? q[i] : 0);
  // the load points away from the strip (+): the shear force V = ∫ q from the middle, the bending moment
  // M = M0 + ∫ V with M(zS) = 0 at the support (M0 < 0: the roll hogs toward the strip's side)
  const V = new Float64Array(n + 1);
  const M = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) V[i] = V[i - 1] + 0.5 * (qAt(i - 1) + qAt(i)) * (z(i) - z(i - 1));
  for (let i = 1; i <= n; i++) M[i] = M[i - 1] + 0.5 * (V[i - 1] + V[i]) * (z(i) - z(i - 1));
  const M0 = -M[n];
  // EI y'' = M: the slope θ = ∫ M / EI from the middle (θ(0) = 0 by symmetry) and the bending deflection ∫ θ, both
  // measured from the middle; the shear slope is V / κGA. The deflection is taken from the support, where it is 0
  const theta = new Float64Array(n + 1);
  const yb = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) theta[i] = theta[i - 1] + (0.5 * (M[i - 1] + M[i] + 2 * M0) * (z(i) - z(i - 1))) / (E * I);
  for (let i = 1; i <= n; i++) yb[i] = yb[i - 1] + 0.5 * (theta[i - 1] + theta[i]) * (z(i) - z(i - 1));
  for (let i = 1; i <= n; i++) ys[i] = ys[i - 1] + (0.5 * (V[i - 1] + V[i]) * (z(i) - z(i - 1))) / kGA;
  for (let k = 0; k < nOut; k++) {
    if (k > n) break;
    out[k] = yb[k] - yb[n] + (ys[n] - ys[k]);
  }
  return out;
}
