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
    note: '前方張力 615 MPa が出側の板の平面ひずみ変形抵抗 2k（約 557 MPa）の 1.1 倍。出口の先で板が伸び、くびれて破断する（示すのは 2k を超えると切れること。切れる場所は掴みのすぐ外で、荷重の入れ方で決まる。物理の場所ではない）。',
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
    note: '接触長に比べて板が厚い（Δ = 平均板厚 / 接触長 ≈ 3.6）と、張力なしでも塑性変形中の板厚中心が静水圧の引張（η > 0）になり、中心の偏析帯（延性 1/50）が割れる（既定の 12 セル以上で。10 セル以下の粗い格子では割れない）。表層は圧縮のまま。実物の中心割れは多パスで累積するので、1 パスで見せるために延性を下げている。割れの間隔は格子で決まる（docs/presets.md）。',
    build: () => {
      const p = defaultParams();
      p.rolling.h0 = 10 * mm;
      p.rolling.reduction = 0.05;
      p.rolling.rollRadius = 15 * mm;
      p.rolling.sheetLength = 32 * mm;
      // above tan α (α = √(Δh / R) = 0.18) so the rolls bite and draw the plate on their own; at μ 0.1 (just over
      // α / 2) the plate skidded and slowed through the pass (forward slip −2 → −18 %)
      p.rolling.mu = 0.2;
      p.material = { ...STEEL_4340 };
      // the paper's Johnson-Cook constants; damage grows only under hydrostatic tension (η > 0)
      p.damage = { ...DAMAGE_4340, etaCutoff: 0 };
      // centreline segregation: a weak band along the mid-plane, clear of both ends. 1/50 is the loosest that
      // cracks at 12 cells (1/20 reaches D 0.44, 1/33 D 0.74); coarser grids need 1/100 (docs/presets.md)
      p.defects = [{ kind: 'weak', x: 16 * mm, y: 0, ax: 13 * mm, ay: 0.5 * mm, ductility: 0.02 }];
      p.numerics.cellsThrough = 12;
      return p;
    },
  },
  {
    id: 'void',
    label: '内部欠陥（空洞）起点',
    note: '板厚中心に空洞がある板。空洞はロールバイトで上下から潰れ（高さは点の間隔 1 つ分まで）、出口の先でも圧縮のままで開かない。割れない。',
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
