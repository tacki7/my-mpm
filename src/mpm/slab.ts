// Slab method for the roll bite: von Kármán's equation in plane strain with
// Coulomb friction and rigid rolls, the reference the MPM's load is compared with.
//
// Coordinates as in the solver: x along rolling, the exit plane (minimum gap) at
// x = 0, the entry at x = −L; everything per unit width and per roll.
//
// A slab of the full thickness h(x) = hf + 2(R − √(R² − x²)) carries σx (tension
// positive) and is pressed by p (normal to the roll) and dragged by τ = μp, which
// points towards the neutral point on both sides of it. Equilibrium along x:
//
//   d(σx h)/dx = 2p (tan φ − s μ),   tan φ = −x/√(R² − x²),   s = +1 entry side, −1 exit side
//
// with the plane-strain yield condition p + σx = 2k(x) (2k = 2σy/√3, von Mises).
// The flow stress follows the material along the bite: εp = (2/√3) ln(h0/h) and the
// strain rate of the mass flow, scaled to the mill speed like the solver does.
// Integrated from the entry (σx = back tension) and from the exit (σx = front
// tension); the neutral point is where the two pressures meet, and the pressure
// is the lower of the two (the friction hill).
import { flowStress } from './material.ts';
import { biteGeometry, hitchcockRadius, type MaterialParams, type RollingParams } from './params.ts';

export interface SlabResult {
  /** positions from the entry (−L) to the exit (0) [m] */
  x: Float64Array;
  /** strip thickness [m] */
  h: Float64Array;
  /** roll pressure: the lower of the two branches [Pa] */
  p: Float64Array;
  /** pressure integrated from the entry, and from the exit [Pa] */
  pEntry: Float64Array;
  pExit: Float64Array;
  /** friction stress on the strip, positive along +x [Pa] */
  tau: Float64Array;
  /** plane-strain flow stress 2k along the bite [Pa] */
  twoK: Float64Array;
  /** roll separating force per roll [N/m] */
  force: number;
  /** roll torque per roll, driving positive [N·m/m] */
  torque: number;
  /** neutral point [m] and angle [rad]; at an end of the bite when the branches do not cross */
  xNeutral: number;
  phiNeutral: number;
  /** exit speed / roll surface speed − 1 (rigid-plastic: exit thickness = gap) */
  forwardSlip: number;
  /** false when the branches do not cross: friction cannot draw the strip in (it would skid) */
  crossed: boolean;
  /** somewhere μp > k: Coulomb friction asks for more than the shear yield stress (the strip would stick; the result is not valid) */
  sticking: boolean;
  /** a tension reaches the plane-strain flow stress 2k where it acts (the strip would yield outside the bite) */
  tensionAtYield: boolean;
  contactLength: number;
  biteAngle: number;
  /** roll force / projected contact length (the vertical force includes the friction's share) [Pa] */
  pMean: number;
  /** mean 2k over the projected contact length [Pa] */
  twoKMean: number;
}

/**
 * Solve the roll bite. `n` is the number of intervals along the contact (RK4 on a
 * uniform grid; the default converges the force to about 1e-6). `ep0` is the equivalent
 * plastic strain the strip brings into the bite (a tandem's later stands: the strain of the
 * stands before); the flow stress along the bite is taken at ep0 + (2/√3) ln(h0/h).
 */
export function karman(r: RollingParams, m: MaterialParams, n = 2000, ep0 = 0): SlabResult {
  const { gap: hf, contactLength: L, biteAngle } = biteGeometry(r);
  const R = r.rollRadius;
  const h0 = r.h0;
  const mu = r.mu;
  const c = 2 / Math.sqrt(3);

  const thick = (x: number) => hf + 2 * (R - Math.sqrt(R * R - x * x));
  const tanPhi = (x: number) => -x / Math.sqrt(R * R - x * x);

  // The strain rate needs the speed of the strip, which needs the neutral point:
  // solve with no slip first, then again with the slip found (it changes the
  // rate factor, which is logarithmic, by far less than 1e-3).
  let slip = 0;
  let out: SlabResult | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const vExit = r.millSpeed * (1 + slip);
    const twoKAt = (x: number) => {
      const h = thick(x);
      const ep = ep0 + c * Math.log(h0 / h);
      // ε̇eq = (2/√3)|ε̇yy|, ε̇yy = v (dh/dx)/h, v = vExit hf/h, dh/dx = −2 tan φ
      const rate = (c * vExit * hf * 2 * tanPhi(x)) / (h * h);
      return c * flowStress(m, ep, rate, m.tRoom).sy;
    };
    // d(σx h)/dx with the branch sign s
    const dF = (x: number, F: number, s: number) => {
      const h = thick(x);
      const p = twoKAt(x) - F / h;
      return 2 * p * (tanPhi(x) - s * mu);
    };

    const dx = L / n;
    const x = new Float64Array(n + 1);
    const h = new Float64Array(n + 1);
    const twoK = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      x[i] = -L + i * dx;
      h[i] = thick(x[i]);
      twoK[i] = twoKAt(x[i]);
    }
    x[n] = 0;

    const rk4 = (F: number, xa: number, step: number, s: number) => {
      const k1 = dF(xa, F, s);
      const k2 = dF(xa + step / 2, F + (step / 2) * k1, s);
      const k3 = dF(xa + step / 2, F + (step / 2) * k2, s);
      const k4 = dF(xa + step, F + step * k3, s);
      return F + (step / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    };
    const pEntry = new Float64Array(n + 1);
    const pExit = new Float64Array(n + 1);
    let F = r.backTension * h0;
    pEntry[0] = twoK[0] - F / h[0];
    for (let i = 0; i < n; i++) {
      F = rk4(F, x[i], dx, +1);
      pEntry[i + 1] = twoK[i + 1] - F / h[i + 1];
    }
    F = r.frontTension * hf;
    pExit[n] = twoK[n] - F / h[n];
    for (let i = n; i > 0; i--) {
      F = rk4(F, x[i], -dx, -1);
      pExit[i - 1] = twoK[i - 1] - F / h[i - 1];
    }

    // neutral point: the entry branch is below the exit branch before it, above after it
    let xN = 0;
    let crossed = false;
    for (let i = 0; i < n; i++) {
      const a = pEntry[i] - pExit[i];
      const b = pEntry[i + 1] - pExit[i + 1];
      if (a <= 0 && b > 0) {
        xN = x[i] + (dx * -a) / (b - a);
        crossed = true;
        break;
      }
    }
    if (!crossed) xN = pEntry[n] <= pExit[n] ? 0 : -L;

    const p = new Float64Array(n + 1);
    const tau = new Float64Array(n + 1);
    let sticking = false;
    for (let i = 0; i <= n; i++) {
      const s = x[i] < xN ? 1 : -1;
      p[i] = x[i] < xN ? pEntry[i] : pExit[i];
      tau[i] = s * mu * p[i];
      if (Math.abs(tau[i]) > 0.5 * twoK[i]) sticking = true;
    }
    // On the roll: the normal force p ds has the vertical part p dx, the friction
    // s μ p ds adds s μ p tan φ dx; the friction resists the roll where it drags the
    // strip forward, so it needs a driving torque R s μ p ds there. The friction
    // changes sign at the neutral point, so each branch is integrated on its own
    // side of it (trapezoids, the cell holding the neutral point split in two).
    let force = 0;
    let torque = 0;
    let twoKSum = 0;
    const add = (xa: number, xb: number, pa: number, pb: number, s: number) => {
      const ta = tanPhi(xa);
      const tb = tanPhi(xb);
      const w = (xb - xa) / 2;
      force += w * (pa * (1 + s * mu * ta) + pb * (1 + s * mu * tb));
      torque += w * R * s * mu * (pa * Math.sqrt(1 + ta * ta) + pb * Math.sqrt(1 + tb * tb));
    };
    for (let i = 0; i < n; i++) {
      twoKSum += (dx / 2) * (twoK[i] + twoK[i + 1]);
      if (x[i + 1] <= xN) add(x[i], x[i + 1], pEntry[i], pEntry[i + 1], 1);
      else if (x[i] >= xN) add(x[i], x[i + 1], pExit[i], pExit[i + 1], -1);
      else {
        const f = (xN - x[i]) / dx;
        const pN = pEntry[i] + f * (pEntry[i + 1] - pEntry[i]);
        add(x[i], xN, pEntry[i], pN, 1);
        add(xN, x[i + 1], pN, pExit[i + 1], -1);
      }
    }
    const phiN = Math.asin(-xN / R);
    const hN = thick(xN);
    slip = (hN * Math.cos(phiN)) / hf - 1;
    out = {
      x,
      h,
      p,
      pEntry,
      pExit,
      tau,
      twoK,
      force,
      torque,
      xNeutral: xN,
      phiNeutral: phiN,
      forwardSlip: slip,
      crossed,
      sticking,
      tensionAtYield: r.backTension >= twoK[0] || r.frontTension >= twoK[n],
      contactLength: L,
      biteAngle,
      pMean: force / L,
      twoKMean: twoKSum / L,
    };
  }
  return out!;
}

/**
 * The slab method with Hitchcock's flattened rolls: R' = R (1 + C P / Δh) and karman() at R' solved together
 * by fixed-point iteration from the rigid roll (the force goes about as √R', so an iteration takes off nine
 * tenths of the error; 1e-9 in R' within ten). The reference for the solver's flattening 'hitchcock'.
 */
export function karmanFlattened(r: RollingParams, m: MaterialParams, n = 2000, ep0 = 0): { slab: SlabResult; rollRadius: number; iterations: number } {
  const dh = r.h0 * r.reduction;
  let R = r.rollRadius;
  let slab = karman(r, m, n, ep0);
  let iterations = 0;
  for (; iterations < 50; iterations++) {
    const next = hitchcockRadius(r, slab.force, dh);
    const moved = Math.abs(next - R) / R;
    R = next;
    slab = karman({ ...r, rollRadius: R }, m, n, ep0);
    if (moved < 1e-9) break;
  }
  return { slab, rollRadius: R, iterations };
}

/**
 * Bland & Ford's closed-form solution of the same bite, for comparison only: `karman()` above
 * stays what the app uses. Source: 柳本 潤「圧延理論－1（圧延概論・Karman の理論）」東京大学
 * 生産技術研究所, §5 (eqs. 29-1, 29-2) and §6; D. R. Bland, H. Ford, Proc. Instn Mech. Engrs 159
 * (1948) 144–163.
 *
 * The approximations are the source's: a small bite angle (h = h1 + Rφ², tan φ = φ), the term
 * 2 tan φ (p − 2k) dropped from the equilibrium, and a **constant** 2k along the bite. With those,
 *
 *   entry side (φ > φn):  p = 2k (1 − σb/2k2) (h/h2) exp{ μ (H2 − H(φ)) }        (eq. 29-1)
 *   exit  side (φ < φn):  p = 2k (1 − σf/2k1) (h/h1) exp{ μ H(φ) }              (eq. 29-2)
 *
 * with H(φ) = 2√(R/h1) atan(√(R/h1) φ) and H2 = 2√(R/h1) atan(√((h2 − h1)/h1)) (the source's
 * form of H at the entry, exactly 2√(R/h1) atan(√(R/h1) φ2) under the small-angle law). The two
 * branches meet at
 *
 *   Hn = H2/2 − (1/(2μ)) ln[ (h2/h1) (1 − σf/2k1)/(1 − σb/2k2) ]                (eq. 3-2)
 *
 * so the neutral angle is φn = √(h1/R) tan(√(h1/R) Hn/2) and the forward slip
 * f = tan²(√(h1/R) Hn/2) = R φn²/h1 — the same f = xn²/(R h1) the diagnostics invert.
 * Tensions are tension-positive, as in `RollingParams`: a front tension lowers the exit branch,
 * which moves the neutral point towards the entry and raises f.
 *
 * 2k: the source takes it constant, the solver's material hardens along the bite, so this function
 * borrows `karman()`'s flow stress (same εp = ep0 + (2/√3) ln(h0/h) and strain rate of the mass
 * flow) and reduces it to three numbers — 2k2 and 2k1 at the entry and the exit for the tension
 * terms, and `karman()`'s mean over the projected contact (`twoKMean`) as the constant 2k of the
 * pressure. So both distributions carry the same mean flow stress and only the shape differs;
 * `twoKEntry`/`twoKExit`/`twoK` report all three. With no tension, 2k cancels out of f entirely.
 *
 * On a hardening strip the two 2k's disagree by a factor of two (SPCC: 2k2 = 267 MPa at εp = 0,
 * 2k1 = 511 MPa at the exit), and then a back tension read against 2k2 alone scales the whole entry
 * branch far too much — f comes out 4 times below `karman()`'s at σb = 100 MPa (docs/validation.md).
 * `tensionAt` picks which reference the tension terms use: 'ends' is the source's 2k2 and 2k1
 * (the default), 'mean' reads both tensions against the same mean 2k, which is what the constant-2k
 * derivation assumes and brings the tension cases back within 21 % of `karman()`.
 */
export interface BlandFordResult {
  /** positions from the entry (−L) to the exit (0) [m]: the grid `karman()` returns */
  x: Float64Array;
  /** thickness of the small-angle law h1 + Rφ² [m] (at the entry it misses h0 by 2e-4 of it) */
  h: Float64Array;
  /** roll pressure: the entry branch before the neutral point, the exit branch after it [Pa] */
  p: Float64Array;
  pEntry: Float64Array;
  pExit: Float64Array;
  /** the constant 2k of the pressure, and 2k2 (entry) and 2k1 (exit) of the tension terms [Pa] */
  twoK: number;
  twoKEntry: number;
  twoKExit: number;
  /** H at the entry (H2) and at the neutral point (Hn), the source's variable */
  HEntry: number;
  HNeutral: number;
  /** neutral point [m] (negative, from the exit) and angle [rad] */
  xNeutral: number;
  phiNeutral: number;
  /** exit speed / roll surface speed − 1 = tan²(√(h1/R) Hn/2) */
  forwardSlip: number;
  /** false when Hn falls outside [0, H2]: no neutral point in the bite (the values are clamped to its end) */
  crossed: boolean;
  /** which 2k the tension terms were read against */
  tensionAt: 'ends' | 'mean';
  /** ∫p dx over the contact [N/m]: the pressure's vertical part only (the small-angle solution
   * drops the friction's share μp tan φ, ±0.2 % at the standard condition and cancelling across
   * the neutral point) */
  force: number;
  pMean: number;
  contactLength: number;
  biteAngle: number;
}

export function blandFord(
  r: RollingParams,
  m: MaterialParams,
  n = 2000,
  ep0 = 0,
  tensionAt: 'ends' | 'mean' = 'ends',
): BlandFordResult {
  const { gap: h1, contactLength: L, biteAngle } = biteGeometry(r);
  const h2 = r.h0;
  const R = r.rollRadius;
  const mu = r.mu;
  const k = karman(r, m, n, ep0);
  const twoKEntry = k.twoK[0];
  const twoKExit = k.twoK[n];
  const twoK = k.twoKMean;
  const q = Math.sqrt(R / h1);
  const bigH = (phi: number) => 2 * q * Math.atan(q * phi);
  const HEntry = 2 * q * Math.atan(Math.sqrt((h2 - h1) / h1));
  const back = 1 - r.backTension / (tensionAt === 'mean' ? twoK : twoKEntry);
  const front = 1 - r.frontTension / (tensionAt === 'mean' ? twoK : twoKExit);
  // mu = 0 gives Hn = −∞: no friction, no neutral point (the strip cannot be drawn in)
  const HNeutral = HEntry / 2 - Math.log((h2 / h1) * (front / back)) / (2 * mu);
  const crossed = HNeutral > 0 && HNeutral < HEntry;
  const Hn = Math.min(Math.max(HNeutral, 0), HEntry);
  const tanN = Math.tan(Hn / (2 * q));
  const phiNeutral = tanN / q;
  const xNeutral = -R * Math.sin(Math.min(phiNeutral, biteAngle));

  const dx = L / n;
  const x = new Float64Array(n + 1);
  const h = new Float64Array(n + 1);
  const p = new Float64Array(n + 1);
  const pEntry = new Float64Array(n + 1);
  const pExit = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    x[i] = i === n ? 0 : -L + i * dx;
    const phi = Math.asin(Math.min(1, -x[i] / R));
    h[i] = h1 + R * phi * phi;
    pEntry[i] = twoK * back * (h[i] / h2) * Math.exp(mu * (HEntry - bigH(phi)));
    pExit[i] = twoK * front * (h[i] / h1) * Math.exp(mu * bigH(phi));
    p[i] = x[i] < xNeutral ? pEntry[i] : pExit[i];
  }
  let force = 0;
  for (let i = 0; i < n; i++) force += ((x[i + 1] - x[i]) / 2) * (p[i] + p[i + 1]);

  return {
    x,
    h,
    p,
    pEntry,
    pExit,
    twoK,
    twoKEntry,
    twoKExit,
    HEntry,
    HNeutral,
    xNeutral,
    phiNeutral,
    forwardSlip: tanN * tanN,
    crossed,
    tensionAt,
    force,
    pMean: force / L,
    contactLength: L,
    biteAngle,
  };
}
