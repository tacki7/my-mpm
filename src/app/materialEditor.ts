// The material constants of the conditions panel: the hardening law and its flow
// stress constants, with the flow stress curve σy(εp) drawn from them. Starts from the
// chosen material; once a value differs from it the material is marked カスタム.
import { flowStress } from '../mpm/material.ts';
import type { HardeningModel, MaterialParams } from '../mpm/params.ts';
import { drawChart } from './charts.ts';
import { checkRange } from './fieldCheck.ts';

interface Constant {
  key: keyof MaterialParams;
  label: string;
  unit: string;
  /** display value = SI value × scale */
  scale: number;
  step: number;
  range: [number, number];
  /** only with this hardening law (both when absent) */
  law?: HardeningModel;
  hint?: string;
}

const MPa = 1e-6;

const CONSTANTS: Constant[] = [
  { key: 'jcA', label: 'A（初期の降伏応力）', unit: 'MPa', scale: MPa, step: 1, range: [0, 3000], law: 'johnson-cook' },
  { key: 'jcB', label: 'B（加工硬化）', unit: 'MPa', scale: MPa, step: 1, range: [0, 3000], law: 'johnson-cook' },
  { key: 'jcN', label: 'n（加工硬化の指数）', unit: '', scale: 1, step: 0.01, range: [0, 1.5], law: 'johnson-cook' },
  { key: 'swK', label: 'K（強度係数）', unit: 'MPa', scale: MPa, step: 1, range: [1, 5000], law: 'swift' },
  { key: 'swE0', label: 'ε0（予ひずみ）', unit: '', scale: 1, step: 0.001, range: [0.0001, 0.5], law: 'swift' },
  { key: 'swN', label: 'n（加工硬化の指数）', unit: '', scale: 1, step: 0.01, range: [0, 1], law: 'swift' },
  { key: 'jcC', label: 'C（ひずみ速度の感度）', unit: '', scale: 1, step: 0.001, range: [0, 0.2], hint: 'σy に (1 + C ln ε̇*) を掛ける（どちらの則にも）' },
  { key: 'jcM', label: 'm（温度の指数）', unit: '', scale: 1, step: 0.01, range: [0.1, 5] },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface MaterialEditor {
  root: HTMLElement;
  /** put a material's constants in (a new material chosen, or the conditions shown) */
  load(m: MaterialParams): void;
  /** the constants typed, on a copy of m (clamped to their ranges) */
  read(m: MaterialParams): MaterialParams;
  /** set the catalogue entry to compare with (カスタム when the constants differ) */
  compareWith(m: MaterialParams | null): void;
}

export function buildMaterialEditor(onEdit: () => void): MaterialEditor {
  const root = el('details', 'group fold material-editor');
  const summary = el('summary', undefined, '材料の定数');
  const badge = el('span', 'custom-badge', 'カスタム');
  badge.hidden = true;
  summary.append(badge);
  root.append(summary);

  const lawRow = el('label', 'field');
  lawRow.append(el('span', 'field-label', '加工硬化の則'));
  const law = el('select');
  law.name = 'hardening';
  for (const [v, t] of [
    ['swift', 'Swift σy = K (ε0 + εp)ⁿ'],
    ['johnson-cook', 'Johnson-Cook σy = A + B εpⁿ'],
  ]) {
    const o = el('option', undefined, t);
    o.value = v;
    law.append(o);
  }
  lawRow.append(law);
  root.append(lawRow);

  const inputs = new Map<keyof MaterialParams, { input: HTMLInputElement; row: HTMLElement; c: Constant; check: () => void }>();
  for (const c of CONSTANTS) {
    const row = el('label', 'field');
    row.append(el('span', 'field-label', c.label));
    const box = el('span', 'field-input');
    const input = el('input');
    input.type = 'number';
    input.name = `mat-${String(c.key)}`;
    input.step = String(c.step);
    box.append(input);
    if (c.unit) box.append(el('span', 'unit', c.unit));
    row.append(box);
    if (c.hint) row.append(el('span', 'hint', c.hint));
    const check = checkRange(input, row, () => c.range, c.unit);
    inputs.set(c.key, { input, row, c, check });
    root.append(row);
  }

  const fig = el('figure', 'flow-curve');
  fig.append(el('figcaption', undefined, '流動応力 σy（基準のひずみ速度・室温）'));
  const canvas = el('canvas');
  fig.append(canvas);
  root.append(fig);

  let base: MaterialParams | null = null; // the one being edited (name, elastic constants…)
  let catalogue: MaterialParams | null = null;

  const current = (): MaterialParams | null => {
    if (!base) return null;
    const m: MaterialParams = { ...base, hardening: law.value as HardeningModel };
    for (const { input, c } of inputs.values()) {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) (m[c.key] as number) = Math.min(c.range[1], Math.max(c.range[0], v)) / c.scale;
    }
    return m;
  };

  const refresh = () => {
    for (const { row, c } of inputs.values()) row.hidden = !!c.law && c.law !== law.value;
    const m = current();
    if (!m) return;
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    badge.hidden =
      !catalogue ||
      (m.hardening === catalogue.hardening && CONSTANTS.every((c) => same(m[c.key] as number, catalogue![c.key] as number)));
    if (root.open) drawCurve(m);
  };

  const drawCurve = (m: MaterialParams) => {
    const ep = Array.from({ length: 51 }, (_, i) => i / 50);
    drawChart(canvas, {
      xLabel: '相当塑性ひずみ εp',
      yLabel: '[MPa]',
      series: [{ x: ep, y: ep.map((e) => flowStress(m, e, m.epsDot0, m.tRoom).sy * MPa), color: '#1d2a3a', label: 'σy' }],
      xRange: [0, 1],
    });
  };

  law.addEventListener('change', () => {
    refresh();
    onEdit();
  });
  for (const { input } of inputs.values())
    input.addEventListener('input', () => {
      refresh();
      onEdit();
    });
  root.addEventListener('toggle', refresh);

  return {
    root,
    load(m) {
      base = { ...m };
      law.value = m.hardening;
      for (const { input, c, check } of inputs.values()) {
        input.value = String(+((m[c.key] as number) * c.scale).toPrecision(6));
        check();
      }
      refresh();
    },
    read(m) {
      const cur = current();
      return cur ? { ...m, hardening: cur.hardening, ...Object.fromEntries(CONSTANTS.map((c) => [c.key, cur[c.key]])) } : { ...m };
    },
    compareWith(m) {
      catalogue = m ? { ...m } : null;
      refresh();
    },
  };
}
