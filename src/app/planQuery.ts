// The plan view's width settings in the URL and the panel: their ranges, the points they make
// together (a shared link must not start a computation too large for the page that opens it, as
// applyQuery's MAX_POINTS does for the section model), and the notch against the width.
import { PLAN_DEFAULTS, type PlanSettings } from '../mpm/planview/condition.ts';
import { MAX_POINTS } from './query.ts';

const mm = 1e-3;

/**
 * The plan view's own settings: panel field, URL key, range (in the panel's units). `group` is the
 * fieldset the panel puts it in; `int` rounds what the URL and the panel give.
 */
export const PLAN_SETTINGS: {
  key: keyof PlanSettings;
  query: string;
  label: string;
  unit: string;
  step: number;
  min: number;
  max: number;
  scale: number;
  group: 'width' | 'edge';
  int?: true;
  hint?: string;
}[] = [
  { key: 'width', query: 'W', label: '板幅', unit: 'mm', step: 1, min: 2, max: 200, scale: mm, group: 'width' },
  { key: 'cells', query: 'wcells', label: '板幅方向のセル数（半幅）', unit: '', step: 1, min: 4, max: 100, scale: 1, group: 'width', int: true, hint: '多いほど細かいが遅い（10 セル・板長 28 mm で 1 回 5 秒ほど）' },
  { key: 'notch', query: 'notch', label: '端の切り欠き（半径）', unit: 'mm', step: 0.1, min: 0, max: 5, scale: mm, group: 'width', hint: '板の長さの中ほどの端に半円の切り欠き。0 で無し。板幅の 1/4 まで' },
  { key: 'edgeAmount', query: 'escatter', label: 'ばらつきの大きさ', unit: '%', step: 1, min: 0, max: 50, scale: 0.01, group: 'edge', hint: '端の帯の延性を 1 −（この割合まで）倍する。0 で無し（既定）' },
  { key: 'edgeWidth', query: 'ewidth', label: 'ばらつく帯の幅（端から）', unit: 'mm', step: 0.1, min: 0.1, max: 10, scale: mm, group: 'edge', hint: '割れはこの帯より深くは入らない。半幅まで' },
  { key: 'edgeLength', query: 'elen', label: '相関長（圧延方向）', unit: 'mm', step: 0.1, min: 0, max: 10, scale: mm, group: 'edge', hint: '同じ値が続く長さ。0 だと点ごとに引き、割れの間隔が格子で決まる' },
  { key: 'edgeSeed', query: 'eseed', label: '種', unit: '', step: 1, min: 1, max: 999999, scale: 1, group: 'edge', int: true, hint: '同じ種は同じ板。種を変えると割れの場所と本数が変わる' },
];

/** Material points of a plan-view strip: (L / dp) × (W/2 / dp), dp = (W/2) / (cells × ppc). */
export function planPoints(s: PlanSettings, sheetLength: number, ppc: number): number {
  const dp = s.width / 2 / (s.cells * ppc);
  return (sheetLength / dp) * (s.width / 2 / dp);
}

/** the largest notch radius for a width: a quarter of it (a deeper one cuts the strip through) */
export const maxNotch = (width: number) => width / 4;

/** the widest scattered band for a width: the half width (wider would be the whole strip, not an edge) */
export const maxEdgeWidth = (width: number) => width / 2;

/**
 * The settings that run: too many points together (with this sheet length) → width and cells back
 * to the defaults; a notch deeper than a quarter of the width → no notch; a scattered band wider
 * than the half width → the half width.
 */
export function checkedSettings(s: PlanSettings, sheetLength: number, ppc: number): PlanSettings {
  const out = { ...s };
  if (planPoints(out, sheetLength, ppc) > MAX_POINTS) {
    out.width = PLAN_DEFAULTS.width;
    out.cells = PLAN_DEFAULTS.cells;
  }
  if (out.notch > maxNotch(out.width)) out.notch = 0;
  if (out.edgeWidth > maxEdgeWidth(out.width)) out.edgeWidth = maxEdgeWidth(out.width);
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
    s[f.key] = f.int ? Math.round(v) : v * f.scale;
  }
  return checkedSettings(s, sheetLength, ppc);
}

/**
 * The URL keys of settings that differ from the defaults (in the panel's units). Without scatter
 * (amount 0) its band, correlation length and seed change nothing, so they stay out of the URL.
 */
export function planSettingsQuery(s: PlanSettings): [string, string][] {
  const out: [string, string][] = [];
  for (const f of PLAN_SETTINGS) {
    if (f.group === 'edge' && f.key !== 'edgeAmount' && s.edgeAmount === 0) continue;
    if (s[f.key] !== PLAN_DEFAULTS[f.key]) out.push([f.query, String(+(s[f.key] / f.scale).toPrecision(12))]);
  }
  return out;
}
