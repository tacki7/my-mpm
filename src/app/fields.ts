// What each display field is called, its unit, and how it is coloured.
import type { FieldName } from '../mpm/solver.ts';

export interface FieldInfo {
  id: FieldName;
  label: string;
  /** shorter name on the tab (the legend keeps the full one) */
  tab?: string;
  unit: string;
  scale: 'sequential' | 'diverging' | 'lattice';
  /** fixed range; otherwise taken from the data each frame */
  range?: [number, number];
  /** diverging colours reversed: the field is positive in compression, which is drawn blue */
  flip?: boolean;
}

export const FIELDS: FieldInfo[] = [
  { id: 'seq', label: '相当応力 σeq', unit: 'MPa', scale: 'sequential' },
  { id: 'eta', label: '応力三軸度 η', unit: '', scale: 'diverging', range: [-1.5, 1.5] },
  { id: 's1', label: '最大主応力 σ1', unit: 'MPa', scale: 'diverging' },
  { id: 'pres', label: '静水圧 p', unit: 'MPa', scale: 'diverging', flip: true },
  { id: 'ep', label: '相当塑性ひずみ εp', tab: '塑性ひずみ εp', unit: '', scale: 'sequential' },
  { id: 'damage', label: '損傷 D', unit: '', scale: 'sequential', range: [0, 1] },
  { id: 'sxx', label: '圧延方向応力 σxx', tab: '圧延方向 σxx', unit: 'MPa', scale: 'diverging' },
  { id: 'syy', label: '板厚方向応力 σyy', tab: '板厚方向 σyy', unit: 'MPa', scale: 'diverging' },
  { id: 'sxy', label: 'せん断応力 σxy', tab: 'せん断 σxy', unit: 'MPa', scale: 'diverging' },
  { id: 'lagrange', label: 'メタルフロー', unit: '', scale: 'lattice', range: [0, 1] },
  // 0 everywhere unless the yield condition is GTN
  { id: 'porosity', label: '空孔率 f', unit: '', scale: 'sequential' },
  // min det of the acoustic tensor / elastic: 1 where the point does not flow, about H/3G (0.001–0.02) where
  // it does, ≤ 0 where a shear band can form (drawn red). Not evaluated with the GTN yield condition.
  { id: 'loc', label: '局所化の指標 det A / 弾性の値', unit: '', scale: 'diverging', range: [-0.05, 0.05], flip: true },
  // Drucker: σ̇ : Dp / ε̇p², the slope of the flow stress along the path (H ≈ 300–4000 MPa for SPCC);
  // negative is unstable (drawn red). Fixed range: the entry and exit have outliers of ±10⁵ MPa
  { id: 'drucker', label: 'Drucker の指標 σ̇:Dp / ε̇p²', unit: 'MPa', scale: 'diverging', range: [-2000, 2000], flip: true },
];

export function fieldInfo(id: FieldName): FieldInfo {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0];
}
