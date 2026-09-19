// The plan view's width settings in the URL and the panel: their ranges, the points they make
// together (a shared link must not start a computation too large for the page that opens it, as
// applyQuery's MAX_POINTS does for the section model), and the notch against the width.
import { PLAN_DEFAULTS, type PlanSettings } from '../mpm/planview/condition.ts';
import { MAX_POINTS } from './query.ts';

const mm = 1e-3;

/** the width settings: panel field, URL key, range (in the panel's units) */
export const PLAN_SETTINGS: { key: keyof PlanSettings; query: string; label: string; unit: string; step: number; min: number; max: number; scale: number; hint?: string }[] = [
  { key: 'width', query: 'W', label: '板幅', unit: 'mm', step: 1, min: 2, max: 200, scale: mm },
  { key: 'cells', query: 'wcells', label: '板幅方向のセル数（半幅）', unit: '', step: 1, min: 4, max: 100, scale: 1, hint: '多いほど細かいが遅い（10 セル・板長 28 mm で 1 回 6 秒ほど）' },
  { key: 'notch', query: 'notch', label: '端の切り欠き（半径）', unit: 'mm', step: 0.1, min: 0, max: 5, scale: mm, hint: '板の長さの中ほどの端に半円の切り欠き。0 で無し。板幅の 1/4 まで' },
];

/** Material points of a plan-view strip: (L / dp) × (W/2 / dp), dp = (W/2) / (cells × ppc). */
export function planPoints(s: PlanSettings, sheetLength: number, ppc: number): number {
  const dp = s.width / 2 / (s.cells * ppc);
  return (sheetLength / dp) * (s.width / 2 / dp);
}

/** the largest notch radius for a width: a quarter of it (a deeper one cuts the strip through) */
export const maxNotch = (width: number) => width / 4;

/**
 * The settings that run: too many points together (with this sheet length) → width and cells back
 * to the defaults; a notch deeper than a quarter of the width → no notch.
 */
export function checkedSettings(s: PlanSettings, sheetLength: number, ppc: number): PlanSettings {
  const out = { ...s };
  if (planPoints(out, sheetLength, ppc) > MAX_POINTS) {
    out.width = PLAN_DEFAULTS.width;
    out.cells = PLAN_DEFAULTS.cells;
  }
  if (out.notch > maxNotch(out.width)) out.notch = 0;
  return out;
}

/** The width settings a URL asks for (out-of-range or malformed values are ignored), checked together. */
export function planSettingsOf(q: URLSearchParams, sheetLength: number, ppc: number): PlanSettings {
  const s: PlanSettings = { ...PLAN_DEFAULTS };
  for (const f of PLAN_SETTINGS) {
    const raw = q.get(f.query);
    if (raw === null) continue;
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v < f.min || v > f.max) continue;
    s[f.key] = f.key === 'cells' ? Math.round(v) : v * f.scale;
  }
  return checkedSettings(s, sheetLength, ppc);
}

/** The URL keys of settings that differ from the defaults (in the panel's units). */
export function planSettingsQuery(s: PlanSettings): [string, string][] {
  const out: [string, string][] = [];
  for (const f of PLAN_SETTINGS) if (s[f.key] !== PLAN_DEFAULTS[f.key]) out.push([f.query, String(+(s[f.key] / f.scale).toPrecision(12))]);
  return out;
}
