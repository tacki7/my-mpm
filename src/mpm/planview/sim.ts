// Plan-view MPM of a strip passing between two rigid rolls: x along rolling, z across the
// width, the thickness h a state of each material point. The section model (solver.ts)
// cannot have edge cracks — it has no width; this one resolves the width and averages
// through the thickness.
//
// - Half the width is solved: the mid-width plane z = 0 is a symmetry plane (grid nodes at
//   z ≤ 0 get v_z = 0, v_x stays free); the edge z = W/2 is free.
// - Thickness: where a point is thicker than the roll gap h_gap(x) it is in contact and its
//   thickness follows the gap (D_yy = ln(h_gap/h)/Δt, imposed); the through-thickness stress
//   σ_yy that comes out is minus the contact pressure. Elsewhere σ_yy = 0 (plane stress):
//   D_yy is found by a secant iteration on σ_yy. If the imposed D_yy would pull (σ_yy > 0)
//   the point is let go and treated as free.
// - The stress is a 3D deviator (s_xx, s_zz, s_xz, s_yy) updated as in the section model
//   (Jaumann rotation by the in-plane spin, elastic trial, J2 radial return of material.ts)
//   with the pressure from the volume ratio (one place: volumeRatio / pressureOf).
// - In-plane equilibrium through the thickness: ∂(h σ_ij)/∂x_j + 2τ_i + 2 p_c (−tan φ, 0) = 0.
//   The MPM stress term carries V σ = A h σ; the rolls act on a point in contact as a body
//   force: Coulomb friction μ p_c on both faces towards the roll's surface speed (regularised
//   over 1 % of it), and the pressure's component along x on the sloping roll surfaces.
// - Pusher, tensions, mass scaling and the mill-speed scaling of the strain rate mean the
//   same as in the section model and use the same parameters.
import { biteGeometry, type DamageModel, type Defect, type SimParams } from '../params.ts';
import { elasticConstants, hmFractureStrain, homologousTemperature, jcFractureStrain, plasticIncrement, type Elastic } from '../material.ts';

export interface PlanViewParams {
  /** full strip width at the entry [m] */
  width: number;
  /** grid cells across the half width */
  cellsHalfWidth: number;
}

export interface PlanSimParams extends SimParams {
  plan: PlanViewParams;
}

export type PlanPhase = 'approach' | 'bite' | 'steady' | 'tail-out' | 'done';

export interface PlanCrack {
  id: number;
  t: number;
  step: number;
  x: number;
  z: number;
  /** where it sat in the undeformed strip: from the head end backwards, from the mid-width [m] */
  sheetX: number;
  sheetZ: number;
  eta: number;
  s1: number;
  seq: number;
  ep: number;
  criterion: DamageModel;
  count: number;
}

const INF = 1e30;

export class PlanSim {
  readonly params: PlanSimParams;
  readonly el: Elastic;
  readonly h: number; // grid spacing
  readonly invH: number;
  readonly dp: number; // initial particle spacing
  readonly dt: number;
  readonly gap: number;
  readonly contactLength: number;
  readonly xExitProbe: number;
  readonly vIn: number;
  readonly xHead0: number;
  readonly halfWidth0: number;
  readonly tensionRamp: number;
  readonly gripCols: number;

  // grid
  readonly nxN: number;
  readonly nzN: number;
  readonly ox: number;
  readonly oz: number;
  readonly gm: Float64Array;
  readonly gvx: Float64Array;
  readonly gvz: Float64Array;
  private readonly gpush: Uint8Array;

  // particles (lattice order: index = i * NK + k, i from the tail, k from the mid-width)
  readonly n: number;
  readonly NI: number;
  readonly NK: number;
  readonly lattice: Int32Array;
  readonly li: Int32Array;
  readonly lk: Int32Array;
  readonly x0: Float64Array;
  readonly z0: Float64Array;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  readonly c00: Float64Array;
  readonly c01: Float64Array;
  readonly c10: Float64Array;
  readonly c11: Float64Array;
  readonly f00: Float64Array; // in-plane deformation gradient (x, z)
  readonly f01: Float64Array;
  readonly f10: Float64Array;
  readonly f11: Float64Array;
  readonly thick: Float64Array; // current thickness [m]
  readonly mass: Float64Array;
  readonly sxx: Float64Array; // deviatoric stress (y is the thickness)
  readonly szz: Float64Array;
  readonly sxz: Float64Array;
  readonly syy: Float64Array;
  readonly pres: Float64Array; // compression positive
  readonly pc: Float64Array; // contact pressure of the last step (0 when free) [Pa]
  readonly dyy: Float64Array; // thickness strain rate of the last step [1/s]
  readonly ep: Float64Array;
  readonly seq: Float64Array;
  readonly eta: Float64Array;
  readonly s1: Float64Array;
  readonly dJC: Float64Array;
  readonly dHM: Float64Array;
  readonly dCL: Float64Array;
  readonly duct: Float64Array;
  readonly active: Uint8Array;
  readonly failed: Uint8Array;
  readonly crackId: Int32Array;
  readonly cracks: PlanCrack[] = [];

  t = 0;
  step = 0;
  pusherActive = true;
  backNow = 0;
  frontNow = 0;
  private frontOnAt = -1;
  private backOffAt = -1;
  // roll force accumulated since the last diagnostics read (per roll) [N]
  private accForce = 0;
  private accSteps = 0;

  constructor(input: PlanSimParams) {
    const P: PlanSimParams = {
      rolling: { ...input.rolling },
      material: { ...input.material },
      damage: { ...input.damage, gtn: { ...input.damage.gtn } },
      numerics: { ...input.numerics },
      defects: input.defects.map((d) => ({ ...d })),
      plan: { ...input.plan },
    };
    this.params = P;
    const r = P.rolling;
    const num = P.numerics;
    this.el = elasticConstants(P.material);
    const geo = biteGeometry(r);
    this.gap = geo.gap;
    this.contactLength = geo.contactLength;
    const W2 = P.plan.width / 2;
    this.halfWidth0 = W2;
    const h = W2 / P.plan.cellsHalfWidth;
    this.h = h;
    this.invH = 1 / h;
    const dp = h / num.ppc;
    this.dp = dp;
    const Lc = geo.contactLength;
    this.xHead0 = -Lc - Math.max(2 * r.h0, 4 * h);
    const xTail0 = this.xHead0 - r.sheetLength;
    const elongated = r.sheetLength / (1 - r.reduction);
    const xEnd = 2 * r.h0 + 2 * h + elongated * 1.1 + 8 * h;
    this.ox = xTail0 - 6 * h;
    this.oz = -3 * h;
    this.nxN = Math.ceil((xEnd - this.ox) / h) + 1;
    // room for the width to spread
    this.nzN = Math.ceil((W2 * 1.3 + 6 * h - this.oz) / h) + 1;
    const nNodes = this.nxN * this.nzN;
    this.gm = new Float64Array(nNodes);
    this.gvx = new Float64Array(nNodes);
    this.gvz = new Float64Array(nNodes);
    this.gpush = new Uint8Array(nNodes);
    this.xExitProbe = Math.max(3 * r.h0, 6 * h);

    const NI = Math.round(r.sheetLength / dp);
    const NK = Math.round(W2 / dp);
    this.NI = NI;
    this.NK = NK;
    this.gripCols = Math.max(1, Math.ceil(r.h0 / dp));
    const lattice = new Int32Array(NI * NK).fill(-1);
    const keep: number[] = [];
    const ductOf: number[] = [];
    for (let i = 0; i < NI; i++) {
      for (let k = 0; k < NK; k++) {
        const X = xTail0 + (i + 0.5) * dp;
        const Z = (k + 0.5) * dp;
        const sx = this.xHead0 - X;
        let duct = 1;
        let skip = false;
        for (const d of P.defects) if (inside(d, sx, Z)) {
          if (d.kind === 'void') skip = true;
          else duct = Math.min(duct, d.ductility ?? 1);
        }
        if (skip) continue;
        lattice[i * NK + k] = keep.length;
        keep.push(i * NK + k);
        ductOf.push(duct);
      }
    }
    this.lattice = lattice;
    const n = keep.length;
    this.n = n;
    const F = () => new Float64Array(n);
    this.li = new Int32Array(n);
    this.lk = new Int32Array(n);
    this.x0 = F();
    this.z0 = F();
    this.px = F();
    this.pz = F();
    this.vx = F();
    this.vz = F();
    this.c00 = F();
    this.c01 = F();
    this.c10 = F();
    this.c11 = F();
    this.f00 = F();
    this.f01 = F();
    this.f10 = F();
    this.f11 = F();
    this.thick = F();
    this.mass = F();
    this.sxx = F();
    this.szz = F();
    this.sxz = F();
    this.syy = F();
    this.pres = F();
    this.pc = F();
    this.dyy = F();
    this.ep = F();
    this.seq = F();
    this.eta = F();
    this.s1 = F();
    this.dJC = F();
    this.dHM = F();
    this.dCL = F();
    this.duct = F();
    this.active = new Uint8Array(n).fill(1);
    this.failed = new Uint8Array(n);
    this.crackId = new Int32Array(n).fill(-1);

    this.vIn = r.rollSpeed * (1 - r.reduction);
    const rho = P.material.rho * num.massScale;
    for (let q = 0; q < n; q++) {
      const cell = keep[q];
      const i = Math.floor(cell / NK);
      const k = cell - i * NK;
      this.li[q] = i;
      this.lk[q] = k;
      const X = xTail0 + (i + 0.5) * dp;
      const Z = (k + 0.5) * dp;
      this.x0[q] = X;
      this.z0[q] = Z;
      this.px[q] = X;
      this.pz[q] = Z;
      this.vx[q] = this.vIn;
      this.f00[q] = 1;
      this.f11[q] = 1;
      this.thick[q] = r.h0;
      this.mass[q] = rho * dp * dp * r.h0;
      this.duct[q] = ductOf[q];
    }
    const { K, G } = this.el;
    const c = Math.sqrt((K + (4 / 3) * G) / rho);
    this.dt = (num.cfl * h) / (c + 1.5 * r.rollSpeed);
    this.tensionRamp = r.tensionRamp && r.tensionRamp > 0 ? r.tensionRamp : (10 * r.sheetLength) / c;
  }

  /** Roll gap at x (both rolls; the gap opens again past the exit) [m]. */
  gapAt(x: number): number {
    const R = this.params.rolling.rollRadius;
    const a = Math.min(Math.abs(x), 0.999 * R);
    return this.gap + 2 * (R - Math.sqrt(R * R - a * a));
  }

  /** Volume ratio of a point from its in-plane deformation and its thickness. The one place the volume enters the stress (T21 may smooth it). */
  volumeRatio(detF: number, thickness: number): number {
    return (detF * thickness) / this.params.rolling.h0;
  }

  pressureOf(J: number): number {
    return J > 0 ? -this.el.K * Math.log(J) : 0;
  }

  advance(): void {
    this.updateTension();
    this.p2g();
    this.gridUpdate();
    this.g2p();
    if (this.pusherActive && this.headX() > this.xExitProbe) this.pusherActive = false;
    this.t += this.dt;
    this.step++;
  }

  private p2g(): void {
    const { n, active, px, pz, dt, h, invH, ox, oz, nzN, gm, gvx, gvz, gpush } = this;
    const r = this.params.rolling;
    const R = r.rollRadius;
    const mu = r.mu;
    const vRoll = r.rollSpeed;
    const vEps = 0.01 * vRoll;
    gm.fill(0);
    gvx.fill(0);
    gvz.fill(0);
    gpush.fill(0);
    const k4 = 4 * invH * invH;
    const grip = this.gripCols;
    const NI = this.NI;
    // end loads: the stress times the end's current cross-section, shared by the grip's columns
    const backForce = this.backNow;
    const frontForce = this.frontNow;
    const pushing = this.pusherActive;
    let force = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const zp = pz[p];
      const gx = (xp - ox) * invH;
      const gz = (zp - oz) * invH;
      const bx = Math.floor(gx - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fz = gz - bz;
      const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx);
      const wx1 = 0.75 - (fx - 1) * (fx - 1);
      const wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
      const wz0 = 0.5 * (1.5 - fz) * (1.5 - fz);
      const wz1 = 0.75 - (fz - 1) * (fz - 1);
      const wz2 = 0.5 * (fz - 0.5) * (fz - 0.5);

      const detF = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
      const area = this.dp * this.dp * detF;
      const vol = area * this.thick[p];
      const pr = this.pres[p];
      const k = -dt * vol * k4;
      const m = this.mass[p];
      const a00 = k * (this.sxx[p] - pr) + m * this.c00[p];
      const a01 = k * this.sxz[p] + m * this.c01[p];
      const a10 = k * this.sxz[p] + m * this.c10[p];
      const a11 = k * (this.szz[p] - pr) + m * this.c11[p];
      let mvx = m * this.vx[p];
      let mvz = m * this.vz[p];
      // the rolls on a point in contact: friction on both faces and the x-component of the pressure
      const pcp = this.pc[p];
      if (pcp > 0) {
        const dvx = vRoll - this.vx[p];
        const dvz = -this.vz[p];
        const s = (2 * mu * pcp * area) / Math.sqrt(dvx * dvx + dvz * dvz + vEps * vEps);
        const a = Math.min(Math.abs(xp), 0.999 * R);
        const tanPhi = -xp / Math.sqrt(R * R - a * a);
        mvx += dt * (s * dvx - 2 * pcp * tanPhi * area);
        mvz += dt * s * dvz;
        force += pcp * area;
      }
      const i = this.li[p];
      if (backForce !== 0 && i < grip) mvx -= (dt * backForce * this.thick[p] * this.dp * Math.hypot(this.f01[p], this.f11[p])) / grip;
      else if (frontForce !== 0 && i >= NI - grip) mvx += (dt * frontForce * this.thick[p] * this.dp * Math.hypot(this.f01[p], this.f11[p])) / grip;
      const pushMark = pushing && i === 0;

      for (let ii = 0; ii < 3; ii++) {
        const wx = ii === 0 ? wx0 : ii === 1 ? wx1 : wx2;
        const dx = (ii - fx) * h;
        const col = (bx + ii) * nzN + bz;
        for (let jj = 0; jj < 3; jj++) {
          const w = wx * (jj === 0 ? wz0 : jj === 1 ? wz1 : wz2);
          const dz = (jj - fz) * h;
          const idx = col + jj;
          gm[idx] += w * m;
          gvx[idx] += w * (mvx + a00 * dx + a01 * dz);
          gvz[idx] += w * (mvz + a10 * dx + a11 * dz);
          if (pushMark) gpush[idx] = 1;
        }
      }
    }
    this.accForce += force;
    this.accSteps++;
  }

  private gridUpdate(): void {
    const { gm, gvx, gvz, gpush, nxN, nzN, oz, h } = this;
    const mMin = 1e-12 * this.mass[0];
    const vPush = this.vIn;
    const pushing = this.pusherActive;
    // nodes on or below the mid-width plane: symmetry, v_z = 0 (v_x free)
    const kSym = Math.floor((0 - oz) / h + 1e-9);
    for (let i = 0; i < nxN; i++) {
      for (let k = 0; k < nzN; k++) {
        const idx = i * nzN + k;
        const m = gm[idx];
        if (m <= mMin) {
          gvx[idx] = 0;
          gvz[idx] = 0;
          continue;
        }
        let vx = gvx[idx] / m;
        let vz = gvz[idx] / m;
        if (k <= kSym) vz = 0;
        if (pushing && gpush[idx] && vx < vPush) vx = vPush;
        gvx[idx] = vx;
        gvz[idx] = vz;
      }
    }
  }

  private g2p(): void {
    const { n, active, px, pz, gvx, gvz, dt, h, invH, ox, oz, nzN, nxN } = this;
    const k4 = 4 * invH * invH;
    const xMax = (nxN - 3) * h + ox;
    const zMax = (nzN - 3) * h + oz;
    const xMin = ox + 2 * h;
    for (let p = 0; p < n; p++) {
      if (!active[p]) continue;
      const xp = px[p];
      const zp = pz[p];
      const gx = (xp - ox) * invH;
      const gz = (zp - oz) * invH;
      const bx = Math.floor(gx - 0.5);
      const bz = Math.floor(gz - 0.5);
      const fx = gx - bx;
      const fz = gz - bz;
      const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx);
      const wx1 = 0.75 - (fx - 1) * (fx - 1);
      const wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
      const wz0 = 0.5 * (1.5 - fz) * (1.5 - fz);
      const wz1 = 0.75 - (fz - 1) * (fz - 1);
      const wz2 = 0.5 * (fz - 0.5) * (fz - 0.5);
      let vx = 0;
      let vz = 0;
      let b00 = 0;
      let b01 = 0;
      let b10 = 0;
      let b11 = 0;
      for (let ii = 0; ii < 3; ii++) {
        const wx = ii === 0 ? wx0 : ii === 1 ? wx1 : wx2;
        const dx = (ii - fx) * h;
        const col = (bx + ii) * nzN + bz;
        for (let jj = 0; jj < 3; jj++) {
          const w = wx * (jj === 0 ? wz0 : jj === 1 ? wz1 : wz2);
          const dz = (jj - fz) * h;
          const idx = col + jj;
          const ux = gvx[idx];
          const uz = gvz[idx];
          vx += w * ux;
          vz += w * uz;
          b00 += w * ux * dx;
          b01 += w * ux * dz;
          b10 += w * uz * dx;
          b11 += w * uz * dz;
        }
      }
      // APIC affine velocity = velocity gradient L (L_ij = ∂v_i/∂x_j)
      const l00 = k4 * b00;
      const l01 = k4 * b01;
      const l10 = k4 * b10;
      const l11 = k4 * b11;
      this.c00[p] = l00;
      this.c01[p] = l01;
      this.c10[p] = l10;
      this.c11[p] = l11;
      this.vx[p] = vx;
      this.vz[p] = vz;
      const nx = xp + dt * vx;
      let nz = zp + dt * vz;
      if (nz < 0) nz = 0;
      px[p] = nx;
      pz[p] = nz;
      if (nx < xMin || nx > xMax || nz > zMax) {
        active[p] = 0;
        continue;
      }
      const F00 = this.f00[p];
      const F01 = this.f01[p];
      const F10 = this.f10[p];
      const F11 = this.f11[p];
      this.f00[p] = (1 + dt * l00) * F00 + dt * l01 * F10;
      this.f01[p] = (1 + dt * l00) * F01 + dt * l01 * F11;
      this.f10[p] = dt * l10 * F00 + (1 + dt * l11) * F10;
      this.f11[p] = dt * l10 * F01 + (1 + dt * l11) * F11;
      this.constitutive(p, l00, l01, l10, l11, nx);
    }
  }

  /**
   * One constitutive step of point p: the thickness (contact with the rolls or plane stress),
   * the 3D deviatoric stress with the J2 return, the pressure, the damage indicators.
   */
  private constitutive(p: number, l00: number, l01: number, l10: number, l11: number, x: number): void {
    const P = this.params;
    const dt = this.dt;
    const { G } = this.el;
    const dxx = l00;
    const dzz = l11;
    const dxz = 0.5 * (l01 + l10);
    const w = 0.5 * (l01 - l10);
    // Jaumann rotation by the in-plane spin (s_yy does not turn)
    let sx = this.sxx[p];
    let sz = this.szz[p];
    let sh = this.sxz[p];
    const sy = this.syy[p];
    const rot = dt * w;
    const rx = sx + 2 * rot * sh;
    const rz = sz - 2 * rot * sh;
    const rh = sh + rot * (sz - sx);
    sx = rx;
    sz = rz;
    sh = rh;
    const detF = this.f00[p] * this.f11[p] - this.f01[p] * this.f10[p];
    const h0 = this.thick[p];
    const rateScale = P.rolling.millSpeed / P.rolling.rollSpeed;

    if (this.failed[p]) {
      // no deviatoric stress; the thickness keeps its volume, the pressure only in compression (or nothing)
      this.sxx[p] = this.szz[p] = this.sxz[p] = this.syy[p] = 0;
      const J = this.volumeRatio(detF, h0);
      const pr = this.pressureOf(J);
      this.pres[p] = P.damage.failure === 'erode' || pr < 0 ? 0 : pr;
      this.pc[p] = 0;
      return;
    }

    // result of the update for a given thickness strain rate
    const out = { sx: 0, sz: 0, sh: 0, sy: 0, pr: 0, q: 0, dep: 0, thick: 0, epsDot: 0 };
    const evaluate = (Dyy: number): number => {
      const tr3 = (dxx + Dyy + dzz) / 3;
      const ex = dxx - tr3;
      const ey = Dyy - tr3;
      const ez = dzz - tr3;
      const epsDot = Math.sqrt((2 / 3) * (ex * ex + ey * ey + ez * ez + 2 * dxz * dxz)) * rateScale;
      const g2 = 2 * G * dt;
      let tx = sx + g2 * ex;
      let ty = sy + g2 * ey;
      let tz = sz + g2 * ez;
      let th = sh + g2 * dxz;
      const thick = h0 * Math.exp(Dyy * dt);
      const pr = this.pressureOf(this.volumeRatio(detF, thick));
      let q = Math.sqrt(1.5 * (tx * tx + ty * ty + tz * tz + 2 * th * th));
      const dep = plasticIncrement(P.material, G, q, this.ep[p], epsDot, P.material.tRoom);
      if (dep > 0) {
        const f = 1 - (3 * G * dep) / q;
        tx *= f;
        ty *= f;
        tz *= f;
        th *= f;
        q -= 3 * G * dep;
      }
      out.sx = tx;
      out.sy = ty;
      out.sz = tz;
      out.sh = th;
      out.pr = pr;
      out.q = q;
      out.dep = dep;
      out.thick = thick;
      out.epsDot = epsDot;
      return ty - pr; // σ_yy
    };

    const g = this.gapAt(x);
    let contact = h0 > g && Math.abs(x) < 0.5 * P.rolling.rollRadius;
    let Dyy = 0;
    if (contact) {
      Dyy = Math.log(g / h0) / dt;
      const syy = evaluate(Dyy);
      if (syy > 0) contact = false;
    }
    if (!contact) {
      // plane stress: σ_yy(D_yy) = 0 by secant steps from the elastic slope
      const slope = (this.el.K + (4 / 3) * G) * dt;
      let d0 = this.dyy[p];
      let f0 = evaluate(d0);
      let d1 = d0 - f0 / slope;
      let f1 = evaluate(d1);
      const tol = 1e-6 * Math.max(1e6, out.q);
      for (let it = 0; it < 8 && Math.abs(f1) > tol; it++) {
        const s = f1 !== f0 ? (f1 - f0) / (d1 - d0) : slope;
        const d2 = d1 - f1 / (s > 0 ? s : slope);
        d0 = d1;
        f0 = f1;
        d1 = d2;
        f1 = evaluate(d1);
      }
      Dyy = d1;
    }
    this.sxx[p] = out.sx;
    this.szz[p] = out.sz;
    this.sxz[p] = out.sh;
    this.syy[p] = out.sy;
    this.pres[p] = out.pr;
    this.thick[p] = out.thick;
    this.dyy[p] = Dyy;
    const syyC = out.sy - out.pr;
    this.pc[p] = contact && syyC < 0 ? -syyC : 0;
    const q = out.q;
    const dep = out.dep;
    this.ep[p] += dep;

    // stress state of σ = s − p I
    const cxx = out.sx - out.pr;
    const czz = out.sz - out.pr;
    const cyy = syyC;
    const cc = 0.5 * (cxx + czz);
    const rr = Math.sqrt(0.25 * (cxx - czz) * (cxx - czz) + out.sh * out.sh);
    const s1 = Math.max(cc + rr, cyy);
    const eta = q > 1e3 ? -out.pr / q : 0;
    this.seq[p] = q;
    this.eta[p] = eta;
    this.s1[p] = s1;

    if (dep > 0) {
      const dmg = P.damage;
      const du = 1 / this.duct[p];
      const Ts = homologousTemperature(P.material, P.material.tRoom);
      const epsDotStar = out.epsDot / P.material.epsDot0;
      if (eta > dmg.etaCutoff) {
        this.dJC[p] += (dep / jcFractureStrain(dmg, eta, epsDotStar, Ts)) * du;
        this.dHM[p] += (dep / hmFractureStrain(eta)) * du;
      }
      if (s1 > 0) this.dCL[p] += ((s1 / q) * dep * du) / dmg.clCrit;
      if (dmg.model !== 'none' && this.governingDamage(p) >= 1 && !this.inGrip(p)) this.fail(p);
    }
  }

  /** In the gripped length (h0) of an end that carries a tension: damage is shown but the point does not fail. */
  inGrip(p: number): boolean {
    const r = this.params.rolling;
    const i = this.li[p];
    return (r.frontTension !== 0 && i >= this.NI - this.gripCols) || (r.backTension !== 0 && i < this.gripCols);
  }

  governingDamage(p: number): number {
    switch (this.params.damage.model) {
      case 'johnson-cook':
        return this.dJC[p];
      case 'hancock-mackenzie':
        return this.dHM[p];
      case 'cockcroft-latham':
        return this.dCL[p];
      default:
        return 0;
    }
  }

  private fail(p: number): void {
    this.failed[p] = 1;
    const { NI, NK, lattice, crackId } = this;
    const i0 = this.li[p];
    const k0 = this.lk[p];
    let id = -1;
    for (let i = Math.max(0, i0 - 2); i <= Math.min(NI - 1, i0 + 2) && id < 0; i++) {
      for (let k = Math.max(0, k0 - 2); k <= Math.min(NK - 1, k0 + 2); k++) {
        const q = lattice[i * NK + k];
        if (q >= 0 && crackId[q] >= 0) {
          id = crackId[q];
          break;
        }
      }
    }
    if (id >= 0) {
      crackId[p] = id;
      this.cracks[id].count++;
      return;
    }
    id = this.cracks.length;
    crackId[p] = id;
    this.cracks.push({
      id,
      t: this.t,
      step: this.step,
      x: this.px[p],
      z: this.pz[p],
      sheetX: this.xHead0 - this.x0[p],
      sheetZ: this.z0[p],
      eta: this.eta[p],
      s1: this.s1[p],
      seq: this.seq[p],
      ep: this.ep[p],
      criterion: this.params.damage.model,
      count: 1,
    });
  }

  headX(): number {
    let x = -INF;
    const { n, active, px, li, NI } = this;
    for (let p = 0; p < n; p++) if (active[p] && li[p] === NI - 1 && px[p] > x) x = px[p];
    return x === -INF ? INF : x;
  }

  tailX(): number {
    let x = INF;
    const { n, active, px, li } = this;
    for (let p = 0; p < n; p++) if (active[p] && li[p] === 0 && px[p] < x) x = px[p];
    return x;
  }

  phase(): PlanPhase {
    const head = this.headX();
    const tail = this.tailX();
    if (tail > 2 * this.params.rolling.h0 || tail === INF) return 'done';
    if (head < -this.contactLength) return 'approach';
    if (head < this.xExitProbe) return 'bite';
    if (tail > -this.contactLength) return 'tail-out';
    return 'steady';
  }

  /** Tensions as in the section model: back tension ramps up and is released once the tail reaches the entry; front tension from when the head passes the exit probe. */
  private updateTension(): void {
    const r = this.params.rolling;
    const t = this.t;
    const ramp = this.tensionRamp;
    if (r.backTension !== 0) {
      if (this.backOffAt < 0 && this.tailX() >= -this.contactLength) this.backOffAt = t;
      let back = r.backTension * Math.min(1, t / ramp);
      const release = Math.min(ramp, this.contactLength / this.vIn);
      if (this.backOffAt >= 0) back *= Math.max(0, 1 - (t - this.backOffAt) / release);
      this.backNow = back;
    }
    if (r.frontTension !== 0) {
      if (this.frontOnAt < 0 && this.headX() > this.xExitProbe) this.frontOnAt = t;
      this.frontNow = this.frontOnAt >= 0 ? r.frontTension * Math.min(1, (t - this.frontOnAt) / ramp) : 0;
    }
  }

  /** Roll force per roll since the last read [N] (the half width: double it for the whole strip). */
  readForce(): number {
    const f = this.accSteps > 0 ? this.accForce / this.accSteps : 0;
    this.accForce = 0;
    this.accSteps = 0;
    return f;
  }

  /**
   * The exit strip across the width: points with x in [x0, x1], binned by their current z.
   * Mean thickness, σxx, longitudinal log strain ln|F e_x| and speed per bin, and the half
   * width: the mean z of the edge column (the outermost lattice column) plus half its
   * current spacing across the width (NaN when no edge point is there).
   */
  exitProfile(x0: number, x1: number, bins: number) {
    const { n, active, px, pz } = this;
    let zMax = 0;
    let edgeZ = 0;
    let edgeN = 0;
    for (let p = 0; p < n; p++) {
      if (!active[p] || this.failed[p] || px[p] < x0 || px[p] > x1) continue;
      if (pz[p] > zMax) zMax = pz[p];
      if (this.lk[p] === this.NK - 1) {
        edgeZ += pz[p] + 0.5 * this.dp * Math.hypot(this.f01[p], this.f11[p]);
        edgeN++;
      }
    }
    const halfWidth = edgeN ? edgeZ / edgeN : NaN;
    const width = zMax > 0 ? zMax : this.halfWidth0;
    const acc = Array.from({ length: bins }, () => ({ n: 0, thick: 0, sxx: 0, exx: 0, vx: 0, eta: 0 }));
    for (let p = 0; p < n; p++) {
      if (!active[p] || this.failed[p] || px[p] < x0 || px[p] > x1) continue;
      const b = Math.min(bins - 1, Math.floor((pz[p] / width) * bins));
      const a = acc[b];
      a.n++;
      a.thick += this.thick[p];
      a.sxx += this.sxx[p] - this.pres[p];
      a.exx += Math.log(Math.hypot(this.f00[p], this.f10[p]));
      a.vx += this.vx[p];
      a.eta += this.eta[p];
    }
    return {
      halfWidth,
      bins: acc.map((a, b) => ({
        z: ((b + 0.5) / bins) * width,
        n: a.n,
        thick: a.n ? a.thick / a.n : NaN,
        sxx: a.n ? a.sxx / a.n : NaN,
        exx: a.n ? a.exx / a.n : NaN,
        vx: a.n ? a.vx / a.n : NaN,
        eta: a.n ? a.eta / a.n : NaN,
      })),
    };
  }
}

function inside(d: Defect, x: number, z: number): boolean {
  const u = (x - d.x) / d.ax;
  const v = (z - d.y) / d.ay;
  return u * u + v * v <= 1;
}

/** A plan-view condition from the section model's defaults and a strip width. */
export function planParams(base: SimParams, width: number, cellsHalfWidth: number): PlanSimParams {
  return {
    rolling: { ...base.rolling },
    material: { ...base.material },
    damage: { ...base.damage, gtn: { ...base.damage.gtn } },
    numerics: { ...base.numerics },
    defects: base.defects.map((d) => ({ ...d })),
    plan: { width, cellsHalfWidth },
  };
}
