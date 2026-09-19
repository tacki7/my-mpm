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
    note: '前方張力 615 MPa が出側の板の平面ひずみ変形抵抗 2k（約 557 MPa）の 1.1 倍。出口の先で板が伸び、くびれて破断する（示すのは 2k を超えると切れること。切れる場所は格子や掴みで動く）。',
    build: () => {
      const p = defaultParams();
      p.material = { ...STEEL_SPCC };
      // 35 % and μ 0.15 so the rolls still hold the strip (neutral point in the bite) at this tension
      p.rolling.reduction = 0.35;
      p.rolling.mu = 0.15;
      p.rolling.frontTension = 615 * MPa;
      p.damage = { ...DAMAGE_4340, model: 'cockcroft-latham', clCrit: 0.35 };
      return p;
    },
  },
  {
    id: 'central-burst',
    label: '厚肉・軽圧下の中心割れ',
    note: '接触長に比べて板が厚く（h/L > 1）、変形が板厚中心まで届かない。中心に静水圧の引張が残る。',
    build: () => {
      const p = defaultParams();
      p.rolling.h0 = 4 * mm;
      p.rolling.reduction = 0.08;
      p.rolling.rollRadius = 25 * mm;
      p.rolling.sheetLength = 24 * mm;
      p.rolling.mu = 0.1;
      p.material = { ...STEEL_4340 };
      p.damage = { ...DAMAGE_4340, D1: 0.02, D2: 0.6 };
      p.numerics.cellsThrough = 16;
      return p;
    },
  },
  {
    id: 'void',
    label: '内部欠陥（空洞）起点',
    note: '板厚中心に空洞がある板。ロールバイトで潰れるか、出口側の引張で開くか。',
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
    note: '潤滑切れ（μ = 0.25）の低延性アルミ。表層の三軸度はこのモデルでは負のままで、表面からは割れない（docs/presets.md）。',
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
