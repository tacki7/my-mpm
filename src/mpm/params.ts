// Input of one rolling simulation. SI units throughout (m, kg, s, Pa, K);
// the UI converts to mm / MPa for display.

export type HardeningModel = 'johnson-cook' | 'swift';

/**
 * Which damage indicator decides failure. All of them are always accumulated for display.
 * 'gtn': the porosity reaches the critical porosity fc (it evolves only with the GTN yield condition).
 * 'localization': the acoustic tensor of the J2 tangent turns singular (a shear band can form;
 * needs H ≤ 0, so a hardening material never fails by it).
 */
export type DamageModel = 'johnson-cook' | 'hancock-mackenzie' | 'cockcroft-latham' | 'gtn' | 'localization' | 'none';

/** Yield condition: pressure-independent von Mises (J2), or Gurson-Tvergaard-Needleman with porosity. */
export type YieldModel = 'von-mises' | 'gtn';

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
  /** specific heat [J/(kg·K)] */
  cp: number;
  /**
   * Taylor-Quinney coefficient: the share of the plastic work that heats the point (adiabatic,
   * no conduction; Banerjee 2012 uses 0.9). 0: the temperature stays at tRoom
   */
  chi: number;
}

/**
 * Gurson-Tvergaard-Needleman yield condition and porosity evolution (Banerjee 2012, eqs. 13–17):
 * Φ = (σeq/σf)² + 2 q1 f* cosh(q2 tr σ / (2σf)) − (1 + q3 f*²),
 * f* = f up to fc and fc + k (f − fc) beyond, ḟ = (1 − f) tr Dp + A(εM) ε̇M with
 * A = fn / (sn √(2π)) exp(−½ ((εM − εn)/sn)²) (strain-controlled nucleation, Chu & Needleman 1980).
 */
export interface GtnParams {
  q1: number;
  q2: number;
  q3: number;
  k: number;
  fc: number; // critical porosity
  fn: number; // volume fraction of void-nucleating particles
  en: number; // mean nucleation strain
  sn: number; // its standard deviation
  f0: number; // initial porosity
  /**
   * 'tension': voids nucleate only while the mean stress is tensile (the default: rolling is mostly
   * compression, where decohesion does not open voids); 'always': the paper's law, whatever the stress
   */
  nucleation: 'always' | 'tension';
}

export interface DamageParams {
  model: DamageModel;
  yield: YieldModel;
  gtn: GtnParams;
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
  /**
   * Nonlocal damage: the increments of the three indicators are averaged over this length [m]
   * before they add up (through the grid, like J-bar; 0 = local, per point)
   */
  nonlocalLength: number;
}

export interface RollingParams {
  h0: number; // entry thickness [m]
  reduction: number; // (h0 − gap)/h0, rigid rolls
  rollRadius: number; // [m]
  sheetLength: number; // [m]
  /**
   * 'steady': the first stand's sheet is as long as the stand needs to get to the steady state with its readings
   * (src/mpm/tandem.ts steadyLength, withSteadyLength: longer with rolls that follow the pass), and sheetLength is
   * replaced by that. 'fixed' or absent: sheetLength as given
   */
  lengthMode?: 'fixed' | 'steady';
  rollSpeed: number; // simulated roll surface speed [m/s]
  /** real mill speed [m/s]; strain rates are scaled by millSpeed/rollSpeed before entering rate-dependent laws */
  millSpeed: number;
  mu: number; // Coulomb friction coefficient roll/sheet
  /** [Pa] on the tail end (a stress on its current cross-section); released once the tail reaches the roll bite */
  backTension: number;
  /** [Pa] on the head end (a stress on its current cross-section), from when the head passes the exit probe */
  frontTension: number;
  /** ramp time of both tensions [s]; 0 or absent: ten passes of the elastic wave along the sheet */
  tensionRamp?: number;
  /**
   * Elastic flattening of the rolls (docs/model.md「ロール偏平と圧下率一定」). 'hitchcock': the rolls' radius in the
   * contact follows the computed roll force P [N/m], R' = R (1 + C P / Δh), C = 16 (1 − ν²) / (π E) with the
   * rolls' E and ν, Δh = h0 − gap (Hitchcock), solved together with the pass while it runs. 'none' or absent: rigid rolls
   */
  flattening?: 'none' | 'hitchcock';
  /** the rolls' Young's modulus [Pa] (absent: ROLL_E, steel) and Poisson's ratio (absent: ROLL_NU) for the flattening */
  rollE?: number;
  rollNu?: number;
  /**
   * What `reduction` sets. 'gap' or absent: the roll gap, h0 (1 − r); the sheet comes out a little thicker (its
   * elastic recovery). 'reduction': the sheet that comes out, (h0 − h_exit) / h0 = r: the gap is adjusted while
   * the pass runs until the thickness measured just past the rolls is h0 (1 − r)
   */
  gapControl?: 'gap' | 'reduction';
  /** mean equivalent plastic strain the sheet brings in (a tandem's later stands; remap sets it): only where rolls
   *  that follow the pass start from (Sim presetRolls). Default 0 */
  entryStrain?: number;
  /** stands of a tandem, each rolling the one before's exit strip by the same reduction (1 or absent: one stand). Sim does not read it */
  stands?: number;
  /**
   * When a tandem's stand hands its sheet on (src/mpm/tandem.ts): 'done' (or absent) once the whole sheet is
   * rolled, 'steady' as soon as it rolls steadily, the next stand's sheet made of the steady stretch. Sim does not read it
   */
  handoff?: 'done' | 'steady';
}

/**
 * What the anti-locking scheme smooths over the grid (with `jbar` on).
 * - 'rate': the volumetric rate tr L of each step. The state is not re-smoothed, so the pressure
 *   is not diffused along the flow; the part of the elastic volume the grid cannot resolve relaxes
 *   toward its grid mean in proportion to the plastic strain (`volRelax`)
 * - 'total': the total volume ratio J, replaced by its grid mean every step. Diffuses the pressure
 *   with D ≈ h²/(4 Δt) (over ~15 mm in one pass of a 10 mm plate at 16 cells)
 */
export type VolumetricScheme = 'rate' | 'total';

/**
 * Which grid nodes the roll contact constrains, once a particle's edge is inside a roll:
 * - 'surface': the nodes on the roll side of the particle and those within h/2 beyond it along the
 *   roll normal (its nearest row). A point that would still move into the roll asks the normal
 *   velocity it lacks of those nodes, so it follows the roll surface (docs/model.md「接触」)
 * - 'stencil': every node of the particle's 3 × 3 stencil: 3 node rows along each surface, a band
 *   about 1.5 cells deep held to the roll (the contact before; it stiffens the sheet)
 */
export type ContactScheme = 'surface' | 'stencil';

export interface NumericsParams {
  cellsThrough: number; // grid cells through the entry thickness
  ppc: number; // particles per cell per direction
  massScale: number; // density multiplier for the explicit time step (quasi-static assumption)
  cfl: number;
  /** smooth the volume change over the grid (J-bar) to avoid volumetric locking of isochoric plastic flow */
  jbar: boolean;
  /** what is smoothed (default 'rate') */
  volumetric?: VolumetricScheme;
  /**
   * 'rate': relaxation of the unresolved elastic volume per plastic strain increment, as a multiple
   * of 3K/σeq (pressure-projection stabilisation with the plastic secant viscosity σeq/(3 ε̇p)). Default 1
   */
  volRelax?: number;
  /**
   * 'rate': the same within two cells of a roll surface. Default 1. With the 'stencil' contact, which
   * holds a ~1.5-cell band to the roll so that the discrete flow cannot stay isochoric there, 5 made
   * up for the band (and 1 locks: 5.05 kN/mm on the standard pass at 6 cells)
   */
  volRelaxContact?: number;
  /** which nodes the roll contact constrains */
  contact: ContactScheme;
  /**
   * The faces of a crack (docs/model.md「亀裂の面」). 'dfg' (the default since T74): near a crack the points
   * split, node by node, into two velocity fields by the side of the crack they are on (the gradient of the failed points' field, Homel & Herbold 2017); the
   * fields meet by frictionless contact: they do not go through each other and are free to separate.
   * 'none': one velocity field, the two sides of a crack share the nodes around it (what an omitted field means too)
   */
  crackFields?: 'none' | 'dfg';
  /**
   * 'dfg': how a point is put on a node's side of the crack. 'gradient' (Homel & Herbold): its own interpolated
   * gradient of φ against the node's; 'centroid': which side of the failed points around the node it lies on
   * (along the node's gradient). Default 'centroid' (docs/model.md「亀裂の面」)
   */
  crackSide?: 'gradient' | 'centroid';
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
  cp: 455, // the paper's Cp(T) of 4340 (Goto et al. 2000) at room temperature
  chi: 0,
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
  cp: 460,
  chi: 0,
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
  cp: 896,
  chi: 0,
};

export const MATERIALS: Record<string, MaterialParams> = {
  spcc: STEEL_SPCC,
  s4340: STEEL_4340,
  al6061: AL_6061,
};

/**
 * GTN constants of 4340 steel (Banerjee 2012, Table 1; initial porosity: the mean they assign).
 * Nucleation is restricted to tension here, unlike the paper (docs/model.md).
 */
export const GTN_4340: GtnParams = {
  q1: 1.5,
  q2: 1.0,
  q3: 2.25,
  k: 4.0,
  fc: 0.05,
  fn: 0.1,
  en: 0.1,
  sn: 0.3,
  f0: 0.005,
  nucleation: 'tension',
};

/** Johnson-Cook damage constants of 4340 steel (Banerjee 2012, from Johnson & Cook 1985). */
export const DAMAGE_4340: DamageParams = {
  model: 'johnson-cook',
  yield: 'von-mises',
  gtn: GTN_4340,
  D1: 0.05,
  D2: 3.44,
  D3: -2.12,
  D4: 0.002,
  D5: 0.61,
  clCrit: 0.6,
  etaCutoff: -1 / 3,
  failure: 'tension-cut',
  nonlocalLength: 0,
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
    damage: { ...DAMAGE_4340, gtn: { ...GTN_4340 } },
    numerics: {
      cellsThrough: 10,
      ppc: 2,
      massScale: 1e4,
      cfl: 0.4,
      jbar: true,
      volumetric: 'rate',
      volRelax: 1,
      volRelaxContact: 1,
      crackFields: 'dfg',
      contact: 'surface',
    },
    defects: [],
  };
}

export function cloneParams(p: SimParams): SimParams {
  return {
    rolling: { ...p.rolling },
    material: { ...p.material },
    damage: { ...p.damage, gtn: { ...p.damage.gtn } },
    numerics: { ...p.numerics },
    defects: p.defects.map((d) => ({ ...d })),
  };
}

/** steel rolls, for the flattening */
export const ROLL_E = 206e9;
export const ROLL_NU = 0.3;

/** Hitchcock's constant C = 16 (1 − ν²) / (π E) of the rolls [1/Pa] (steel: 2.25e-11) */
export function hitchcockC(r: RollingParams): number {
  const nu = r.rollNu ?? ROLL_NU;
  return (16 * (1 - nu * nu)) / (Math.PI * (r.rollE ?? ROLL_E));
}

/** Hitchcock's flattened roll radius under the roll force P [N/m] with the draft dh [m] */
export function hitchcockRadius(r: RollingParams, force: number, dh: number): number {
  return r.rollRadius * (1 + (hitchcockC(r) * Math.max(0, force)) / dh);
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
