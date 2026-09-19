// URL parameters that set up a run without touching the UI (for measurements
// and headless checks). Lengths in mm, tensions in MPa. Invalid values are ignored,
// and so are h0, r and R together when the rolls could not bite with them.
//   ?preset=<id>&h0=1&r=25&R=100&L=16&mu=0.08&tb=0&tf=0&mat=spcc&damage=johnson-cook
//   &yield=gtn&f0=0.005&fc=0.05&nucleation=tension
//   &cells=10&ms=10000&field=eta&autorun=1&stopafter=<steps>
//   &cond=<base64url JSON>: every other condition, as the leaves that differ from the
//   preset (conditionsQuery writes it, so a shared URL starts exactly the same run)
import {
  MATERIALS,
  cloneParams,
  hasBite,
  type DamageModel,
  type Defect,
  type GtnParams,
  type SimParams,
  type YieldModel,
} from '../mpm/params.ts';

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
  const cond = q.get('cond');
  if (cond) {
    const rolling = { ...p.rolling };
    try {
      merge(p as unknown as Obj, JSON.parse(fromBase64Url(cond)));
    } catch {
      // not ours: ignored like any invalid value
    }
    if (!hasBite(p.rolling)) p.rolling = rolling;
  }
  return p;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Put the leaves of `src` into `dst`: only keys `dst` already has (and the optional tension
 * ramp), with the same type, finite numbers; the defect list is checked defect by defect.
 */
function merge(dst: Obj, src: unknown): void {
  if (!isObj(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k === 'defects') {
      if (Array.isArray(v) && Array.isArray(dst.defects)) dst.defects = v.filter(isDefect).map((d) => ({ ...d }));
      continue;
    }
    if (!(k in dst)) {
      if (k === 'tensionRamp' && typeof v === 'number' && Number.isFinite(v) && v >= 0) dst[k] = v;
      continue;
    }
    const t = dst[k];
    if (isObj(t)) merge(t, v);
    else if (typeof t === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) dst[k] = v;
    } else if (typeof t === typeof v) dst[k] = v;
  }
}

function isDefect(d: unknown): d is Defect {
  if (!isObj(d) || (d.kind !== 'void' && d.kind !== 'weak')) return false;
  const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!fin(d.x) || !fin(d.y) || !fin(d.ax) || !fin(d.ay) || (d.ax as number) <= 0 || (d.ay as number) <= 0) return false;
  return d.ductility === undefined || (fin(d.ductility) && (d.ductility as number) > 0);
}

/** The leaves of `b` that differ from `a` (whole arrays), or undefined when none do. */
function diff(a: unknown, b: unknown): unknown {
  if (isObj(a) && isObj(b)) {
    const out: Obj = {};
    for (const k of Object.keys(b)) {
      const d = diff(a[k], b[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? undefined : b;
  return a === b ? undefined : b;
}

function toBase64Url(s: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * The query that starts these conditions again: the preset, the readable keys where they differ
 * from it, and `cond` for everything else (including what the mm / % / MPa round trip would
 * change in the last bit). applyQuery(preset, conditionsQuery(…)) equals `params` exactly.
 */
export function conditionsQuery(presetId: string, preset: SimParams, params: SimParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set('preset', presetId);
  const r = params.rolling;
  const b = preset.rolling;
  const put = (k: string, v: number, was: number) => {
    if (v !== was) q.set(k, String(+v.toPrecision(12)));
  };
  put('h0', r.h0 * 1e3, b.h0 * 1e3);
  put('r', r.reduction * 100, b.reduction * 100);
  put('R', r.rollRadius * 1e3, b.rollRadius * 1e3);
  put('L', r.sheetLength * 1e3, b.sheetLength * 1e3);
  put('mu', r.mu, b.mu);
  put('tb', r.backTension * 1e-6, b.backTension * 1e-6);
  put('tf', r.frontTension * 1e-6, b.frontTension * 1e-6);
  put('cells', params.numerics.cellsThrough, preset.numerics.cellsThrough);
  put('ms', params.numerics.massScale, preset.numerics.massScale);
  const mat = Object.entries(MATERIALS).find(([, m]) => m.name === params.material.name)?.[0];
  if (mat && params.material.name !== preset.material.name) q.set('mat', mat);
  if (params.damage.model !== preset.damage.model) q.set('damage', params.damage.model);
  if (params.damage.yield !== preset.damage.yield) q.set('yield', params.damage.yield);
  const rest = diff(applyQuery(preset, q), params);
  if (rest !== undefined) q.set('cond', toBase64Url(JSON.stringify(rest)));
  return q;
}

/** ?stopafter=<steps> (exponent notation allowed), or null. */
export function stopAfterOf(q: URLSearchParams): number | null {
  const v = Number(q.get('stopafter') ?? NaN);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : null;
}
