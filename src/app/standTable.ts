// A tandem's results, one column per stand (the column heads in the stand's colour, the running one
// underlined): entry and exit thickness, reduction, roll force, forward slip, damage and failed points of
// each finished stand. The stand running now shows its entry thickness only; the ones to come, dashes.
// One stand: the section stays hidden and the page is as before.
import type { StandResult } from '../mpm/tandem.ts';
import { standColor } from './explorer.ts';

const ROWS: [string, (r: StandResult) => string, string][] = [
  ['入側板厚', (r) => mm(r.h0), 'mm'],
  ['出側板厚', (r) => mm(r.exitThickness), 'mm'],
  ['圧下率', (r) => (r.exitThickness != null ? ((1 - r.exitThickness / r.h0) * 100).toFixed(1) : '—'), '%'],
  ['圧延荷重', (r) => (r.steadyForce != null ? (r.steadyForce * 1e-6).toFixed(2) : '—'), 'kN/mm'],
  ['先進率', (r) => (r.forwardSlip != null ? (r.forwardSlip * 100).toFixed(2) : '—'), '%'],
  ['最大損傷', (r) => r.maxDamage.toFixed(3), ''],
  ['亀裂になった点', (r) => String(r.nFailed), '個'],
];

function mm(v: number | null): string {
  return v != null ? (v * 1e3).toFixed(3) : '—';
}

function cell(tag: 'th' | 'td', text: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export class StandTable {
  private readonly section: HTMLElement;
  private readonly table: HTMLElement;
  /** what the table was last drawn for (it is drawn again only when that changes) */
  private key = '';

  constructor(section: HTMLElement, table: HTMLElement) {
    this.section = section;
    this.table = table;
  }

  /** the run's stands, the finished ones' results, the stand running (0 first), whether the pass is over, and the running stand's entry thickness [m] */
  update(stands: number, results: StandResult[], current: number, passDone: boolean, h0Now: number | null): void {
    const key = `${stands}|${current}|${results.length}|${passDone}|${h0Now}`;
    if (key === this.key) return;
    this.key = key;
    this.section.hidden = stands <= 1;
    if (stands <= 1) return;
    const head = document.createElement('tr');
    head.append(cell('th', ''));
    for (let k = 0; k < stands; k++) {
      const th = cell('th', `#${k + 1}`, k === current && !passDone ? 'current' : undefined);
      th.style.color = standColor(k);
      head.append(th);
    }
    head.append(cell('th', ''));
    const body = ROWS.map(([name, value, unit], i) => {
      const tr = document.createElement('tr');
      tr.append(cell('th', name));
      for (let k = 0; k < stands; k++) {
        const r = results[k];
        // the stand running now: only its entry thickness is known yet
        const now = k !== current ? '—' : i === 0 && h0Now != null ? mm(h0Now) : '…';
        tr.append(cell('td', r ? value(r) : now));
      }
      tr.append(cell('td', unit, 'unit'));
      return tr;
    });
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    tbody.append(...body);
    // a stand that did not end 'done' stops the pass there
    const stopped = results.find((r) => r.phase !== 'done');
    const caption = document.createElement('caption');
    caption.className = 'table-note';
    if (stopped) {
      const why = stopped.phase === 'stalled' ? '板が止まった（噛み込めない）' : `計算を止めた（${stopped.phase}）`;
      caption.textContent = `#${stopped.stand + 1} で${why}。その先のスタンドは計算していない`;
    }
    this.table.replaceChildren(...(stopped ? [caption] : []), thead, tbody);
  }
}
