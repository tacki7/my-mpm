// Three-dimensional MPM of a strip passing between two rigid rolls: x along rolling, y through the
// thickness, z across the width. The section model (solver.ts) is plane strain — the strip cannot get
// wider; the plan-view model (planview/sim.ts) resolves the width but averages through the thickness.
// This one resolves both, so the strip spreads, the load varies across the width, and the edges bulge.
//
// - A quarter of the strip is solved: the mid-thickness plane y = 0 and the mid-width plane z = 0 are
//   symmetry planes. The one layer of ghost nodes beyond each is folded onto its mirror image (the
//   normal momentum negated) before the grid update and takes the mirrored velocity back after it; the
//   planes' own nodes get no normal velocity. The top surface and the edge z = W/2 are free.
// - The scheme is the section model's, a dimension up: MLS-MPM with quadratic B-splines (27 nodes a
//   point), the stress as a deviator (Jaumann rotation, elastic trial, J2 radial return of
//   material.ts) and a pressure from the volume ratio, p = −K ln J, the volume following the grid's
//   mean volumetric rate with the elastic log volume relaxed toward its grid mean where the point
//   flows ('rate' volume averaging, docs/model.md「体積の平均化」) — without it the pressure locks.
// - The roll is a rigid cylinder along z (the top one; the bottom one is its mirror image). A point
//   whose top edge is inside it marks its nodes on the roll's side; a marked node that approaches the
//   surface loses its normal velocity relative to it, and its tangential velocity (along the arc and
//   along z) is limited by Coulomb friction. The friction along z is what holds the spread back.
// - Pusher, mass scaling, the mill-speed scaling of the strain rate and the damage indicators mean the
//   same as in the section model. No tensions, no tandem, no roll flattening, no crack faces: a failed
//   point carries no deviator and no tension (it is counted, and the first one is recorded).
import { biteGeometry, cloneParams, type DamageModel, type SimParams } from '../params.ts';
import { adiabaticRise, elasticConstants, hmFractureStrain, homologousTemperature, jcFractureStrain, plasticIncrement, staticStrength, strengthFactor, type Elastic } from '../material.ts';

export interface SolidSettings {
  /** full strip width at the entry [m] */
  width: number;
  /** no lateral velocity anywhere (the plane-strain limit: what the section model solves) */
  planeStrain?: boolean;
}

export interface Solid3Params extends SimParams {
  solid: SolidSettings;
}

export type SolidPhase = 'approach' | 'bite' | 'steady' | 'tail-out' | 'done' | 'stalled';

export interface SolidCrack {
  t: number;
  step: number;
  x: number;
  y: number;
  z: number;
  /** where it sat in the undeformed strip: from the head end backwards, from the mid-thickness, from the mid-width [m] */
  sheetX: number;
  sheetY: number;
  sheetZ: number;
  eta: number;
  seq: number;
  ep: number;
  criterion: DamageModel;
}

const INF = 1e30;

export function solidParams(base: SimParams, solid: SolidSettings): Solid3Params {
  return { ...cloneParams(base), solid: { ...solid } };
}

export class Sim3 {
  readonly params: Solid3Params;
  readonly el: Elastic;
  readonly gap: number;
  readonly contactLength: number;
  readonly h: number;
  readonly dp: number;
  readonly dt: number;
  readonly vIn: number;
  readonly xHead0: number;
  readonly xExitProbe: number;
  readonly halfWidth0: number;
  readonly inertiaRatio: number;
  /** the top roll: a cylinder along z through (0, cy) */
  readonly roll: { cy: number; R: number; omega: number };
  // grid: node (ix, iy, iz) at (ox + ix h, (iy − 1) h, (iz − 1) h), index (ix nyN + iy) nzN + iz
  readonly ox: number;
  readonly nxN: number;
  readonly nyN: number;
  readonly nzN: number;
  // lattice: point (i, j, k) = (along x from the tail, up from the mid-thickness, out from the mid-width), index (i NJ + j) NK + k
  readonly NI: number;
  readonly NJ: number;
  readonly NK: number;
  readonly n: number;
  t = 0;
  step = 0;
  pusherActive = true;
  stalled = false;
  plasticWork = 0;
  nFailed = 0;
  firstCrack: SolidCrack | null = null;

  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** velocity gradient (APIC), row-major 3 × 3 */
  readonly C: Float64Array;
  /** deformation gradient, row-major 3 × 3 */
  readonly F: Float64Array;
  readonly mass: Float64Array;
  readonly vol0: Float64Array;
  // deviatoric stress
  readonly sxx: Float64Array;
  readonly syy: Float64Array;
  readonly szz: Float64Array;
  readonly sxy: Float64Array;
  readonly syz: Float64Array;
  readonly szx: Float64Array;
  readonly pres: Float64Array;
  readonly ep: Float64Array;
  readonly temp: Float64Array;
  readonly seq: Float64Array;
  readonly eta: Float64Array;
  readonly dJC: Float64Array;
  readonly dHM: Float64Array;
  readonly dCL: Float64Array;
  readonly active: Uint8Array;
  readonly failed: Uint8Array;
  readonly touch: Uint8Array;
  private readonly strength: Float64Array;
  private readonly strengthEp: Float64Array;
  private readonly vr: Float64Array;
  private readonly th: Float64Array;

  private readonly gm: Float64Array;
  private readonly gvx: Float64Array;
  private readonly gvy: Float64Array;
  private readonly gvz: Float64Array;
  private readonly gpen: Float64Array;
  private readonly gpush: Uint8Array;
  private readonly gcon: Uint8Array;
  private readonly gslipX: Float64Array;
  private readonly gslipY: Float64Array;
  private readonly gslipZ: Float64Array;
  private readonly gfolN: Float64Array;
  private readonly gfolD: Float64Array;
  private readonly gTh: Float64Array;
  private readonly gJe: Float64Array;
  private readonly gB: Float64Array;
  private readonly gMv: Float64Array;
  private ixLo = 0;
  private ixHi = 0;
  private ixPrevLo = 0;
  private ixPrevHi: number;

  // roll force on the quarter model since the last read [N]·steps, and the same by z column and by (x, z) cell
  private accFy = 0;
  private accTq = 0;
  private accSteps = 0;
  private readonly accFz: Float64Array;
  /** normal contact force by (x column from binCol0, z column from the mid-width) since the last read */
  private readonly accMap: Float64Array;
  readonly binCol0: number;
  readonly nBinsX: number;
  private stallX = -INF;

  constructor(input: Solid3Params) {
    const P: Solid3Params = { ...cloneParams(input), solid: { ...input.solid } };
    this.params = P;
    const r = P.rolling;
    const num = P.numerics;
    if (num.cellsThrough % 2 !== 0) throw new Error('cellsThrough must be even (the mid-thickness plane lies on a row of nodes)');
    this.el = elasticConstants(P.material);
    const geo = biteGeometry(r);
    this.gap = geo.gap;
    this.contactLength = geo.contactLength;
    const h = r.h0 / num.cellsThrough;
    this.h = h;
    const dp = h / num.ppc;
    this.dp = dp;
    const hw = P.solid.width / 2;
    this.halfWidth0 = hw;

    const Lc = this.contactLength;
    this.xHead0 = -Lc - Math.max(2 * r.h0, 4 * h);
    const xTail0 = this.xHead0 - r.sheetLength;
    const elongated = r.sheetLength / (1 - r.reduction);
    const xEnd = 2 * r.h0 + 2 * h + elongated * 1.1 + 8 * h;
    this.ox = xTail0 - 6 * h;
    this.nxN = Math.ceil((xEnd - this.ox) / h) + 1;
    this.nyN = Math.ceil((r.h0 / 2 + 4 * h) / h) + 2;
    // room for the spread: a quarter of the half width, and four cells
    this.nzN = Math.ceil((hw * 1.25 + 4 * h) / h) + 2;
    const NN = this.nxN * this.nyN * this.nzN;
    this.gm = new Float64Array(NN);
    this.gvx = new Float64Array(NN);
    this.gvy = new Float64Array(NN);
    this.gvz = new Float64Array(NN);
    this.gpen = new Float64Array(NN).fill(INF);
    this.gpush = new Uint8Array(NN);
    this.gcon = new Uint8Array(NN);
    this.gslipX = new Float64Array(NN);
    this.gslipY = new Float64Array(NN);
    this.gslipZ = new Float64Array(NN);
    this.gfolN = new Float64Array(NN);
    this.gfolD = new Float64Array(NN);
    this.gTh = new Float64Array(NN);
    this.gJe = new Float64Array(NN);
    this.gB = new Float64Array(NN);
    this.gMv = new Float64Array(NN);
    this.ixPrevHi = this.nxN;

    const R = r.rollRadius;
    this.roll = { cy: R + this.gap / 2, R, omega: r.rollSpeed / R };
    this.xExitProbe = Math.max(6 * h, Math.min(3 * r.h0, 2 * Lc));

    const NI = Math.round(r.sheetLength / dp);
    const NJ = Math.round(r.h0 / 2 / dp);
    const NK = Math.max(1, Math.round(hw / dp));
    this.NI = NI;
    this.NJ = NJ;
    this.NK = NK;
    const n = NI * NJ * NK;
    this.n = n;
    const A = () => new Float64Array(n);
    this.px = A();
    this.py = A();
    this.pz = A();
    this.vx = A();
    this.vy = A();
    this.vz = A();
    this.C = new Float64Array(9 * n);
    this.F = new Float64Array(9 * n);
    this.mass = A();
    this.vol0 = A();
    this.sxx = A();
    this.syy = A();
    this.szz = A();
    this.sxy = A();
    this.syz = A();
    this.szx = A();
    this.pres = A();
    this.ep = A();
    this.temp = A();
    this.seq = A();
    this.eta = A();
    this.dJC = A();
    this.dHM = A();
    this.dCL = A();
    this.strength = A();
    this.strengthEp = A().fill(NaN);
    this.vr = A();
    this.th = A();
    this.active = new Uint8Array(n).fill(1);
    this.failed = new Uint8Array(n);
    this.touch = new Uint8Array(n);

    this.vIn = r.rollSpeed * (1 - r.reduction);
    const rho = P.material.rho * num.massScale;
    // the width is NK points exactly: their spacing across z is hw / NK (dp up to the rounding)
    const dz = hw / NK;
    let p = 0;
    for (let i = 0; i < NI; i++) {
      for (let j = 0; j < NJ; j++) {
        for (let k = 0; k < NK; k++, p++) {
          this.px[p] = xTail0 + (i + 0.5) * dp;
          this.py[p] = (j + 0.5) * dp;
          this.pz[p] = (k + 0.5) * dz;
          this.vx[p] = this.vIn;
          this.F[9 * p] = 1;
          this.F[9 * p + 4] = 1;
          this.F[9 * p + 8] = 1;
          this.vol0[p] = dp * dp * dz;
          this.mass[p] = rho * dp * dp * dz;
          this.temp[p] = P.material.tRoom;
        }
      }
    }
    this.dz = dz;

    const c = Math.sqrt((this.el.K + (4 / 3) * this.el.G) / rho);
    this.dt = (num.cfl * h) / (c + 1.5 * r.rollSpeed);
    const epMid = (1 / Math.sqrt(3)) * Math.log(1 / (1 - r.reduction));
    const twoK = (2 / Math.sqrt(3)) * staticStrength(P.material, epMid);
    this.inertiaRatio = (rho * r.rollSpeed * r.rollSpeed * r.reduction) / twoK;

    this.binCol0 = Math.round((-Lc - 3 * h - this.ox) / h);
    this.nBinsX = Math.ceil((Lc + 6 * h) / h);
    this.accFz = new Float64Array(this.nzN);
    this.accMap = new Float64Array(this.nBinsX * this.nzN);
  }

  /** spacing of the points across the width [m] */
  readonly dz: number;

  lattice(i: number, j: number, k: number): number {
    return (i * this.NJ + j) * this.NK + k;
  }

  advance(): void {
    const slab = this.nyN * this.nzN;
    const lo = this.ixPrevLo * slab;
    const hi = this.ixPrevHi * slab;
    this.gm.fill(0, lo, hi);
    this.gvx.fill(0, lo, hi);
    this.gvy.fill(0, lo, hi);
    this.gvz.fill(0, lo, hi);
    this.gpen.fill(INF, lo, hi);
    this.gpush.fill(0, lo, hi);
    this.gcon.fill(0, lo, hi);
    this.gTh.fill(0, lo, hi);
    this.gJe.fill(0, lo, hi);
    this.gB.fill(0, lo, hi);
    this.gMv.fill(0, lo, hi);
    if (this.pusherActive && this.headX() > this.xExitProbe) this.pusherActive = false;
    if (!this.pusherActive && !this.stalled && this.step % 200 === 0) this.checkStall();
    this.p2g();
    this.gridUpdate();
    this.g2pVelocity();
    this.g2pUpdate();
    this.ixPrevLo = this.ixLo;
    this.ixPrevHi = this.ixHi;
    this.t += this.dt;
    this.step++;
  }

  private p2g(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, mass, vol0, gm, gvx, gvy, gvz, gpen, gpush, dt, h, ox, nyN, nzN } = this;
    const { sxx, syy, szz, sxy, syz, szx, pres, touch } = this;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const halfDp = 0.5 * this.dp;
    const hh = 0.5 * h;
    const { cy, R } = this.roll;
    const pushing = this.pusherActive;
    const tailEnd = this.NJ * this.NK; // the points of the tail column come first
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    let ixLo = 1 << 30;
    let ixHi = -1;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const yp = py[p];
      const zp = pz[p];
      const gx = (xp - ox) * invH;
      const gy = yp * invH + 1;
      const gz = zp * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      if (bx < ixLo) ixLo = bx;
      if (bx > ixHi) ixHi = bx;
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);

      const o = 9 * p;
      const F00 = F[o], F01 = F[o + 1], F02 = F[o + 2], F10 = F[o + 3], F11 = F[o + 4], F12 = F[o + 5], F20 = F[o + 6], F21 = F[o + 7], F22 = F[o + 8];
      const J = F00 * (F11 * F22 - F12 * F21) - F01 * (F10 * F22 - F12 * F20) + F02 * (F10 * F21 - F11 * F20);
      const m = mass[p];
      const kk = -dt * vol0[p] * J * k4;
      const pr = pres[p];
      const a00 = kk * (sxx[p] - pr) + m * C[o];
      const a01 = kk * sxy[p] + m * C[o + 1];
      const a02 = kk * szx[p] + m * C[o + 2];
      const a10 = kk * sxy[p] + m * C[o + 3];
      const a11 = kk * (syy[p] - pr) + m * C[o + 4];
      const a12 = kk * syz[p] + m * C[o + 5];
      const a20 = kk * szx[p] + m * C[o + 6];
      const a21 = kk * syz[p] + m * C[o + 7];
      const a22 = kk * (szz[p] - pr) + m * C[o + 8];
      const mvx = m * vx[p];
      const mvy = m * vy[p];
      const mvz = m * vz[p];

      // penetration of the point's top edge (its half size along the deformed y edge) into the roll
      const ex = xp;
      const ey = yp - cy;
      let pen = INF;
      let nx = 0;
      let ny = 0;
      const rpMax = halfDp * (Math.abs(F01) + Math.abs(F11));
      // no square root for a point that cannot reach the roll (an upper bound of its half size, a margin far above rounding)
      const d2 = ex * ex + ey * ey;
      if (d2 <= (R + rpMax) * (R + rpMax) * (1 + 1e-9)) {
        const d = Math.sqrt(d2);
        pen = d - R - halfDp * Math.hypot(F01, F11);
        nx = ex / d;
        ny = ey / d;
      }
      const inRoll = pen < 0;
      touch[p] = inRoll ? 1 : 0;
      const pushMark = pushing && p < tailEnd;

      for (let i = 0; i < 3; i++) {
        const dx = (i - fx) * h;
        const wi = wx[i];
        for (let j = 0; j < 3; j++) {
          const dy = (j - fy) * h;
          const wij = wi * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          const onSide = inRoll && dx * nx + dy * ny <= hh;
          const bxv = mvx + a00 * dx + a01 * dy;
          const byv = mvy + a10 * dx + a11 * dy;
          const bzv = mvz + a20 * dx + a21 * dy;
          for (let k = 0; k < 3; k++) {
            const dzz = (k - fz) * h;
            const w = wij * wz[k];
            const idx = row + k;
            gm[idx] += w * m;
            gvx[idx] += w * (bxv + a02 * dzz);
            gvy[idx] += w * (byv + a12 * dzz);
            gvz[idx] += w * (bzv + a22 * dzz);
            if (onSide && pen < gpen[idx]) gpen[idx] = pen;
            if (pushMark) gpush[idx] = 1;
          }
        }
      }
    }
    if (ixHi < 0) {
      this.ixLo = 0;
      this.ixHi = 0;
    } else {
      this.ixLo = Math.max(0, ixLo);
      this.ixHi = Math.min(this.nxN, ixHi + 3);
    }
  }

  /** the ghost layers (iy = 0, iz = 0) onto their mirror images (iy = 2, iz = 2): sums, the normal momentum negated */
  private foldMomentum(): void {
    const { gm, gvx, gvy, gvz, gpen, gpush, nyN, nzN } = this;
    for (let ix = this.ixLo; ix < this.ixHi; ix++) {
      const col = ix * nyN * nzN;
      for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz; // iy = 0
        if (gm[g] === 0) continue;
        const m = g + 2 * nzN;
        gm[m] += gm[g];
        gvx[m] += gvx[g];
        gvy[m] -= gvy[g];
        gvz[m] += gvz[g];
        if (gpen[g] < gpen[m]) gpen[m] = gpen[g];
        if (gpush[g]) gpush[m] = 1;
        gm[g] = 0;
      }
      for (let iy = 1; iy < nyN; iy++) {
        const g = col + iy * nzN; // iz = 0
        if (gm[g] === 0) continue;
        const m = g + 2;
        gm[m] += gm[g];
        gvx[m] += gvx[g];
        gvy[m] += gvy[g];
        gvz[m] -= gvz[g];
        if (gpen[g] < gpen[m]) gpen[m] = gpen[g];
        if (gpush[g]) gpush[m] = 1;
        gm[g] = 0;
      }
    }
  }

  private gridUpdate(): void {
    this.foldMomentum();
    const { gm, gvx, gvy, gvz, gpen, gpush, nyN, nzN, h, ox, dt, accFz, accMap, binCol0, nBinsX } = this;
    const mu = this.params.rolling.mu;
    const planeStrain = this.params.solid.planeStrain === true;
    const pushing = this.pusherActive;
    const vPush = this.vIn;
    const invDt = 1 / dt;
    const { cy, R, omega } = this.roll;
    const mMin = 1e-12 * this.mass[0];
    let fyAcc = 0;
    let tqAcc = 0;
    for (let ix = this.ixLo; ix < this.ixHi; ix++) {
      const xi = ox + ix * h;
      const b = ix - binCol0;
      for (let iy = 1; iy < nyN; iy++) {
        const yi = (iy - 1) * h;
        const row = (ix * nyN + iy) * nzN;
        for (let iz = 1; iz < nzN; iz++) {
          const idx = row + iz;
          const m = gm[idx];
          if (m <= mMin) {
            gvx[idx] = 0;
            gvy[idx] = 0;
            gvz[idx] = 0;
            continue;
          }
          let vx = gvx[idx] / m;
          let vy = gvy[idx] / m;
          let vz = gvz[idx] / m;
          if (iy === 1) vy = 0;
          if (iz === 1 || planeStrain) vz = 0;
          if (gpen[idx] < 0) {
            const rx = xi;
            const ry = yi - cy;
            const d = Math.hypot(rx, ry);
            const nx = rx / d;
            const ny = ry / d;
            // the roll's surface velocity at the foot of the node (the top roll turns so that its lowest point moves +x)
            const ux = -omega * R * ny;
            const uy = omega * R * nx;
            const relx = vx - ux;
            const rely = vy - uy;
            const vn = relx * nx + rely * ny;
            // n points away from the roll's axis: moving into the roll is vn < 0
            if (vn < 0) {
              const tx = relx - vn * nx;
              const ty = rely - vn * ny;
              const tz = vz;
              const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
              let s = 0;
              if (vt > -mu * vn) s = 1 + (mu * vn) / vt;
              const nvx = ux + s * tx;
              const nvy = uy + s * ty;
              const nvz = s * tz;
              this.gcon[idx] = 1;
              this.gslipX[idx] = s * tx;
              this.gslipY[idx] = s * ty;
              this.gslipZ[idx] = iz === 1 || planeStrain ? 0 : s * tz;
              const fx = m * (nvx - vx) * invDt;
              const fy = m * (nvy - vy) * invDt;
              fyAcc += fy;
              tqAcc += -(rx * fy - ry * fx);
              const fn = fx * nx + fy * ny;
              accFz[iz] += fn;
              if (b >= 0 && b < nBinsX) accMap[b * nzN + iz] += fn;
              vx = nvx;
              vy = iy === 1 ? 0 : nvy;
              vz = iz === 1 || planeStrain ? 0 : nvz;
            }
          }
          if (pushing && gpush[idx] && vx < vPush) vx = vPush;
          gvx[idx] = vx;
          gvy[idx] = vy;
          gvz[idx] = vz;
        }
      }
    }
    const fol = this.followRoll();
    fyAcc += fol[0];
    tqAcc += fol[1];
    // the mirrored velocity back to the ghost layers: iz = 0 from iz = 2, then iy = 0 from iy = 2 (the corner too)
    for (let ix = this.ixLo; ix < this.ixHi; ix++) {
      const col = ix * nyN * nzN;
      for (let iy = 1; iy < nyN; iy++) {
        const g = col + iy * nzN;
        gvx[g] = gvx[g + 2];
        gvy[g] = gvy[g + 2];
        gvz[g] = -gvz[g + 2];
      }
      for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        const m = g + 2 * nzN;
        gvx[g] = gvx[m];
        gvy[g] = -gvy[m];
        gvz[g] = gvz[m];
      }
    }
    // the sheet pushes the roll up: the force on the roll is minus the force on the sheet
    this.accFy += -fyAcc;
    this.accTq += tqAcc;
    this.accSteps++;
  }

  /**
   * The top edge of a point that is inside the roll must not move further into it (solver.ts followRoll): the
   * point's velocity mixes the held nodes on its roll side with free nodes deeper in the sheet, which move toward
   * the mid-plane more slowly than the surface, so the point would lag and sink into the roll (the strip came out
   * 2 % over the gap). Its edge moves along the normal n (axis → point) at (v − u)·n − rp D_nn; what it lacks, over
   * the weight the point puts on its held nodes, is asked of those nodes (the mass-weighted mean of the requests),
   * with Coulomb's share of the added normal impulse taken from a sliding node's slip. A ghost node's request goes
   * to its mirror image. Returns the force on the sheet along y and the torque on the roll it adds.
   */
  private followRoll(): [number, number] {
    const { n, active, touch, px, py, pz, F, gvx, gvy, gvz, gm, gcon, gfolN, gfolD, gslipX, gslipY, gslipZ, mass, h, ox, nyN, nzN, dt, accFz, accMap, binCol0, nBinsX } = this;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const mu = this.params.rolling.mu;
    const { cy, R, omega } = this.roll;
    const halfDp = 0.5 * this.dp;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    const touched: number[] = [];
    for (let p = 0; p < n; p++) {
      if (!active[p] || !touch[p]) continue;
      const gx = (px[p] - ox) * invH;
      const gy = py[p] * invH + 1;
      const gz = pz[p] * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
      const rx = px[p];
      const ry = py[p] - cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      const ux = -omega * R * ny;
      const uy = omega * R * nx;
      let e = 0;
      let W = 0;
      let dnn = 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN;
          const along = ((i - fx) * nx + (j - fy) * ny) * h;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            // the ghost layer holds its mirror image's velocity already only after the copy back: read the mirror
            const iz = bz + k;
            const idx = row + (iz === 0 ? 2 : iz);
            const vnode = gvx[idx] * nx + gvy[idx] * ny;
            e += w * (vnode - ux * nx - uy * ny);
            dnn += w * vnode * along;
            if (gcon[idx]) W += w;
          }
        }
      }
      const o = 9 * p;
      const edge = e - halfDp * Math.hypot(F[o + 1], F[o + 4]) * k4 * dnn;
      if (edge >= 0 || W <= 0) continue;
      const want = -edge / W;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN;
          for (let k = 0; k < 3; k++) {
            const iz = bz + k;
            const idx = row + (iz === 0 ? 2 : iz);
            if (!gcon[idx]) continue;
            const wm = wij * wz[k] * mass[p];
            if (!(wm > 0)) continue;
            if (gfolD[idx] === 0) touched.push(idx);
            gfolN[idx] += wm * want;
            gfolD[idx] += wm;
          }
        }
      }
    }
    const invDt = 1 / dt;
    const slab = nyN * nzN;
    let fyAdd = 0;
    let tqAdd = 0;
    for (const idx of touched) {
      const dv = gfolN[idx] / gfolD[idx];
      gfolN[idx] = 0;
      gfolD[idx] = 0;
      const ix = Math.floor(idx / slab);
      const iy = Math.floor((idx - ix * slab) / nzN);
      const iz = idx - ix * slab - iy * nzN;
      const rx = ox + ix * h;
      const ry = (iy - 1) * h - cy;
      const d = Math.hypot(rx, ry);
      const nx = rx / d;
      const ny = ry / d;
      gvx[idx] += dv * nx;
      gvy[idx] += dv * ny;
      const mi = gm[idx];
      const sx = gslipX[idx];
      const sy = gslipY[idx];
      const sz = gslipZ[idx];
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      let tx = 0;
      let ty = 0;
      if (sl > 0) {
        const ds = Math.min(sl, mu * dv);
        const c = -ds / sl;
        tx = c * sx;
        ty = c * sy;
        gvx[idx] += tx;
        gvy[idx] += ty;
        gvz[idx] += c * sz;
        const stuck = ds >= sl;
        gslipX[idx] = stuck ? 0 : sx + tx;
        gslipY[idx] = stuck ? 0 : sy + ty;
        gslipZ[idx] = stuck ? 0 : sz + c * sz;
      }
      const f = mi * dv * invDt;
      const fx = f * nx + mi * tx * invDt;
      const fy = f * ny + mi * ty * invDt;
      fyAdd += fy;
      tqAdd += -(rx * fy - ry * fx);
      accFz[iz] += f;
      const b = ix - binCol0;
      if (b >= 0 && b < nBinsX) accMap[b * nzN + iz] += f;
    }
    return [fyAdd, tqAdd];
  }

  private g2pVelocity(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, mass, gvx, gvy, gvz, gTh, gJe, gB, gMv, h, ox, nyN, nzN, failed, pres, vr, th } = this;
    const invH = 1 / h;
    const k4 = 4 * invH * invH;
    const invK = 1 / this.el.K;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const gx = (px[p] - ox) * invH;
      const gy = py[p] * invH + 1;
      const gz = pz[p] * invH + 1;
      const bx = Math.floor(gx - 0.5);
      const by = Math.floor(gy - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
      wx[1] = 0.75 - (fx - 1) * (fx - 1);
      wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
      wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
      wy[1] = 0.75 - (fy - 1) * (fy - 1);
      wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
      wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
      wz[1] = 0.75 - (fz - 1) * (fz - 1);
      wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
      let nvx = 0, nvy = 0, nvz = 0;
      let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
      for (let i = 0; i < 3; i++) {
        const dx = (i - fx) * h;
        for (let j = 0; j < 3; j++) {
          const dy = (j - fy) * h;
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            const dzz = (k - fz) * h;
            const idx = row + k;
            const gx1 = w * gvx[idx];
            const gy1 = w * gvy[idx];
            const gz1 = w * gvz[idx];
            nvx += gx1;
            nvy += gy1;
            nvz += gz1;
            b00 += gx1 * dx;
            b01 += gx1 * dy;
            b02 += gx1 * dzz;
            b10 += gy1 * dx;
            b11 += gy1 * dy;
            b12 += gy1 * dzz;
            b20 += gz1 * dx;
            b21 += gz1 * dy;
            b22 += gz1 * dzz;
          }
        }
      }
      const o = 9 * p;
      C[o] = k4 * b00;
      C[o + 1] = k4 * b01;
      C[o + 2] = k4 * b02;
      C[o + 3] = k4 * b10;
      C[o + 4] = k4 * b11;
      C[o + 5] = k4 * b12;
      C[o + 6] = k4 * b20;
      C[o + 7] = k4 * b21;
      C[o + 8] = k4 * b22;
      vx[p] = nvx;
      vy[p] = nvy;
      vz[p] = nvz;
      const theta = C[o] + C[o + 4] + C[o + 8];
      th[p] = theta;
      // inverted points and points failed in tension keep their own rate (solver.ts g2pVelocity)
      const J = det3(F, o);
      if ((failed[p] && !(pres[p] > 0)) || !(J > 0)) continue;
      const m = mass[p];
      const mth = m * theta;
      const mfe = -m * pres[p] * invK;
      const v = vr[p];
      const mb = v > 0 ? m * (v < 1 ? v : 1) : 0;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const wij = wx[i] * wy[j];
          const row = ((bx + i) * nyN + by + j) * nzN + bz;
          for (let k = 0; k < 3; k++) {
            const w = wij * wz[k];
            const idx = row + k;
            gTh[idx] += w * mth;
            gJe[idx] += w * mfe;
            gB[idx] += w * mb;
            gMv[idx] += w * m;
          }
        }
      }
    }
    // the ghost layers' sums onto their mirror images, the means, and the means back to the ghosts
    for (let ix = this.ixLo; ix < this.ixHi; ix++) {
      const col = ix * nyN * nzN;
      for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        if (gMv[g] === 0) continue;
        const m = g + 2 * nzN;
        gTh[m] += gTh[g];
        gJe[m] += gJe[g];
        gB[m] += gB[g];
        gMv[m] += gMv[g];
        gMv[g] = 0;
      }
      for (let iy = 1; iy < nyN; iy++) {
        const g = col + iy * nzN;
        if (gMv[g] === 0) continue;
        const m = g + 2;
        gTh[m] += gTh[g];
        gJe[m] += gJe[g];
        gB[m] += gB[g];
        gMv[m] += gMv[g];
        gMv[g] = 0;
      }
      for (let idx = col + nzN; idx < col + nyN * nzN; idx++) {
        const m = gMv[idx];
        if (m > 0) {
          gTh[idx] /= m;
          const b = gB[idx] / m;
          gB[idx] = b;
          gJe[idx] = (b * gJe[idx]) / m;
        }
      }
      for (let iy = 1; iy < nyN; iy++) {
        const g = col + iy * nzN;
        gTh[g] = gTh[g + 2];
        gJe[g] = gJe[g + 2];
        gB[g] = gB[g + 2];
      }
      for (let iz = 0; iz < nzN; iz++) {
        const g = col + iz;
        const m = g + 2 * nzN;
        gTh[g] = gTh[m];
        gJe[g] = gJe[m];
        gB[g] = gB[m];
      }
    }
  }

  private g2pUpdate(): void {
    const { n, active, px, py, pz, vx, vy, vz, C, F, gTh, gJe, gB, dt, h, ox, nxN, nyN, nzN, failed, pres, vr } = this;
    const { sxx, syy, szz, sxy, syz, szx, temp, vol0, dJC, dHM, dCL, strength, strengthEp } = this;
    const P = this.params;
    const mat = P.material;
    const dmg = P.damage;
    const { K, G } = this.el;
    const invH = 1 / h;
    const rateScale = P.rolling.millSpeed / P.rolling.rollSpeed;
    const xMax = (nxN - 3) * h + ox;
    const xMin = ox + 2 * h;
    const yMax = (nyN - 4) * h;
    const zMax = (nzN - 4) * h;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const o = 9 * p;
      const l00 = C[o], l01 = C[o + 1], l02 = C[o + 2], l10 = C[o + 3], l11 = C[o + 4], l12 = C[o + 5], l20 = C[o + 6], l21 = C[o + 7], l22 = C[o + 8];
      const Jold = det3(F, o);
      let cor = 1;
      if (!((failed[p] && !(pres[p] > 0)) || !(Jold > 0))) {
        const gx = (px[p] - ox) * invH;
        const gy = py[p] * invH + 1;
        const gz = pz[p] * invH + 1;
        const bx = Math.floor(gx - 0.5);
        const by = Math.floor(gy - 0.5);
        const bz = Math.floor(gz - 0.5);
        const fx = gx - bx;
        const fy = gy - by;
        const fz = gz - bz;
        wx[0] = 0.5 * (1.5 - fx) * (1.5 - fx);
        wx[1] = 0.75 - (fx - 1) * (fx - 1);
        wx[2] = 0.5 * (fx - 0.5) * (fx - 0.5);
        wy[0] = 0.5 * (1.5 - fy) * (1.5 - fy);
        wy[1] = 0.75 - (fy - 1) * (fy - 1);
        wy[2] = 0.5 * (fy - 0.5) * (fy - 0.5);
        wz[0] = 0.5 * (1.5 - fz) * (1.5 - fz);
        wz[1] = 0.75 - (fz - 1) * (fz - 1);
        wz[2] = 0.5 * (fz - 0.5) * (fz - 0.5);
        let thBar = 0;
        let rA = 0;
        let rB = 0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const wij = wx[i] * wy[j];
            const row = ((bx + i) * nyN + by + j) * nzN + bz;
            for (let k = 0; k < 3; k++) {
              const w = wij * wz[k];
              const idx = row + k;
              thBar += w * gTh[idx];
              rA += w * gJe[idx];
              rB += w * gB[idx];
            }
          }
        }
        // the smoothed rate and the relaxation of the elastic log volume toward its grid mean (ln J − ev = −p/K)
        const theta = thBar + (rA + (rB * pres[p]) / K) / dt;
        const g00 = 1 + dt * l00, g11 = 1 + dt * l11, g22 = 1 + dt * l22;
        const detG = g00 * (g11 * g22 - dt * dt * l12 * l21) - dt * l01 * (dt * l10 * g22 - dt * dt * l12 * l20) + dt * l02 * (dt * dt * l10 * l21 - g11 * dt * l20);
        const ratio = Math.exp(dt * theta) / detG;
        cor = ratio > 0 ? Math.cbrt(ratio) : 1;
      }
      const nxp = px[p] + dt * vx[p];
      const nyp = py[p] + dt * vy[p];
      const nzp = pz[p] + dt * vz[p];
      px[p] = nxp;
      py[p] = nyp < 0 ? -nyp : nyp;
      pz[p] = nzp < 0 ? -nzp : nzp;
      if (nxp < xMin || nxp > xMax || nyp > yMax || nzp > zMax) {
        active[p] = 0;
        continue;
      }

      // F ← c (I + dt L) F
      const g00 = cor * (1 + dt * l00), g01 = cor * dt * l01, g02 = cor * dt * l02;
      const g10 = cor * dt * l10, g11 = cor * (1 + dt * l11), g12 = cor * dt * l12;
      const g20 = cor * dt * l20, g21 = cor * dt * l21, g22 = cor * (1 + dt * l22);
      const F00 = F[o], F01 = F[o + 1], F02 = F[o + 2], F10 = F[o + 3], F11 = F[o + 4], F12 = F[o + 5], F20 = F[o + 6], F21 = F[o + 7], F22 = F[o + 8];
      F[o] = g00 * F00 + g01 * F10 + g02 * F20;
      F[o + 1] = g00 * F01 + g01 * F11 + g02 * F21;
      F[o + 2] = g00 * F02 + g01 * F12 + g02 * F22;
      F[o + 3] = g10 * F00 + g11 * F10 + g12 * F20;
      F[o + 4] = g10 * F01 + g11 * F11 + g12 * F21;
      F[o + 5] = g10 * F02 + g11 * F12 + g12 * F22;
      F[o + 6] = g20 * F00 + g21 * F10 + g22 * F20;
      F[o + 7] = g20 * F01 + g21 * F11 + g22 * F21;
      F[o + 8] = g20 * F02 + g21 * F12 + g22 * F22;
      const J = det3(F, o);

      // deviatoric rate of deformation and spin
      const tr3 = (l00 + l11 + l22) / 3;
      const exx = l00 - tr3;
      const eyy = l11 - tr3;
      const ezz = l22 - tr3;
      const exy = 0.5 * (l01 + l10);
      const eyz = 0.5 * (l12 + l21);
      const ezx = 0.5 * (l20 + l02);
      const wxy = 0.5 * (l01 - l10);
      const wyz = 0.5 * (l12 - l21);
      const wzx = 0.5 * (l20 - l02);
      const epsDot = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz + 2 * (exy * exy + eyz * eyz + ezx * ezx))) * rateScale;

      // Jaumann: s ← s + dt (W s − s W), W = [[0, wxy, −wzx], [−wxy, 0, wyz], [wzx, −wyz, 0]]
      let sx = sxx[p], sy = syy[p], sz = szz[p], sa = sxy[p], sb = syz[p], sc = szx[p];
      {
        const rxx = 2 * (wxy * sa - wzx * sc);
        const ryy = 2 * (-wxy * sa + wyz * sb);
        const rzz = 2 * (wzx * sc - wyz * sb);
        const rxy = wxy * (sy - sx) - wzx * sb + wyz * sc;
        const ryz = wyz * (sz - sy) - wxy * sc + wzx * sa;
        const rzx = wzx * (sx - sz) - wyz * sa + wxy * sb;
        sx += dt * rxx;
        sy += dt * ryy;
        sz += dt * rzz;
        sa += dt * rxy;
        sb += dt * ryz;
        sc += dt * rzx;
      }
      const g2 = 2 * G * dt;
      sx += g2 * exx;
      sy += g2 * eyy;
      sz += g2 * ezz;
      sa += g2 * exy;
      sb += g2 * eyz;
      sc += g2 * ezx;
      let pr = J > 0 ? -K * Math.log(J) : 0;
      let q = Math.sqrt(1.5 * (sx * sx + sy * sy + sz * sz + 2 * (sa * sa + sb * sb + sc * sc)));
      let dep = 0;
      vr[p] = 0;
      if (failed[p]) {
        sx = sy = sz = sa = sb = sc = 0;
        q = 0;
        if (pr < 0) pr = 0;
      } else {
        const ep = this.ep[p];
        if (strengthEp[p] !== ep) {
          strength[p] = staticStrength(mat, ep);
          strengthEp[p] = ep;
        }
        const s0 = strength[p];
        const cool = temp[p] <= mat.tRoom && mat.jcC >= 0;
        dep = (cool && q <= s0) || q <= s0 * strengthFactor(mat, epsDot, temp[p]) ? 0 : plasticIncrement(mat, G, q, ep, epsDot, temp[p]);
        if (dep > 0) {
          const s = 1 - (3 * G * dep) / q;
          sx *= s;
          sy *= s;
          sz *= s;
          sa *= s;
          sb *= s;
          sc *= s;
          q -= 3 * G * dep;
          this.ep[p] += dep;
          this.plasticWork += q * dep * vol0[p] * J;
          if (mat.chi > 0) temp[p] += adiabaticRise(mat.chi, q * dep, J, mat.rho, mat.cp);
        }
      }
      sxx[p] = sx;
      syy[p] = sy;
      szz[p] = sz;
      sxy[p] = sa;
      syz[p] = sb;
      szx[p] = sc;
      pres[p] = pr;
      const eta = q > 1e3 ? -pr / q : 0;
      this.seq[p] = q;
      this.eta[p] = eta;
      if (dep > 0) {
        if (q > 0) vr[p] = (3 * K * dep) / q;
        if (eta > dmg.etaCutoff) {
          dJC[p] += dep / jcFractureStrain(dmg, eta, epsDot / mat.epsDot0, homologousTemperature(mat, temp[p]));
          dHM[p] += dep / hmFractureStrain(eta);
        }
        const s1 = maxPrincipal(sx - pr, sy - pr, sz - pr, sa, sb, sc);
        if (s1 > 0) dCL[p] += ((s1 / q) * dep) / dmg.clCrit;
        if (dmg.model !== 'none' && this.governingDamage(p) >= 1) this.fail(p);
      }
    }
  }

  /** the damage indicator of the chosen criterion (Johnson-Cook's where the criterion has none of its own) */
  governingDamage(p: number): number {
    const m = this.params.damage.model;
    return m === 'hancock-mackenzie' ? this.dHM[p] : m === 'cockcroft-latham' ? this.dCL[p] : this.dJC[p];
  }

  private fail(p: number): void {
    // the ends are held by nothing here, but the pusher's column must stay whole
    if (p < this.NJ * this.NK) return;
    this.failed[p] = 1;
    this.nFailed++;
    if (this.firstCrack) return;
    const i = Math.floor(p / (this.NJ * this.NK));
    const j = Math.floor(p / this.NK) % this.NJ;
    const k = p % this.NK;
    this.firstCrack = {
      t: this.t,
      step: this.step,
      x: this.px[p],
      y: this.py[p],
      z: this.pz[p],
      sheetX: (this.NI - 1 - i + 0.5) * this.dp,
      sheetY: (j + 0.5) * this.dp,
      sheetZ: (k + 0.5) * this.dz,
      eta: this.eta[p],
      seq: this.seq[p],
      ep: this.ep[p],
      criterion: this.params.damage.model,
    };
  }

  /** front of the head column (+∞ once it has left the grid) */
  headX(): number {
    const { n, active, px } = this;
    let x = -INF;
    for (let p = n - this.NJ * this.NK; p < n; p++) if (active[p] && px[p] > x) x = px[p];
    return x === -INF ? INF : x;
  }

  /** back of the tail column (+∞ once it has left the grid) */
  tailX(): number {
    const { active, px } = this;
    let x = INF;
    for (let p = 0; p < this.NJ * this.NK; p++) if (active[p] && px[p] < x) x = px[p];
    return x;
  }

  phase(): SolidPhase {
    if (this.stalled) return 'stalled';
    const head = this.headX();
    const tail = this.tailX();
    if (tail > 2 * this.params.rolling.h0 || tail === INF) return 'done';
    if (head < -this.contactLength) return 'approach';
    if (head < this.xExitProbe) return 'bite';
    if (tail > -this.contactLength) return 'tail-out';
    return 'steady';
  }

  /** the sheet no longer moves though it is between the rolls (the rolls cannot draw it in) */
  private checkStall(): void {
    const tail = this.tailX();
    if (tail === INF || tail > -this.contactLength) return;
    if (tail - this.stallX < 0.02 * this.vIn * 200 * this.dt) this.stalled = true;
    this.stallX = tail;
  }

  /**
   * The roll force and torque on one roll over the whole width since the last read (means over the steps
   * [N, N m]), the normal force per unit width by z column [N/m] (from the mid-width out; the column on the
   * mid-width plane holds half a cell), and the contact pressure by (x, z) cell [Pa]. Restarts the sums.
   */
  readContact(): { force: number; torque: number; steps: number; byZ: Float64Array; map: Float64Array } | null {
    const s = this.accSteps;
    if (s === 0) return null;
    const { nzN, h, nBinsX } = this;
    const byZ = new Float64Array(nzN - 1);
    for (let iz = 1; iz < nzN; iz++) byZ[iz - 1] = this.accFz[iz] / s / (iz === 1 ? h / 2 : h);
    const map = new Float64Array(nBinsX * (nzN - 1));
    for (let b = 0; b < nBinsX; b++) for (let iz = 1; iz < nzN; iz++) map[b * (nzN - 1) + iz - 1] = this.accMap[b * nzN + iz] / s / (h * (iz === 1 ? h / 2 : h));
    const out = { force: (2 * this.accFy) / s, torque: (2 * this.accTq) / s, steps: s, byZ, map };
    this.accFy = 0;
    this.accTq = 0;
    this.accSteps = 0;
    this.accFz.fill(0);
    this.accMap.fill(0);
    return out;
  }

  /**
   * The strip at x (the exit probe), in a band of one cell: the half width (the edge points' outer faces), the
   * half thickness by lattice column across the width (the top points' upper faces), and the mean speed.
   * null until material is there.
   */
  exitMeasure(x = this.xExitProbe, band = this.h): { halfWidth: number; halfThickness: Float64Array; speed: number } | null {
    const { active, px, py, pz, vx, F, NI, NJ, NK, dp, dz } = this;
    const thick = new Float64Array(NK);
    const count = new Int32Array(NK);
    let w = 0;
    let nw = 0;
    let v = 0;
    let nv = 0;
    for (let i = 0; i < NI; i++) {
      // the column's first point tells where it is
      const p0 = this.lattice(i, 0, 0);
      if (!active[p0] || Math.abs(px[p0] - x) > 2 * band) continue;
      for (let k = 0; k < NK; k++) {
        const p = this.lattice(i, NJ - 1, k);
        if (!active[p] || Math.abs(px[p] - x) > band / 2) continue;
        thick[k] += py[p] + 0.5 * dp * F[9 * p + 4];
        count[k]++;
        v += vx[p];
        nv++;
      }
      for (let j = 0; j < NJ; j++) {
        const p = this.lattice(i, j, NK - 1);
        if (!active[p] || Math.abs(px[p] - x) > band / 2) continue;
        w += pz[p] + 0.5 * dz * F[9 * p + 8];
        nw++;
      }
    }
    if (nw === 0 || nv === 0) return null;
    for (let k = 0; k < NK; k++) thick[k] = count[k] ? thick[k] / count[k] : NaN;
    return { halfWidth: w / nw, halfThickness: thick, speed: v / nv };
  }

  /** the half width along the strip: the edge points' outer faces, the mean through the thickness, by lattice column (NaN where none is on the grid) */
  edgeProfile(): { x: Float64Array; halfWidth: Float64Array } {
    const { active, px, pz, F, NI, NJ, NK, dz } = this;
    const x = new Float64Array(NI);
    const hw = new Float64Array(NI);
    for (let i = 0; i < NI; i++) {
      let sx = 0;
      let sw = 0;
      let c = 0;
      for (let j = 0; j < NJ; j++) {
        const p = this.lattice(i, j, NK - 1);
        if (!active[p]) continue;
        sx += px[p];
        sw += pz[p] + 0.5 * dz * F[9 * p + 8];
        c++;
      }
      x[i] = c ? sx / c : NaN;
      hw[i] = c ? sw / c : NaN;
    }
    return { x, halfWidth: hw };
  }

  maxDamage(): number {
    let m = 0;
    for (let p = 0; p < this.n; p++) if (this.active[p] && !this.failed[p]) m = Math.max(m, this.governingDamage(p));
    return m;
  }
}

function det3(F: Float64Array, o: number): number {
  return F[o] * (F[o + 4] * F[o + 8] - F[o + 5] * F[o + 7]) - F[o + 1] * (F[o + 3] * F[o + 8] - F[o + 5] * F[o + 6]) + F[o + 2] * (F[o + 3] * F[o + 7] - F[o + 4] * F[o + 6]);
}

/** largest eigenvalue of the symmetric tensor [[a, d, f], [d, b, e], [f, e, c]] (trigonometric form) */
export function maxPrincipal(a: number, b: number, c: number, d: number, e: number, f: number): number {
  const m = (a + b + c) / 3;
  const p1 = d * d + e * e + f * f;
  const a0 = a - m;
  const b0 = b - m;
  const c0 = c - m;
  const p2 = a0 * a0 + b0 * b0 + c0 * c0 + 2 * p1;
  if (p2 <= 0) return m;
  const pp = Math.sqrt(p2 / 6);
  const detB = (a0 * (b0 * c0 - e * e) - d * (d * c0 - e * f) + f * (d * e - b0 * f)) / (pp * pp * pp);
  const r = Math.max(-1, Math.min(1, detB / 2));
  return m + 2 * pp * Math.cos(Math.acos(r) / 3);
}
