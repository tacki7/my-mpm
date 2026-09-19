// Input of one rolling simulation. SI units throughout (m, kg, s, Pa, K);
// the UI converts to mm / MPa for display.

export type HardeningModel = 'johnson-cook' | 'swift';

/** Which damage indicator decides failure. All of them are always accumulated for display. */
export type DamageModel = 'johnson-cook' | 'hancock-mackenzie' | 'cockcroft-latham' | 'none';

/**
 * What a failed material point can still carry.
 * - erode: nothing (Banerjee 2012: the stress of a failed particle is set to zero)
 * - tension-cut: hydrostatic compression only, so a crack closes again under the roll
 */
export type FailureMode = 'erode' | 'tension-cut';

export interface MaterialParams {
  name: string;
  rho: number; // density [kg/m^3]
  E: number; // Young's modulus [Pa]
  nu: number; // Poisson's ratio
  hardening: HardeningModel;
  // Johnson-Cook flow stress: σy = (A + B εp^n)(1 + C ln ε̇*)(1 − T*^m)
  jcA: number; // [Pa]
  jcB: number; // [Pa]
  jcN: number;
  jcC: number;
  jcM: number;
  epsDot0: number; // reference strain rate [1/s]
  // Swift flow stress: σy = K (ε0 + εp)^n
  swK: number; // [Pa]
  swE0: number;
  swN: number;
  tRoom: number; // [K]
  tMelt: number; // [K]
}

export interface DamageParams {
  model: DamageModel;
  // Johnson-Cook fracture strain: εf = [D1 + D2 exp(D3 η)][1 + D4 ln ε̇*][1 + D5 T*]
  D1: number;
  D2: number;
  D3: number;
  D4: number;
  D5: number;
  /** Cockcroft-Latham: failure when ∫ max(σ1, 0)/σeq dεp reaches this value */
  clCrit: number;
  /** no damage accumulates while the triaxiality η = σm/σeq is below this (Bao-Wierzbicki cut-off −1/3) */
  etaCutoff: number;
  failure: FailureMode;
}

export interface RollingParams {
  h0: number; // entry thickness [m]
  reduction: number; // (h0 − gap)/h0, rigid rolls
  rollRadius: number; // [m]
  sheetLength: number; // [m]
  rollSpeed: number; // simulated roll surface speed [m/s]
  /** real mill speed [m/s]; strain rates are scaled by millSpeed/rollSpeed before entering rate-dependent laws */
  millSpeed: number;
  mu: number; // Coulomb friction coefficient roll/sheet
  backTension: number; // [Pa] on the tail end
  frontTension: number; // [Pa] on the head end once it has left the roll bite
}

export interface NumericsParams {
  cellsThrough: number; // grid cells through the entry thickness
  ppc: number; // particles per cell per direction
  massScale: number; // density multiplier for the explicit time step (quasi-static assumption)
  cfl: number;
  /** smooth the volume change over the grid (J-bar) to avoid volumetric locking of isochoric plastic flow */
  jbar: boolean;
}

/**
 * A pre-existing defect, placed in sheet coordinates: x measured from the head end
 * backwards [m], y from the mid-plane [m].
 * - void: no material inside
 * - weak: material whose damage accumulates `1/ductility` times faster
 */
export interface Defect {
  kind: 'void' | 'weak';
  x: number;
  y: number;
  /** half-size along x and y [m] (an axis-aligned ellipse) */
  ax: number;
  ay: number;
  ductility?: number;
}

export interface SimParams {
  rolling: RollingParams;
  material: MaterialParams;
  damage: DamageParams;
  numerics: NumericsParams;
  defects: Defect[];
}

const MPa = 1e6;
const mm = 1e-3;

/** AISI 4340 steel — the constants of Banerjee, arXiv:1201.2439 (Table: 4340 steel). */
export const STEEL_4340: MaterialParams = {
  name: 'AISI 4340 鋼（Banerjee 2012）',
  rho: 7830,
  // K = 173.3 GPa, μ = 80 GPa → E, ν
  E: (9 * 173.3e9 * 80e9) / (3 * 173.3e9 + 80e9),
  nu: (3 * 173.3e9 - 2 * 80e9) / (2 * (3 * 173.3e9 + 80e9)),
  hardening: 'johnson-cook',
  jcA: 792 * MPa,
  jcB: 510 * MPa,
  jcN: 0.26,
  jcC: 0.014,
  jcM: 1.03,
  epsDot0: 1,
  swK: 1200 * MPa,
  swE0: 0.01,
  swN: 0.1,
  tRoom: 294,
  tMelt: 1793,
};

/** Cold-rolling grade low-carbon steel (representative Swift fit). */
export const STEEL_SPCC: MaterialParams = {
  name: '低炭素鋼 SPCC',
  rho: 7870,
  E: 206e9,
  nu: 0.3,
  hardening: 'swift',
  jcA: 200 * MPa,
  jcB: 380 * MPa,
  jcN: 0.36,
  jcC: 0.02,
  jcM: 1,
  epsDot0: 1,
  swK: 560 * MPa,
  swE0: 0.01,
  swN: 0.22,
  tRoom: 294,
  tMelt: 1800,
};

/** Aluminium 6061-T6 (representative Johnson-Cook constants). */
export const AL_6061: MaterialParams = {
  name: 'アルミ合金 6061-T6',
  rho: 2700,
  E: 69e9,
  nu: 0.33,
  hardening: 'johnson-cook',
  jcA: 324 * MPa,
  jcB: 114 * MPa,
  jcN: 0.42,
  jcC: 0.002,
  jcM: 1.34,
  epsDot0: 1,
  swK: 410 * MPa,
  swE0: 0.005,
  swN: 0.08,
  tRoom: 294,
  tMelt: 925,
};

export const MATERIALS: Record<string, MaterialParams> = {
  spcc: STEEL_SPCC,
  s4340: STEEL_4340,
  al6061: AL_6061,
};

/** Johnson-Cook damage constants of 4340 steel (Banerjee 2012, from Johnson & Cook 1985). */
export const DAMAGE_4340: DamageParams = {
  model: 'johnson-cook',
  D1: 0.05,
  D2: 3.44,
  D3: -2.12,
  D4: 0.002,
  D5: 0.61,
  clCrit: 0.6,
  etaCutoff: -1 / 3,
  failure: 'tension-cut',
};

export function defaultParams(): SimParams {
  return {
    rolling: {
      h0: 1.0 * mm,
      reduction: 0.25,
      rollRadius: 100 * mm,
      sheetLength: 16 * mm,
      rollSpeed: 1.0,
      millSpeed: 10,
      mu: 0.08,
      backTension: 0,
      frontTension: 0,
    },
    material: { ...STEEL_SPCC },
    damage: { ...DAMAGE_4340 },
    numerics: {
      cellsThrough: 10,
      ppc: 2,
      massScale: 1e4,
      cfl: 0.4,
      jbar: true,
    },
    defects: [],
  };
}

export function cloneParams(p: SimParams): SimParams {
  return {
    rolling: { ...p.rolling },
    material: { ...p.material },
    damage: { ...p.damage },
    numerics: { ...p.numerics },
    defects: p.defects.map((d) => ({ ...d })),
  };
}

/** Derived geometry of the roll bite (rigid rolls). */
export function biteGeometry(r: RollingParams) {
  const gap = r.h0 * (1 - r.reduction);
  const dh = r.h0 - gap;
  const contactLength = Math.sqrt(r.rollRadius * dh - (dh * dh) / 4);
  const biteAngle = Math.asin(Math.min(1, contactLength / r.rollRadius));
  return { gap, dh, contactLength, biteAngle };
}

/** The rolls can bite: each roll takes off less than its radius (otherwise the contact arc is not defined). */
export function hasBite(r: RollingParams): boolean {
  const dh = r.h0 * r.reduction;
  return dh > 0 && dh < 2 * r.rollRadius;
}
