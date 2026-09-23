// The conditions panel: numeric inputs bound to SimParams (shown in mm / MPa).
// The fields the URL can also set take their ranges from it (query.ts LIMITS).
import { MATERIALS, ROLL_E, hasBite, type SimParams } from '../mpm/params.ts';
import { buildDefectEditor } from './defectEditor.ts';
import { checkRange } from './fieldCheck.ts';
import { buildMaterialEditor } from './materialEditor.ts';
import { edited, showNumber } from './numberInput.ts';
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
  /** the section model's only (hidden in the plan view, which does not use it) */
  sectionOnly?: boolean;
}

interface Group {
  title: string;
  fields: NumField[];
  /** folded away until opened (settings changed less often) */
  fold?: boolean;
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
      {
        key: 'rollE',
        label: 'ロールのヤング率',
        unit: 'GPa',
        step: 1,
        min: 50,
        max: 700,
        get: (p) => (p.rolling.rollE ?? ROLL_E) * 1e-9,
        // the steel roll is written as no rollE at all (as the presets have it), so that it is not a difference
        set: (p, v) => {
          if (v * 1e9 === ROLL_E) delete p.rolling.rollE;
          else p.rolling.rollE = v * 1e9;
        },
        hint: 'ロール偏平（Hitchcock）にだけ効く。鋼 206、超硬 500〜600',
        sectionOnly: true,
      },
      { key: 'L', label: '板の長さ', unit: 'mm', step: 1, min: 2, max: 200, get: (p) => p.rolling.sheetLength / mm, set: (p, v) => (p.rolling.sheetLength = v * mm) },
      {
        key: 'stands',
        label: 'スタンド数',
        unit: '',
        step: 1,
        min: 1,
        max: 5,
        get: (p) => p.rolling.stands ?? 1,
        // one stand is written as no stands at all (as the presets have it), so that it is not a difference
        set: (p, v) => {
          if (Math.round(v) === 1) delete p.rolling.stands;
          else p.rolling.stands = Math.round(v);
        },
        hint: 'タンデム（圧下率は各スタンドの入側板厚に対して）。後のスタンドほど重く、r 25 % の 5 スタンドで 1 スタンドの 50 倍ほど（格子が細かいほど、r が大きいほど増える）',
        sectionOnly: true,
      },
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
      { key: 'D4', label: 'D4（ひずみ速度）', unit: '', step: 0.001, min: -1, max: 1, get: (p) => p.damage.D4, set: (p, v) => (p.damage.D4 = v) },
      { key: 'D5', label: 'D5（温度）', unit: '', step: 0.01, min: -5, max: 5, get: (p) => p.damage.D5, set: (p, v) => (p.damage.D5 = v) },
      { key: 'cl', label: 'Cockcroft-Latham 限界値', unit: '', step: 0.05, min: 0.01, max: 5, get: (p) => p.damage.clCrit, set: (p, v) => (p.damage.clCrit = v) },
      { key: 'cut', label: '損傷が進まない三軸度', unit: '', step: 0.05, min: -2, max: 0, get: (p) => p.damage.etaCutoff, set: (p, v) => (p.damage.etaCutoff = v), hint: 'これより圧縮側では損傷を積算しない（Bao-Wierzbicki は −1/3）' },
    ],
  },
  {
    title: '空孔（GTN）',
    fold: true,
    fields: [
      { key: 'f0', label: '初期空孔率 f0', unit: '', step: 0.001, min: 0, max: 0.2, get: (p) => p.damage.gtn.f0, set: (p, v) => (p.damage.gtn.f0 = v), hint: '論文の鋼は 0.005。冷延材なら 0 でもよい' },
      { key: 'fc', label: '限界空孔率 fc', unit: '', step: 0.005, min: 0.001, max: 0.5, get: (p) => p.damage.gtn.fc, set: (p, v) => (p.damage.gtn.fc = v), hint: 'これを超えると f* が k 倍の速さで増える。判定を GTN にすると f ≥ fc で亀裂' },
    ],
  },
  {
    title: '計算',
    fold: true,
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
  /** read the inputs into a copy of `base`; an input not edited since `show(base)` keeps base's value */
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

  const materialEditor = buildMaterialEditor(onEdit);
  const defectEditor = buildDefectEditor(onEdit);
  const checks: (() => void)[] = [];

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
  // only used with the GTN yield condition: it lives in that (folded) group
  const nucleation = select('nucleation', '空孔の核生成', [
    ['tension', '平均応力が引張のときだけ'],
    ['always', 'いつでも（論文の式）'],
  ]);
  matGroup.append(
    select('damage', '亀裂を判定する基準', [
      ['johnson-cook', 'Johnson-Cook（三軸度・速度・温度）'],
      ['hancock-mackenzie', 'Hancock-MacKenzie（三軸度）'],
      ['cockcroft-latham', 'Cockcroft-Latham（最大主応力）'],
      ['gtn', '空孔率が fc に達する（GTN）'],
      ['localization', 'せん断帯が生じうる（音響テンソルの特異。硬化する材料では起きない）'],
      ['none', '判定しない'],
    ]),
  );
  matGroup.append(
    select('failure', '亀裂になった点の扱い', [
      ['tension-cut', '圧縮だけ受け持つ（閉じた亀裂は荷重を伝える）'],
      ['erode', '応力をすべて失う（論文の方法）'],
    ]),
  );
  matGroup.append(
    select('crack', '亀裂の面', [
      ['dfg', '場を分ける（面が開く）'],
      ['none', '分けない（1 つの速度場）'],
    ]),
  );

  // with the sheet and the rolls, under the number of stands
  const handoff = select('handoff', 'スタンドの引き継ぎ', [
    ['done', '板が全部抜けてから'],
    ['steady', '定常になったらすぐ（速い）'],
    ['crop', '中央部を切り出す（次の定常に要る長さ）'],
  ]);
  handoff.classList.add('section-only');
  handoff.title =
    'タンデムで、次のスタンドへ移るとき。「定常になったらすぐ」は、出側の定常に圧延された部分を繰り返して次のスタンドの板を作る（板の残りは圧延しない。頭端・尾端の非定常な部分は引き継がない）。「中央部を切り出す」は、板の長手の中央から、次のスタンドが定常になるのに要る長さを切り出して次の板にする（その部分が抜けたら次へ。尾端は圧延しない。板がスタンドごとに長くならない）';

  // under the reduction and the roll radius they act on
  const control = select('control', '圧下率の取り方', [
    ['gap', 'ギャップ一定（ギャップ = 入側板厚 ×（1 − 圧下率））'],
    ['reduction', '圧下率一定（出側板厚が合うようにギャップを調整）'],
  ]);
  control.classList.add('section-only');
  control.title =
    '「ギャップ一定」では板の弾性回復とロール偏平のぶん、出てくる板が少し厚い（実際の圧下率は入力より小さい）。「圧下率一定」は出側の板厚を測ってロールギャップを詰め、実際の圧下率を入力した値にする。調整が済むまでは「ロールを調整中」で、定常の平均はそのあとから取る';
  // over the sheet's length it replaces
  const length = select('length', '板の長さの取り方', [
    ['fixed', '入力した長さ'],
    ['steady', '定常状態になるまで（長さは自動）'],
  ]);
  length.classList.add('section-only');
  // the length is then not an input: the field is off, and shows the length worked out once the run starts
  const lockLength = (auto: boolean) => {
    const L = inputs.get('L')!;
    L.disabled = auto;
    L.title = auto ? '「定常状態になるまで」では自動で決まる（圧延を始めると、決まった長さが出る）' : '';
  };
  length.addEventListener('change', () => lockLength(selects.get('length')!.value === 'steady'));
  length.title =
    '「定常状態になるまで」は、1 スタンド目の板の長さを、定常になって定常の読みが揃うのに要る長さに自動で決める（ロール偏平・圧下率一定ではロールの調整が落ち着くぶん長い）。決めた長さは、圧延を始めると「板の長さ」に出る。タンデムの 2 スタンド目以降は引き継ぎ方で決まる';
  const flatten = select('flatten', 'ロール偏平', [
    ['none', 'なし（剛体ロール）'],
    ['hitchcock', 'Hitchcock（計算した荷重と連立）'],
  ]);
  flatten.classList.add('section-only');
  flatten.title =
    "Hitchcock の式 R' = R (1 + C P / Δh)、C = 16 (1 − ν²) / (π E)。P は MPM で計算した圧延荷重で、圧延しながらロールの半径を R' に合わせていく（荷重と R' が釣り合うまで「ロールを調整中」）";
  // under the entry thickness it halves
  const sym = select('sym', '板厚方向', [
    ['full', '全厚（ロール 2 本）'],
    ['half', '対称（上半分・ロール 1 本）'],
  ]);
  sym.classList.add('section-only');
  sym.title =
    '「対称」は板の上半分だけを解く（中心面 y = 0 を対称面に、ロールは上の 1 本）。半分の点で約 2 倍速い。荷重・トルク・板厚は板全体の値。中心の亀裂は対称面の上で開く。絵は下半分を鏡で写し、下半分の点をクリックすると同じ点（上半分）が選ばれる。平面図と 3 次元には効かない';

  for (const g of GROUPS) {
    // a folded group is a <details> (its summary is the title); the others a <fieldset>
    let fs: HTMLElement;
    if (g.fold) {
      fs = el('details', 'group fold');
      fs.append(el('summary', undefined, g.title));
    } else {
      fs = el('fieldset', 'group');
      fs.append(el('legend', undefined, g.title));
    }
    if (g.title === '空孔（GTN）') fs.append(nucleation);
    for (const f of g.fields) {
      const row = el('label', f.sectionOnly ? 'field section-only' : 'field');
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
      checks.push(checkRange(inp, row, () => [f.min, f.max], f.unit));
      fs.append(row);
      inputs.set(f.key, inp);
      if (f.key === 'stands') fs.append(handoff);
      if (f.key === 'r') fs.append(control);
      if (f.key === 'L') fs.append(length);
      if (f.key === 'R') fs.append(flatten);
      if (f.key === 'h0') fs.append(sym);
    }
    root.append(fs);
    if (g.title === '潤滑と張力') root.append(matGroup, materialEditor.root, defectEditor.root);
  }

  // another material: its constants in the editor (edited ones would otherwise carry over)
  selects.get('material')!.addEventListener('change', () => {
    const m = MATERIALS[selects.get('material')!.value];
    if (!m) return;
    materialEditor.load(m);
    materialEditor.compareWith(m);
  });

  let shownFrom: SimParams | null = null;

  return {
    show(p) {
      shownFrom = p;
      for (const g of GROUPS) for (const f of g.fields) showNumber(inputs.get(f.key)!, f.get(p));
      for (const c of checks) c();
      const matKey = Object.entries(MATERIALS).find(([, m]) => m.name === p.material.name)?.[0] ?? 'spcc';
      selects.get('material')!.value = matKey;
      materialEditor.load(p.material);
      materialEditor.compareWith(MATERIALS[matKey] ?? null);
      defectEditor.show(p);
      selects.get('yield')!.value = p.damage.yield;
      selects.get('nucleation')!.value = p.damage.gtn.nucleation;
      selects.get('damage')!.value = p.damage.model;
      selects.get('failure')!.value = p.damage.failure;
      selects.get('crack')!.value = p.numerics.crackFields ?? 'none';
      selects.get('handoff')!.value = p.rolling.handoff ?? 'done';
      selects.get('control')!.value = p.rolling.gapControl ?? 'gap';
      selects.get('length')!.value = p.rolling.lengthMode ?? 'fixed';
      lockLength(p.rolling.lengthMode === 'steady');
      selects.get('flatten')!.value = p.rolling.flattening ?? 'none';
      selects.get('sym')!.value = p.rolling.halfThickness ? 'half' : 'full';
    },
    read(base) {
      const p: SimParams = structuredClone(base);
      const matKey = selects.get('material')!.value;
      if (MATERIALS[matKey] && MATERIALS[matKey].name !== p.material.name) p.material = { ...MATERIALS[matKey] };
      p.damage.yield = selects.get('yield')!.value as SimParams['damage']['yield'];
      p.damage.gtn.nucleation = selects.get('nucleation')!.value as SimParams['damage']['gtn']['nucleation'];
      p.damage.model = selects.get('damage')!.value as SimParams['damage']['model'];
      p.damage.failure = selects.get('failure')!.value as SimParams['damage']['failure'];
      p.numerics.crackFields = selects.get('crack')!.value as NonNullable<SimParams['numerics']['crackFields']>;
      // 'done' is written as no handoff at all (as the presets have it), so that it is not a difference
      const handoff = selects.get('handoff')!.value;
      if (handoff === 'steady' || handoff === 'crop') p.rolling.handoff = handoff;
      else delete p.rolling.handoff;
      if (selects.get('control')!.value === 'reduction') p.rolling.gapControl = 'reduction';
      else delete p.rolling.gapControl;
      if (selects.get('length')!.value === 'steady') p.rolling.lengthMode = 'steady';
      else delete p.rolling.lengthMode;
      if (selects.get('flatten')!.value === 'hitchcock') p.rolling.flattening = 'hitchcock';
      else delete p.rolling.flattening;
      // the whole thickness is written as no key at all (as the presets have it)
      if (selects.get('sym')!.value === 'half') p.rolling.halfThickness = true;
      else delete p.rolling.halfThickness;
      for (const g of GROUPS) {
        for (const f of g.fields) {
          const input = inputs.get(f.key)!;
          // not edited: keep the value (the text is rounded), unless it is out of range
          const kept = base === shownFrom && !edited(input);
          const v = kept ? f.get(p) : parseFloat(input.value);
          if (kept && v >= f.min && v <= f.max) continue;
          if (Number.isFinite(v)) f.set(p, Math.min(f.max, Math.max(f.min, v)));
        }
      }
      if (!hasBite(p.rolling)) {
        // the rolls could not bite with this h0, r and R: keep the ones that ran
        p.rolling.h0 = base.rolling.h0;
        p.rolling.reduction = base.rolling.reduction;
        p.rolling.rollRadius = base.rolling.rollRadius;
      }
      p.material = materialEditor.read(p.material);
      p.defects = defectEditor.read(p); // after the sheet's size, which bounds them
      return p;
    },
  };
}
