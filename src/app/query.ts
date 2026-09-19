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
import { MAX_STANDS } from './tandemStub.ts';

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
      const c: unknown = JSON.parse(fromBase64Url(cond));
      merge(p as unknown as Obj, c, '');
      if (isObj(c) && Array.isArray(c.defects)) p.defects = c.defects.slice(0, MAX_DEFECTS).filter((d) => isDefect(d, p));
    } catch {
      // not ours: ignored like any invalid value
    }
    if (!hasBite(p.rolling)) p.rolling = rolling;
  }
  // a URL must not start a run too big for the page (whoever opens a shared link)
  if (points(p) > MAX_POINTS) {
    p.rolling = { ...base.rolling };
    p.numerics = { ...base.numerics };
    p.defects = base.defects.map((d) => ({ ...d }));
  }
  return p;
}

/**
 * Most material points a URL may ask for: what the URL keys allow at the default length
 * (80 cells through 16 mm is 409 600; the default is 6 400), not combinations far beyond
 * (80 cells through 500 mm of a 0.05 mm sheet would be 1.3e8).
 */
export const MAX_POINTS = 500_000;
const MAX_DEFECTS = 20;

/** Material points of a sheet on the lattice (spacing h0 / (cells × ppc)). */
export function points(p: SimParams): number {
  const n = p.numerics.cellsThrough * p.numerics.ppc;
  return (p.rolling.sheetLength / p.rolling.h0) * n * n;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a `cond` may set, leaf by leaf (SI units): a range, a range of integers, a list of
 * choices, a flag or a short text. A leaf not listed here is ignored, and so is a value
 * outside its rule. The ranges are the URL's (LIMITS) and the panel's, and physical bounds
 * for the rest.
 */
type Rule = { range: [number, number]; int?: boolean } | { oneOf: readonly string[] } | 'flag' | 'text';
const r = (lo: number, hi: number, int = false): Rule => ({ range: [lo, hi], int });
const RULES: Record<string, Rule> = {
  'rolling.h0': r(0.05e-3, 50e-3),
  'rolling.reduction': r(0.005, 0.7),
  'rolling.rollRadius': r(5e-3, 2),
  'rolling.sheetLength': r(1e-3, 0.5),
  'rolling.rollSpeed': r(0.05, 20),
  'rolling.millSpeed': r(0.1, 60),
  'rolling.mu': r(0, 1),
  'rolling.backTension': r(0, 5e9),
  'rolling.frontTension': r(0, 5e9),
  'rolling.tensionRamp': r(0, 1),
  'material.name': 'text',
  'material.rho': r(100, 30000),
  'material.E': r(1e9, 1e12),
  'material.nu': r(0, 0.499),
  'material.hardening': { oneOf: ['johnson-cook', 'swift'] },
  'material.jcA': r(0, 3e9),
  'material.jcB': r(0, 3e9),
  'material.jcN': r(0, 1.5),
  'material.jcC': r(0, 0.2),
  'material.jcM': r(0.1, 5),
  'material.epsDot0': r(1e-6, 1e6),
  'material.swK': r(1e6, 5e9),
  'material.swE0': r(1e-4, 0.5),
  'material.swN': r(0, 1),
  'material.tRoom': r(0, 2000),
  'material.tMelt': r(300, 5000),
  'material.cp': r(100, 5000),
  'material.chi': r(0, 1),
  'damage.model': { oneOf: DAMAGE },
  'damage.yield': { oneOf: YIELD },
  'damage.failure': { oneOf: ['erode', 'tension-cut'] },
  'damage.D1': r(-5, 5),
  'damage.D2': r(-5, 10),
  'damage.D3': r(-5, 5),
  'damage.D4': r(-1, 1),
  'damage.D5': r(-5, 5),
  'damage.clCrit': r(0.01, 5),
  'damage.etaCutoff': r(-2, 0),
  'damage.nonlocalLength': r(0, 5e-3),
  'damage.gtn.q1': r(0, 5),
  'damage.gtn.q2': r(0, 5),
  'damage.gtn.q3': r(0, 25),
  'damage.gtn.k': r(1, 20),
  'damage.gtn.fc': r(0.001, 0.5),
  'damage.gtn.fn': r(0, 1),
  'damage.gtn.en': r(0, 2),
  'damage.gtn.sn': r(1e-3, 2),
  'damage.gtn.f0': r(0, 0.2),
  'damage.gtn.nucleation': { oneOf: NUCLEATION },
  'numerics.cellsThrough': r(2, 80, true),
  'numerics.ppc': r(1, 4, true),
  'numerics.massScale': r(1, 1e8),
  'numerics.cfl': r(0.05, 1),
  'numerics.jbar': 'flag',
  'numerics.volumetric': { oneOf: ['rate', 'total'] },
  'numerics.volRelax': r(0, 10),
  'numerics.volRelaxContact': r(0, 10),
  'numerics.contact': { oneOf: ['surface', 'stencil'] },
};

function allowed(rule: Rule, v: unknown): boolean {
  if (rule === 'flag') return typeof v === 'boolean';
  if (rule === 'text') return typeof v === 'string' && v.length <= 80;
  if ('oneOf' in rule) return typeof v === 'string' && rule.oneOf.includes(v);
  return typeof v === 'number' && Number.isFinite(v) && v >= rule.range[0] && v <= rule.range[1] && (!rule.int || Number.isInteger(v));
}

/** Put the leaves of `src` into `dst` where RULES allows them (defects are handled apart). */
function merge(dst: Obj, src: unknown, path: string): void {
  if (!isObj(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype' || (!path && k === 'defects')) continue;
    const full = path ? `${path}.${k}` : k;
    const t = Object.prototype.hasOwnProperty.call(dst, k) ? dst[k] : undefined;
    if (isObj(t)) merge(t, v, full);
    else if (RULES[full] && allowed(RULES[full], v)) dst[k] = v;
  }
}

/** A defect of the right kind, inside the sheet of p, with positive sizes. */
function isDefect(d: unknown, p: SimParams): d is Defect {
  if (!isObj(d) || (d.kind !== 'void' && d.kind !== 'weak')) return false;
  const L = p.rolling.sheetLength;
  const h = p.rolling.h0;
  const within = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  return (
    within(d.x, 0, L) &&
    within(d.y, -h / 2, h / 2) &&
    within(d.ax, 1e-6, L) &&
    within(d.ay, 1e-6, h) &&
    (d.ductility === undefined || within(d.ductility, 1e-3, 1))
  );
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

/** ?stands=<N>: the stands of a tandem, 1 to MAX_STANDS (anything else: 1). */
export function standsOf(q: URLSearchParams): number {
  const v = parseFloat(q.get('stands') ?? '');
  return Number.isInteger(v) && v >= 1 && v <= MAX_STANDS ? v : 1;
}

/** ?stopafter=<steps> (exponent notation allowed), or null. */
export function stopAfterOf(q: URLSearchParams): number | null {
  const v = Number(q.get('stopafter') ?? NaN);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : null;
}
