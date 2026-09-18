// What each display field is called, its unit, and how it is coloured.
import type { FieldName } from '../mpm/solver.ts';

export interface FieldInfo {
  id: FieldName;
  label: string;
  unit: string;
  scale: 'sequential' | 'diverging' | 'lattice';
  /** fixed range; otherwise taken from the data each frame */
  range?: [number, number];
}

export const FIELDS: FieldInfo[] = [
  { id: 'seq', label: '相当応力 σeq', unit: 'MPa', scale: 'sequential' },
  { id: 'eta', label: '応力三軸度 η', unit: '', scale: 'diverging', range: [-1.5, 1.5] },
  { id: 's1', label: '最大主応力 σ1', unit: 'MPa', scale: 'diverging' },
  { id: 'pres', label: '静水圧 p', unit: 'MPa', scale: 'diverging' },
  { id: 'ep', label: '相当塑性ひずみ εp', unit: '', scale: 'sequential' },
  { id: 'damage', label: '損傷 D', unit: '', scale: 'sequential', range: [0, 1] },
  { id: 'sxx', label: '圧延方向応力 σxx', unit: 'MPa', scale: 'diverging' },
  { id: 'syy', label: '板厚方向応力 σyy', unit: 'MPa', scale: 'diverging' },
  { id: 'sxy', label: 'せん断応力 σxy', unit: 'MPa', scale: 'diverging' },
  { id: 'lagrange', label: 'メタルフロー', unit: '', scale: 'lattice', range: [0, 1] },
];

export function fieldInfo(id: FieldName): FieldInfo {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0];
}
