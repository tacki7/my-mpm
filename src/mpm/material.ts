// Constitutive laws: flow stress, the J2 radial return, and the damage indicators.
// Pure functions so the node checks can test them without a simulation.
import type { DamageParams, GtnParams, MaterialParams } from './params.ts';

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

/** Effective porosity f* of the GTN yield condition: f up to fc, accelerated by k beyond (coalescence). */
export function gtnFstar(g: GtnParams, f: number): number {
  return f <= g.fc ? f : g.fc + g.k * (f - g.fc);
}

/** Strain-controlled nucleation rate A = df/dεM: a normal distribution of nucleation strains (Chu & Needleman 1980). */
export function gtnNucleation(g: GtnParams, epM: number): number {
  const z = (epM - g.en) / g.sn;
  return (g.fn / (g.sn * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
}

/** GTN yield function Φ(q, σm) at matrix flow stress sy and effective porosity fs (σm = tr σ / 3, tension positive). */
export function gtnYield(g: GtnParams, q: number, sm: number, sy: number, fs: number): number {
  const r = q / sy;
  return r * r + 2 * g.q1 * fs * Math.cosh((1.5 * g.q2 * sm) / sy) - (1 + g.q3 * fs * fs);
}

export interface GtnStep {
  q: number; // returned von Mises stress
  sm: number; // returned mean stress σm (tension positive)
  dEq: number; // equivalent deviatoric plastic strain increment
  dEv: number; // plastic volume strain increment tr Δεp (dilation positive)
  dEm: number; // equivalent plastic strain increment of the matrix
  df: number; // porosity increment (growth + nucleation)
}

/**
 * GTN return mapping from the elastic trial state (q_tr, σm_tr), after Aravas (1987): the plastic
 * strain increment is Δεv I/3 + Δεq n along the trial deviator n, so q = q_tr − 3G Δεq and
 * σm = σm_tr − K Δεv. Newton on Φ = 0 and the normality condition Δεv ∂Φ/∂q − Δεq ∂Φ/∂σm = 0.
 * The porosity in Φ is the one at the start of the step; the matrix flow stress is taken at
 * εM + ΔεM with (1 − f) σf ΔεM = q Δεq + σm Δεv (equal plastic work). With f = 0 this is the J2
 * radial return. Null when the trial state is elastic.
 */
export function gtnReturn(
  m: MaterialParams,
  g: GtnParams,
  K: number,
  G: number,
  qTr: number,
  smTr: number,
  epM: number,
  f: number,
  epsDot: number,
  T: number,
): GtnStep | null {
  const fs = gtnFstar(g, f);
  let sy = flowStress(m, epM, epsDot, T).sy;
  if (gtnYield(g, qTr, smTr, sy, fs) <= 0) return null;
  const c = 1.5 * g.q2;
  const B = 1.5 * g.q1 * g.q2 * fs; // (σf/2) ∂Φ/∂σm = B sinh(c σm/σf)
  const omf = 1 - f;
  // start from the von Mises return on the trial mean stress
  const t0 = 1 + g.q3 * fs * fs - 2 * g.q1 * fs * Math.cosh((c * smTr) / sy);
  let x1 = t0 > 0 ? Math.max(0, (qTr - sy * Math.sqrt(t0)) / (3 * G)) : qTr / (6 * G);
  let x2 = 0;
  let q = qTr;
  let sm = smTr;
  let dEm = 0;
  for (let it = 0; it < 50; it++) {
    q = qTr - 3 * G * x1;
    sm = smTr - K * x2;
    const w = q * x1 + sm * x2;
    dEm = w > 0 ? w / (omf * sy) : 0;
    const fl = flowStress(m, epM + dEm, epsDot, T);
    sy = fl.sy;
    const u = (c * sm) / sy;
    const ch = Math.cosh(u);
    const sh = Math.sinh(u);
    const r = q / sy;
    const R1 = r * r + 2 * g.q1 * fs * ch - (1 + g.q3 * fs * fs);
    const R2 = x2 * r - x1 * B * sh; // (σf/2) × normality
    if (Math.abs(R1) < 1e-11 && Math.abs(R2) <= 1e-11 * (x1 + Math.abs(x2))) break;
    // Jacobian; σf enters R1 through ΔεM
    const dR1ds = (-2 * r * r - 2 * g.q1 * fs * sh * u) / sy;
    const hs = w > 0 ? fl.H / (omf * sy) : 0;
    const J11 = (-6 * G * r) / sy + dR1ds * hs * (q - 3 * G * x1);
    const J12 = (-2 * g.q1 * fs * sh * c * K) / sy + dR1ds * hs * (sm - K * x2);
    const J21 = (-3 * G * x2) / sy - B * sh;
    const J22 = r + (x1 * B * ch * c * K) / sy;
    const det = J11 * J22 - J12 * J21;
    if (!(Math.abs(det) > 0)) break;
    const d1 = (-R1 * J22 + R2 * J12) / det;
    const d2 = (-R2 * J11 + R1 * J21) / det;
    x1 = Math.min(qTr / (3 * G), Math.max(0, x1 + d1));
    x2 += d2;
  }
  q = qTr - 3 * G * x1;
  sm = smTr - K * x2;
  const w = q * x1 + sm * x2;
  dEm = w > 0 ? w / (omf * sy) : 0;
  const A = g.nucleation === 'tension' && sm <= 0 ? 0 : gtnNucleation(g, epM);
  const df = omf * x2 + A * dEm;
  return { q, sm, dEq: x1, dEv: x2, dEm, df };
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
