// URL parameters that set up a run without touching the UI (for measurements
// and headless checks). Lengths in mm, tensions in MPa. Invalid values are ignored,
// and so are h0, r and R together when the rolls could not bite with them.
//   ?preset=<id>&h0=1&r=25&R=100&L=16&mu=0.08&tb=0&tf=0&mat=spcc&damage=johnson-cook
//   &yield=gtn&f0=0.005&fc=0.05&nucleation=tension
//   &cells=10&ms=10000&field=eta&autorun=1&stopafter=<steps>
import { MATERIALS, cloneParams, hasBite, type DamageModel, type GtnParams, type SimParams, type YieldModel } from '../mpm/params.ts';

/** Accepted ranges in display units; the conditions panel uses the same ones. */
export const LIMITS: Record<string, [number, number]> = {
  h0: [0.05, 50],
  r: [0.5, 70],
  R: [5, 2000],
  L: [1, 500],
  mu: [0, 1],
  tb: [0, 5000],
  tf: [0, 5000],
  cells: [2, 80],
  ms: [1, 1e8],
  f0: [0, 0.2],
  fc: [0.001, 0.5],
};

const DAMAGE: DamageModel[] = ['johnson-cook', 'hancock-mackenzie', 'cockcroft-latham', 'gtn', 'localization', 'none'];
const YIELD: YieldModel[] = ['von-mises', 'gtn'];
const NUCLEATION: GtnParams['nucleation'][] = ['tension', 'always'];

export function applyQuery(base: SimParams, q: URLSearchParams): SimParams {
  const p = cloneParams(base);
  const num = (k: string, set: (v: number) => void) => {
    const s = q.get(k);
    if (s === null) return;
    const v = parseFloat(s);
    const [lo, hi] = LIMITS[k];
    if (Number.isFinite(v) && v >= lo && v <= hi) set(v);
  };
  num('h0', (v) => (p.rolling.h0 = v * 1e-3));
  num('r', (v) => (p.rolling.reduction = v / 100));
  num('R', (v) => (p.rolling.rollRadius = v * 1e-3));
  if (!hasBite(p.rolling)) {
    p.rolling.h0 = base.rolling.h0;
    p.rolling.reduction = base.rolling.reduction;
    p.rolling.rollRadius = base.rolling.rollRadius;
  }
  num('L', (v) => (p.rolling.sheetLength = v * 1e-3));
  num('mu', (v) => (p.rolling.mu = v));
  num('tb', (v) => (p.rolling.backTension = v * 1e6));
  num('tf', (v) => (p.rolling.frontTension = v * 1e6));
  num('cells', (v) => (p.numerics.cellsThrough = Math.round(v)));
  num('ms', (v) => (p.numerics.massScale = v));
  num('f0', (v) => (p.damage.gtn.f0 = v));
  num('fc', (v) => (p.damage.gtn.fc = v));
  const mat = q.get('mat');
  if (mat && MATERIALS[mat]) p.material = { ...MATERIALS[mat] };
  const dm = q.get('damage') as DamageModel | null;
  if (dm && DAMAGE.includes(dm)) p.damage.model = dm;
  const y = q.get('yield') as YieldModel | null;
  if (y && YIELD.includes(y)) p.damage.yield = y;
  const nu = q.get('nucleation') as GtnParams['nucleation'] | null;
  if (nu && NUCLEATION.includes(nu)) p.damage.gtn.nucleation = nu;
  return p;
}

/** ?stopafter=<steps> (exponent notation allowed), or null. */
export function stopAfterOf(q: URLSearchParams): number | null {
  const v = Number(q.get('stopafter') ?? NaN);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : null;
}
