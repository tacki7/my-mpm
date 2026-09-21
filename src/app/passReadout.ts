// The pass's load, torque, exit thickness and forward slip for the results table. Once the stand has steady
// readings they are the steady means, read as its result and tools/run.mjs read them (TandemSim's readings every
// READ_STEPS steps), and they stay after the sheet has left the rolls, where the moment's values fall to 0. Before
// the steady phase the moment's values; past it without a reading (a short sheet), none.
import type { Diagnostics } from '../mpm/solver.ts';
import type { SteadyMeans } from '../mpm/tandem.ts';

export interface Readout {
  /** for checks: data-key of the row */
  key: 'force' | 'torque' | 'exit' | 'slip' | 'reduction' | 'radius' | 'gap';
  label: string;
  /** in the unit shown (null: none) */
  value: number | null;
  text: string;
  unit: string;
  /** a steady mean (not the moment's value) */
  steady: boolean;
}

/** how the rows read: the steady means, the moment's values, or none (past the steady phase without a reading) */
export type ReadoutKind = 'steady' | 'moment' | 'none';

export function readoutKind(d: Diagnostics, s: SteadyMeans | null): ReadoutKind {
  if (s && s.readings > 0) return 'steady';
  return d.phase === 'tail-out' || d.phase === 'done' || d.phase === 'stalled' ? 'none' : 'moment';
}

/** rolls that follow the pass (flattening, constant reduction): the stand's entry thickness, for the reduction it got */
export interface AdjustedRolls {
  h0: number;
}

export function passReadout(d: Diagnostics, s: SteadyMeans | null, rolls: AdjustedRolls | null = null): Readout[] {
  const kind = readoutKind(d, s);
  const pick = (steady: number | null | undefined, moment: number | null | undefined) =>
    kind === 'steady' ? (steady ?? null) : kind === 'moment' ? (moment ?? null) : null;
  const row = (key: Readout['key'], name: string, v: number | null, scale: number, digits: number, unit: string): Readout => {
    const value = v != null ? v * scale : null;
    return { key, label: kind === 'steady' ? `${name}（定常）` : name, value, text: value != null ? value.toFixed(digits) : '—', unit, steady: kind === 'steady' };
  };
  return [
    row('force', '圧延荷重', pick(s?.force, d.rollForce), 1e-6, 3, 'kN/mm'),
    row('torque', '圧延トルク', pick(s?.torque, d.rollTorque), 1e-3, 3, 'kN·m/m'),
    row('exit', '出側板厚', pick(s?.exitThickness, d.exitThickness), 1e3, 4, 'mm'),
    row('slip', '先進率', pick(s?.forwardSlip, d.forwardSlip), 100, 2, '%'),
    ...(rolls ? adjusted(d, pick(s?.exitThickness, d.exitThickness), rolls, kind === 'steady') : []),
  ];
}

/** the reduction the sheet got, and the rolls now (the moment's: they are held once settled) */
function adjusted(d: Diagnostics, exit: number | null, rolls: AdjustedRolls, steady: boolean): Readout[] {
  const red = exit != null ? (1 - exit / rolls.h0) * 100 : null;
  const now = d.rollsSettled ? '' : '（調整中）';
  return [
    { key: 'reduction', label: steady ? '実際の圧下率（定常）' : '実際の圧下率', value: red, text: red != null ? red.toFixed(2) : '—', unit: '%', steady },
    { key: 'radius', label: `ロール半径 R'${now}`, value: d.rollRadius * 1e3, text: (d.rollRadius * 1e3).toFixed(2), unit: 'mm', steady: false },
    { key: 'gap', label: `ロールギャップ${now}`, value: d.gap * 1e3, text: (d.gap * 1e3).toFixed(4), unit: 'mm', steady: false },
  ];
}

/** after the line above: why the torque is negative (a front tension that pulls the strip out) */
export function torqueNote(torque: number | null | undefined): string {
  return torque != null && torque < 0
    ? '　圧延トルクが負なのは、前方張力が板を引き出していて、ロールが板を送るのでなく引き留めているから。'
    : '';
}

/** the line under the results table: what the first four rows are */
export function readoutNote(kind: ReadoutKind): string {
  return kind === 'steady'
    ? '（定常）は定常の読み（2000 ステップごと）の平均。板が抜けた後も残る。node tools/run.mjs・スタンドごとの表と同じ読み方'
    : kind === 'none'
      ? '定常の読みが無い（板が短く、頭端が出口の先に届く前に尾端がバイトに入る）ので、荷重・トルク・出側板厚・先進率は —'
      : '定常の読みが出るまでは、その瞬間の値';
}
