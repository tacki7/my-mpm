// The conditions panel: numeric inputs bound to SimParams (shown in mm / MPa).
// The fields the URL can also set take their ranges from it (query.ts LIMITS).
import { MATERIALS, hasBite, type SimParams } from '../mpm/params.ts';
import { LIMITS } from './query.ts';

interface NumField {
  key: string;
  label: string;
  unit: string;
  step: number;
  min: number;
  max: number;
  get(p: SimParams): number;
  set(p: SimParams, v: number): void;
  /** short explanation shown under the label */
  hint?: string;
}

interface Group {
  title: string;
  fields: NumField[];
}

const mm = 1e-3;
const MPa = 1e6;

const RAW: Group[] = [
  {
    title: '板とロール',
    fields: [
      { key: 'h0', label: '入側板厚', unit: 'mm', step: 0.1, min: 0.1, max: 20, get: (p) => p.rolling.h0 / mm, set: (p, v) => (p.rolling.h0 = v * mm) },
      { key: 'r', label: '圧下率', unit: '%', step: 1, min: 1, max: 60, get: (p) => p.rolling.reduction * 100, set: (p, v) => (p.rolling.reduction = v / 100) },
      { key: 'R', label: 'ロール半径', unit: 'mm', step: 5, min: 5, max: 1000, get: (p) => p.rolling.rollRadius / mm, set: (p, v) => (p.rolling.rollRadius = v * mm) },
      { key: 'L', label: '板の長さ', unit: 'mm', step: 1, min: 2, max: 200, get: (p) => p.rolling.sheetLength / mm, set: (p, v) => (p.rolling.sheetLength = v * mm) },
    ],
  },
  {
    title: '潤滑と張力',
    fields: [
      { key: 'mu', label: '摩擦係数 μ', unit: '', step: 0.01, min: 0, max: 0.6, get: (p) => p.rolling.mu, set: (p, v) => (p.rolling.mu = v) },
      { key: 'tb', label: '後方張力', unit: 'MPa', step: 10, min: 0, max: 2000, get: (p) => p.rolling.backTension / MPa, set: (p, v) => (p.rolling.backTension = v * MPa) },
      { key: 'tf', label: '前方張力', unit: 'MPa', step: 10, min: 0, max: 2000, get: (p) => p.rolling.frontTension / MPa, set: (p, v) => (p.rolling.frontTension = v * MPa) },
    ],
  },
  {
    title: '破壊の基準（Johnson-Cook）',
    fields: [
      { key: 'D1', label: 'D1', unit: '', step: 0.01, min: -5, max: 5, get: (p) => p.damage.D1, set: (p, v) => (p.damage.D1 = v) },
      { key: 'D2', label: 'D2', unit: '', step: 0.05, min: -5, max: 10, get: (p) => p.damage.D2, set: (p, v) => (p.damage.D2 = v) },
      { key: 'D3', label: 'D3', unit: '', step: 0.05, min: -5, max: 5, get: (p) => p.damage.D3, set: (p, v) => (p.damage.D3 = v), hint: '負なら三軸度が高いほど破断ひずみが小さい' },
      { key: 'cl', label: 'Cockcroft-Latham 限界値', unit: '', step: 0.05, min: 0.01, max: 5, get: (p) => p.damage.clCrit, set: (p, v) => (p.damage.clCrit = v) },
      { key: 'cut', label: '損傷が進まない三軸度', unit: '', step: 0.05, min: -2, max: 0, get: (p) => p.damage.etaCutoff, set: (p, v) => (p.damage.etaCutoff = v), hint: 'これより圧縮側では損傷を積算しない（Bao-Wierzbicki は −1/3）' },
    ],
  },
  {
    title: '空孔（GTN）',
    fields: [
      { key: 'f0', label: '初期空孔率 f0', unit: '', step: 0.001, min: 0, max: 0.2, get: (p) => p.damage.gtn.f0, set: (p, v) => (p.damage.gtn.f0 = v), hint: '論文の鋼は 0.005。冷延材なら 0 でもよい' },
      { key: 'fc', label: '限界空孔率 fc', unit: '', step: 0.005, min: 0.001, max: 0.5, get: (p) => p.damage.gtn.fc, set: (p, v) => (p.damage.gtn.fc = v), hint: 'これを超えると f* が k 倍の速さで増える。判定を GTN にすると f ≥ fc で亀裂' },
    ],
  },
  {
    title: '計算',
    fields: [
      { key: 'cells', label: '板厚方向のセル数', unit: '', step: 1, min: 4, max: 40, get: (p) => p.numerics.cellsThrough, set: (p, v) => (p.numerics.cellsThrough = Math.round(v)) },
      { key: 'ms', label: '質量スケーリング', unit: '倍', step: 1000, min: 1, max: 1e6, get: (p) => p.numerics.massScale, set: (p, v) => (p.numerics.massScale = v), hint: '大きいほど速いが慣性が効く。ロール周速² × 倍率 ≲ 1e4 を目安に' },
      { key: 'V', label: 'ロール周速（計算上）', unit: 'm/s', step: 0.1, min: 0.05, max: 20, get: (p) => p.rolling.rollSpeed, set: (p, v) => (p.rolling.rollSpeed = v) },
      { key: 'Vm', label: '実機のロール周速', unit: 'm/s', step: 1, min: 0.1, max: 60, get: (p) => p.rolling.millSpeed, set: (p, v) => (p.rolling.millSpeed = v), hint: 'ひずみ速度依存の評価だけに使う' },
    ],
  },
];

const GROUPS: Group[] = RAW.map((g) => ({
  ...g,
  fields: g.fields.map((f) => (LIMITS[f.key] ? { ...f, min: LIMITS[f.key][0], max: LIMITS[f.key][1] } : f)),
}));

export interface Panel {
  /** write the params into the inputs */
  show(p: SimParams): void;
  /** read the inputs into a copy of `base` */
  read(base: SimParams): SimParams;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function buildPanel(root: HTMLElement, onEdit: () => void): Panel {
  const inputs = new Map<string, HTMLInputElement>();
  const selects = new Map<string, HTMLSelectElement>();

  const select = (key: string, label: string, options: [string, string][]) => {
    const row = el('label', 'field');
    row.append(el('span', 'field-label', label));
    const s = el('select');
    s.name = key;
    for (const [v, t] of options) {
      const o = el('option', undefined, t);
      o.value = v;
      s.append(o);
    }
    s.addEventListener('change', onEdit);
    row.append(s);
    selects.set(key, s);
    return row;
  };

  const matGroup = el('fieldset', 'group');
  matGroup.append(el('legend', undefined, '材料'));
  matGroup.append(
    select(
      'material',
      '材料',
      Object.entries(MATERIALS).map(([k, m]) => [k, m.name]),
    ),
  );
  matGroup.append(
    select('yield', '降伏条件', [
      ['von-mises', 'von Mises（圧力に依存しない）'],
      ['gtn', 'GTN（空孔率で軟化する）'],
    ]),
  );
  matGroup.append(
    select('nucleation', '空孔の核生成（GTN）', [
      ['tension', '平均応力が引張のときだけ'],
      ['always', 'いつでも（論文の式）'],
    ]),
  );
  matGroup.append(
    select('damage', '亀裂を判定する基準', [
      ['johnson-cook', 'Johnson-Cook（三軸度・速度・温度）'],
      ['hancock-mackenzie', 'Hancock-MacKenzie（三軸度）'],
      ['cockcroft-latham', 'Cockcroft-Latham（最大主応力）'],
      ['gtn', '空孔率が fc に達する（GTN）'],
      ['none', '判定しない'],
    ]),
  );
  matGroup.append(
    select('failure', '亀裂になった点の扱い', [
      ['tension-cut', '圧縮だけ受け持つ（閉じた亀裂は荷重を伝える）'],
      ['erode', '応力をすべて失う（論文の方法）'],
    ]),
  );

  for (const g of GROUPS) {
    const fs = el('fieldset', 'group');
    fs.append(el('legend', undefined, g.title));
    for (const f of g.fields) {
      const row = el('label', 'field');
      const head = el('span', 'field-label', f.label);
      row.append(head);
      const box = el('span', 'field-input');
      const inp = el('input');
      inp.type = 'number';
      inp.name = f.key;
      inp.step = String(f.step);
      // The spin buttons count steps from min: start them from a multiple of the
      // step (10000 → 11000, not 10001); read() still clamps to the real min.
      inp.min = String(+(Math.floor(f.min / f.step + 1e-9) * f.step).toPrecision(12));
      inp.max = String(f.max);
      inp.addEventListener('input', onEdit);
      box.append(inp);
      if (f.unit) box.append(el('span', 'unit', f.unit));
      row.append(box);
      if (f.hint) row.append(el('span', 'hint', f.hint));
      fs.append(row);
      inputs.set(f.key, inp);
    }
    root.append(fs);
    if (g.title === '潤滑と張力') root.append(matGroup);
  }

  return {
    show(p) {
      for (const g of GROUPS) for (const f of g.fields) inputs.get(f.key)!.value = String(+f.get(p).toPrecision(6));
      const matKey = Object.entries(MATERIALS).find(([, m]) => m.name === p.material.name)?.[0] ?? 'spcc';
      selects.get('material')!.value = matKey;
      selects.get('yield')!.value = p.damage.yield;
      selects.get('nucleation')!.value = p.damage.gtn.nucleation;
      selects.get('damage')!.value = p.damage.model;
      selects.get('failure')!.value = p.damage.failure;
    },
    read(base) {
      const p: SimParams = structuredClone(base);
      const matKey = selects.get('material')!.value;
      if (MATERIALS[matKey] && MATERIALS[matKey].name !== p.material.name) p.material = { ...MATERIALS[matKey] };
      p.damage.yield = selects.get('yield')!.value as SimParams['damage']['yield'];
      p.damage.gtn.nucleation = selects.get('nucleation')!.value as SimParams['damage']['gtn']['nucleation'];
      p.damage.model = selects.get('damage')!.value as SimParams['damage']['model'];
      p.damage.failure = selects.get('failure')!.value as SimParams['damage']['failure'];
      for (const g of GROUPS) {
        for (const f of g.fields) {
          const v = parseFloat(inputs.get(f.key)!.value);
          if (Number.isFinite(v)) f.set(p, Math.min(f.max, Math.max(f.min, v)));
        }
      }
      if (!hasBite(p.rolling)) {
        // the rolls could not bite with this h0, r and R: keep the ones that ran
        p.rolling.h0 = base.rolling.h0;
        p.rolling.reduction = base.rolling.reduction;
        p.rolling.rollRadius = base.rolling.rollRadius;
      }
      return p;
    },
  };
}
