// A 3D tandem's results, one column per stand: the section model's table (standTable.ts, its styles and layout:
// each quantity a line of its own across the stands' columns, its values on the line below) with the
// three-dimensional model's quantities. One stand: the section stays hidden.
import type { Stand3Result } from '../mpm/solid/tandem3.ts';
import type { TandemStop } from '../mpm/tandem.ts';
import { standColor } from './explorer.ts';
import { stopPhrase } from './standTable.ts';

const num = (v: number | null | undefined, k: number, digits: number) => (v != null && Number.isFinite(v) ? (v * k).toFixed(digits) : '—');

const ROWS: [string, (r: Stand3Result) => string, string][] = [
  ['入側板厚', (r) => num(r.h0, 1e3, 3), 'mm'],
  ['入側の板幅', (r) => num(r.width, 1e3, 3), 'mm'],
  ['出てきた板の厚さ', (r) => num(r.thicknessOut, 1e3, 3), 'mm'],
  ['出てきた板の幅', (r) => num(r.widthOut, 1e3, 3), 'mm'],
  ['圧下率', (r) => num(1 - r.thicknessOut / r.h0, 100, 1), '%'],
  ['幅広がり', (r) => num(r.widthOut / r.width - 1, 100, 2), '%'],
  ['圧延荷重（全幅）', (r) => num(r.steady?.force, 1e-3, 2), 'kN'],
  ['板幅あたりの荷重', (r) => (r.steady ? num(r.steady.force / (2 * r.steady.halfWidth), 1e-6, 3) : '—'), 'kN/mm'],
  ["ロール半径 R'", (r) => num(r.rollRadius, 1e3, 1), 'mm'],
  ['ロールギャップ', (r) => num(r.gap, 1e3, 4), 'mm'],
  ['先進率', (r) => num(r.steady?.forwardSlip, 100, 2), '%'],
  ['最大損傷', (r) => r.maxDamage.toFixed(3), ''],
  ['亀裂の点', (r) => String(r.nFailed), '個'],
  ['粒子数（1/4）', (r) => r.particles.toLocaleString(), '個'],
];

function cell(tag: 'th' | 'td', text: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export class SolidStandTable {
  private readonly section: HTMLElement;
  private readonly table: HTMLElement;
  private key = '';

  constructor(section: HTMLElement, table: HTMLElement) {
    this.section = section;
    this.table = table;
  }

  /** the run's stands, the finished ones' results, the stand running (0 first), whether the run is over, the running stand's entry thickness and width [m], and why it stopped early */
  update(stands: number, results: Stand3Result[], current: number, over: boolean, entry: { h0: number; width: number } | null, stopped: TandemStop | null): void {
    const key = `${stands}|${current}|${results.length}|${over}|${entry?.h0}|${stopped}`;
    if (key === this.key) return;
    this.key = key;
    this.section.hidden = stands <= 1;
    if (stands <= 1) return;
    const head = document.createElement('tr');
    for (let k = 0; k < stands; k++) {
      const th = cell('th', `#${k + 1}`, k === current && !over ? 'current' : undefined);
      th.style.color = standColor(k);
      th.setAttribute('scope', 'col');
      head.append(th);
    }
    const bodies = ROWS.map(([name, value, unit], i) => {
      const nameRow = document.createElement('tr');
      nameRow.className = 'name';
      const th = cell('th', name);
      th.setAttribute('scope', 'rowgroup');
      th.setAttribute('colspan', String(stands));
      if (unit) {
        const u = document.createElement('span');
        u.className = 'unit';
        u.textContent = unit;
        th.append(' ', u);
      }
      nameRow.append(th);
      const tr = document.createElement('tr');
      tr.className = 'values';
      for (let k = 0; k < stands; k++) {
        const r = results[k];
        // the stand running now: only its entry strip is known yet
        const now = k !== current || !entry ? '—' : i === 0 ? num(entry.h0, 1e3, 3) : i === 1 ? num(entry.width, 1e3, 3) : '…';
        tr.append(cell('td', r ? value(r) : now));
      }
      const tbody = document.createElement('tbody');
      tbody.append(nameRow, tr);
      return tbody;
    });
    const thead = document.createElement('thead');
    thead.append(head);
    const notes: string[] = [];
    const k = results.length;
    if (stopped) notes.push(`${stopPhrase(stopped, k)}。その先のスタンドは計算していない`);
    const names = (rs: Stand3Result[]) => rs.map((r) => `#${r.stand + 1}`).join('・');
    const unsteady = results.filter((r) => !r.steady);
    if (unsteady.length) notes.push(`${names(unsteady)} は定常の読みが無い（板が短い${unsteady.some((r) => !r.rollsSettled) ? '、またはロールの調整が落ち着く前に尾端がバイトに入った' : ''}）ので、荷重・先進率は —`);
    const caption = document.createElement('caption');
    caption.className = 'table-note';
    caption.textContent = notes.join('。');
    this.table.replaceChildren(...(notes.length ? [caption] : []), thead, ...bodies);
  }
}
