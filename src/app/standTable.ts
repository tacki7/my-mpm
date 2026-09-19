// A tandem's results, one column per stand (the column heads in the stand's colour, the running one
// underlined): entry and exit thickness, reduction, roll force, forward slip, damage and failed points of
// each finished stand. The stand running now shows its entry thickness only; the ones to come, dashes.
// One stand: the section stays hidden and the page is as before.
import type { StandResult, TandemStop } from '../mpm/tandem.ts';
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

/** the share of a stand's mass on points that left the grid */
const LOST: [string, (r: StandResult) => string, string] = ['失われた質量', (r) => (r.massLost * 100).toFixed(2), '%'];

/** why the tandem stopped, after stand k (1 = the first) */
const STOP_TEXT: Record<TandemStop, (k: number, r: StandResult | undefined) => string> = {
  stalled: (k) => `#${k} で板が止まった（噛み込めない）`,
  separated: (k) => `#${k} の後で止めた: 板が破断した（厚さを貫く亀裂。実機の板切れと同じく、次のスタンドへは送らない）`,
  lost: (k, r) => `#${k} の後で止めた: 点が格子の外へ出た（失われた質量 ${r ? (r.massLost * 100).toFixed(2) : '—'} %）`,
};

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

  /** the run's stands, the finished ones' results, the stand running (0 first), whether the pass is over, the running stand's entry thickness [m], and why the tandem stopped early */
  update(stands: number, results: StandResult[], current: number, passDone: boolean, h0Now: number | null, stopped: TandemStop | null): void {
    const key = `${stands}|${current}|${results.length}|${passDone}|${h0Now}|${stopped}`;
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
    // points that left the grid: only when a stand lost any
    const rows = results.some((r) => r.massLost > 0) ? [...ROWS, LOST] : ROWS;
    const body = rows.map(([name, value, unit], i) => {
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
    // the tandem stopped before its last stand (src/mpm/tandem.ts, TandemStop)
    const caption = document.createElement('caption');
    caption.className = 'table-note';
    const k = results.length; // the stand it stopped at (1 = the first)
    if (stopped) caption.textContent = `${STOP_TEXT[stopped](k, results[k - 1])}。その先のスタンドは計算していない`;
    this.table.replaceChildren(...(stopped ? [caption] : []), thead, tbody);
  }
}
