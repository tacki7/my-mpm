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
import { biteGeometry, type MaterialParams, type RollingParams } from './params.ts';

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
 * uniform grid; the default converges the force to about 1e-6).
 */
export function karman(r: RollingParams, m: MaterialParams, n = 2000): SlabResult {
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
      const ep = c * Math.log(h0 / h);
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
