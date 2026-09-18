// URL parameters that set up a run without touching the UI (for measurements
// and headless checks). Lengths in mm, tensions in MPa. Invalid values are ignored.
//   ?preset=<id>&h0=1&r=25&R=100&L=16&mu=0.08&tb=0&tf=0&mat=spcc&damage=johnson-cook
//   &cells=10&ms=10000&field=eta&autorun=1&stopafter=<steps>
import { MATERIALS, cloneParams, type DamageModel, type SimParams } from '../mpm/params.ts';

const DAMAGE: DamageModel[] = ['johnson-cook', 'hancock-mackenzie', 'cockcroft-latham', 'none'];

export function applyQuery(base: SimParams, q: URLSearchParams): SimParams {
  const p = cloneParams(base);
  const num = (k: string, set: (v: number) => void, lo: number, hi: number) => {
    const s = q.get(k);
    if (s === null) return;
    const v = parseFloat(s);
    if (Number.isFinite(v) && v >= lo && v <= hi) set(v);
  };
  num('h0', (v) => (p.rolling.h0 = v * 1e-3), 0.05, 50);
  num('r', (v) => (p.rolling.reduction = v / 100), 0.5, 70);
  num('R', (v) => (p.rolling.rollRadius = v * 1e-3), 5, 2000);
  num('L', (v) => (p.rolling.sheetLength = v * 1e-3), 1, 500);
  num('mu', (v) => (p.rolling.mu = v), 0, 1);
  num('tb', (v) => (p.rolling.backTension = v * 1e6), 0, 5000);
  num('tf', (v) => (p.rolling.frontTension = v * 1e6), 0, 5000);
  num('cells', (v) => (p.numerics.cellsThrough = Math.round(v)), 2, 80);
  num('ms', (v) => (p.numerics.massScale = v), 1, 1e8);
  const mat = q.get('mat');
  if (mat && MATERIALS[mat]) p.material = { ...MATERIALS[mat] };
  const dm = q.get('damage') as DamageModel | null;
  if (dm && DAMAGE.includes(dm)) p.damage.model = dm;
  return p;
}
