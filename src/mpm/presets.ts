// Named rolling conditions. Each one sets up a situation whose stress state
// matters for cracking; see docs/presets.md for what each is meant to show and
// whether it has been tuned to actually show it.
import { AL_6061, DAMAGE_4340, STEEL_4340, STEEL_SPCC, defaultParams, type SimParams } from './params.ts';

export interface Preset {
  id: string;
  label: string;
  /** one sentence: what to look for */
  note: string;
  build(): SimParams;
}

const mm = 1e-3;
const MPa = 1e6;

export const PRESETS: Preset[] = [
  {
    id: 'standard',
    label: '薄板の標準圧延',
    note: '低炭素鋼 1.0 mm を 25 % 圧下。圧縮の三軸度が支配的で割れない基準ケース。',
    build: () => defaultParams(),
  },
  {
    id: 'front-tension',
    label: '前方張力が過大',
    note: '出側の張力が加工硬化後の降伏応力に近い。出口の先で板が伸び、くびれて破断する。',
    build: () => {
      const p = defaultParams();
      p.material = { ...STEEL_SPCC };
      p.rolling.frontTension = 480 * MPa;
      p.damage = { ...DAMAGE_4340, model: 'cockcroft-latham', clCrit: 0.35 };
      return p;
    },
  },
  {
    id: 'central-burst',
    label: '厚肉・軽圧下の中心割れ',
    note: '接触長に比べて板が厚い（Δ ≈ 3.6）と変形が中心まで届かず、前方張力の下で中心が引張のまま塑性流動する。中心偏析帯が周期的に割れる。',
    build: () => {
      const p = defaultParams();
      p.rolling.h0 = 10 * mm;
      p.rolling.reduction = 0.05;
      p.rolling.rollRadius = 15 * mm;
      p.rolling.sheetLength = 32 * mm;
      p.rolling.mu = 0.1;
      p.rolling.frontTension = 500 * MPa;
      p.material = { ...STEEL_4340 };
      // the paper's 4340 constants; damage only under tensile triaxiality
      p.damage = { ...DAMAGE_4340, etaCutoff: 0 };
      p.numerics.cellsThrough = 16;
      // centreline segregation: a thin low-ductility band along the whole plate
      p.defects = [{ kind: 'weak', x: 16 * mm, y: 0, ax: 17 * mm, ay: 0.6 * mm, ductility: 0.005 }];
      return p;
    },
  },
  {
    id: 'void',
    label: '内部の空洞が圧着される',
    note: '板厚中心の空洞がロールバイトで押し潰される（30 % 圧下で高さ 0.30 → 約 0.06 mm）。周りの延性の低い部分も圧縮の三軸度では損傷がほとんど進まない。',
    build: () => {
      const p = defaultParams();
      p.rolling.h0 = 1.5 * mm;
      p.rolling.reduction = 0.3;
      p.material = { ...STEEL_4340 };
      p.damage = { ...DAMAGE_4340, D2: 1.2 };
      p.defects = [
        { kind: 'void', x: 5 * mm, y: 0, ax: 0.4 * mm, ay: 0.12 * mm },
        { kind: 'weak', x: 5 * mm, y: 0, ax: 1.2 * mm, ay: 0.35 * mm, ductility: 0.4 },
      ];
      return p;
    },
  },
  {
    id: 'high-friction',
    label: '高摩擦・低延性',
    note: '潤滑切れ（μ = 0.25）の低延性アルミ。表層のせん断と入口の引張で表面から割れる。',
    build: () => {
      const p = defaultParams();
      p.rolling.mu = 0.25;
      p.rolling.reduction = 0.35;
      p.material = { ...AL_6061 };
      p.damage = { ...DAMAGE_4340, D1: -0.77, D2: 1.45, D3: -0.47, D4: 0, D5: 1.6 };
      return p;
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
