// What each display field is called, its unit, and how it is coloured.
import type { FieldName } from '../mpm/solver.ts';
import type { DamageModel } from '../mpm/params.ts';

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
  // 0 everywhere unless the Taylor-Quinney coefficient χ is above 0 (kept away from the other all-zero
  // field, porosity: two all-zero tabs side by side look the same)
  { id: 'dT', label: '温度上昇 ΔT', unit: 'K', scale: 'sequential' },
  // the rate the flow stress and the JC fracture strain see: the deviatoric rate of deformation at the mill speed
  // (millSpeed / rollSpeed times the simulated one); 0 before the bite and after it, largest at the entry of the bite
  { id: 'rate', label: '相当ひずみ速度（実機の速度）', tab: 'ひずみ速度', unit: '1/s', scale: 'sequential' },
  { id: 'lagrange', label: 'メタルフロー', unit: '', scale: 'lattice', range: [0, 1] },
  // 0 everywhere unless the yield condition is GTN
  { id: 'porosity', label: '空孔率 f', unit: '', scale: 'sequential' },
  // min det of the acoustic tensor / elastic: 1 where the point does not flow, ≤ 0 where a shear band can form
  // (drawn red). Flowing points in the bite (standard, 6 cells): p05 3.4e-3, p50 0.043, p95 0.30 (H/3G is 0.001–0.02;
  // the out-of-plane deviator raises it), so about half of them saturate like the elastic points: the range resolves
  // the ones closest to a band. Not evaluated with the GTN yield condition.
  { id: 'loc', label: '局所化の指標 det A / 弾性の値', unit: '', scale: 'diverging', range: [-0.05, 0.05], flip: true },
  // Drucker: σ̇ : Dp / ε̇p², the slope of the flow stress along the path; negative is unstable (drawn red).
  // Medians over eighths of the bite (standard, 6 cells): 1650, 700, 540, 455, 570, 360, 240, −1130 MPa.
  // Fixed range: the entry and exit have outliers of ±10⁵ MPa
  { id: 'drucker', label: 'Drucker の指標 σ̇:Dp / ε̇p²', unit: 'MPa', scale: 'diverging', range: [-2000, 2000], flip: true },
];

/** The damage field's name: with no failure criterion it is the largest of the three integrated indicators. */
export function damageLabel(model: DamageModel): string {
  return model === 'none' ? '損傷 D（判定しない: JC・HM・CL の最大）' : '損傷 D';
}

export function fieldInfo(id: FieldName): FieldInfo {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0];
}
