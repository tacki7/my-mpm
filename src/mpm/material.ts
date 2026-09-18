// Constitutive laws: flow stress, the J2 radial return, and the damage indicators.
// Pure functions so the node checks can test them without a simulation.
import type { DamageParams, MaterialParams } from './params.ts';

export interface Elastic {
  K: number; // bulk modulus [Pa]
  G: number; // shear modulus [Pa]
  lambda: number;
}

export function elasticConstants(m: MaterialParams): Elastic {
  const K = m.E / (3 * (1 - 2 * m.nu));
  const G = m.E / (2 * (1 + m.nu));
  return { K, G, lambda: K - (2 / 3) * G };
}

export function homologousTemperature(m: MaterialParams, T: number): number {
  const t = (T - m.tRoom) / (m.tMelt - m.tRoom);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Rate factor of the flow stress, 1 + C ln(ε̇/ε̇0), never below 1. */
function rateFactor(m: MaterialParams, epsDot: number): number {
  const r = epsDot / m.epsDot0;
  return r > 1 ? 1 + m.jcC * Math.log(r) : 1;
}

/**
 * Flow stress σy and its slope dσy/dεp at the given plastic strain, strain rate
 * (physical, [1/s]) and temperature [K]. The rate and temperature factors apply
 * to both hardening laws.
 */
export function flowStress(m: MaterialParams, ep: number, epsDot: number, T: number): { sy: number; H: number } {
  const rate = rateFactor(m, epsDot);
  const Ts = homologousTemperature(m, T);
  const thermal = Ts > 0 ? 1 - Math.pow(Ts, m.jcM) : 1;
  const f = rate * thermal;
  if (m.hardening === 'swift') {
    const b = m.swE0 + (ep > 0 ? ep : 0);
    const s = m.swK * Math.pow(b, m.swN);
    return { sy: s * f, H: (s * m.swN * f) / b };
  }
  // the slope B n εp^(n−1) is infinite at εp = 0: evaluate it at a small floor
  const e = ep > 1e-9 ? ep : 1e-9;
  const pw = ep > 0 ? Math.pow(ep, m.jcN) : 0;
  return { sy: (m.jcA + m.jcB * pw) * f, H: m.jcB * m.jcN * Math.pow(e, m.jcN - 1) * f };
}

/**
 * Plastic multiplier of the J2 radial return: the Δεp ≥ 0 that satisfies
 * q_trial − 3G Δεp = σy(εp + Δεp). Returns 0 when the trial state is elastic.
 * Safeguarded Newton (bisection fallback) — the Johnson-Cook slope is infinite at εp = 0.
 */
export function plasticIncrement(
  m: MaterialParams,
  G: number,
  qTrial: number,
  ep: number,
  epsDot: number,
  T: number,
): number {
  const y0 = flowStress(m, ep, epsDot, T).sy;
  if (qTrial <= y0) return 0;
  let lo = 0;
  let hi = qTrial / (3 * G);
  let x = (qTrial - y0) / (3 * G);
  for (let it = 0; it < 30; it++) {
    const { sy, H } = flowStress(m, ep + x, epsDot, T);
    const g = qTrial - 3 * G * x - sy;
    if (Math.abs(g) < 1e-9 * qTrial) break;
    if (g > 0) lo = x;
    else hi = x;
    let nx = x + g / (3 * G + H);
    if (!(nx > lo && nx < hi)) nx = 0.5 * (lo + hi);
    x = nx;
  }
  return x;
}

/** Johnson-Cook fracture strain εf(η, ε̇*, T*) with a small positive floor. */
export function jcFractureStrain(d: DamageParams, eta: number, epsDotStar: number, Ts: number): number {
  const a = d.D1 + d.D2 * Math.exp(d.D3 * eta);
  const b = epsDotStar > 1 ? 1 + d.D4 * Math.log(epsDotStar) : 1;
  const c = 1 + d.D5 * Ts;
  const ef = a * b * c;
  return ef > 1e-3 ? ef : 1e-3;
}

/** Hancock-MacKenzie fracture strain, εf = 1.65 exp(−1.5 η) (Banerjee 2012, eq. for the HM model). */
export function hmFractureStrain(eta: number): number {
  return 1.65 * Math.exp(-1.5 * eta);
}

/** Stress invariants used by the damage laws. Components are Cauchy stress (plane strain: zz is out of plane). */
export interface StressState {
  mean: number; // σm = tr σ / 3
  seq: number; // von Mises
  eta: number; // triaxiality σm/σeq (0 when σeq is tiny)
  s1: number; // maximum principal stress
}

export function stressState(sxx: number, syy: number, sxy: number, szz: number, floor = 1): StressState {
  const mean = (sxx + syy + szz) / 3;
  const dx = sxx - mean;
  const dy = syy - mean;
  const dz = szz - mean;
  const seq = Math.sqrt(1.5 * (dx * dx + dy * dy + dz * dz + 2 * sxy * sxy));
  const c = 0.5 * (sxx + syy);
  const r = Math.sqrt(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy);
  const s1 = Math.max(c + r, szz);
  return { mean, seq, eta: seq > floor ? mean / seq : 0, s1 };
}
