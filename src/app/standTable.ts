// A tandem's results, one column per stand (the column heads in the stand's colour, the running one
// underlined): entry and exit thickness, reduction, roll force, forward slip, damage and failed points of
// each finished stand. The stand running now shows its entry thickness only; the ones to come, dashes.
// Five stands must fit the record column (about 264 px wide by default): each quantity is a line of its own,
// its name and unit across the stands' columns, with its values on the line below, so the width is the numbers'
// alone; the table scrolls sideways by itself if the column is made narrower still.
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
  ['亀裂の点', (r) => String(r.nFailed), '個'],
  // the crack records that started in the stand, and the area (in the section, per unit width) that failed in it:
  // new cracks and older ones growing, not the recount of carried cracks on the next stand's finer lattice
  ['生まれた亀裂', (r) => String(r.cracksBorn), '個'],
  ['伸びた面積', (r) => (r.crackGrowth * 1e6).toFixed(3), 'mm²'],
];

/** the share of a stand's mass on points that left the grid */
const LOST: [string, (r: StandResult) => string, string] = ['失われた質量', (r) => (r.massLost * 100).toFixed(2), '%'];

/** the status line's words for a tandem that stopped at stand k (1 = the first) */
export function stopPhrase(stopped: TandemStop, k: number): string {
  return stopped === 'stalled' ? `#${k} で板が止まった（噛み込めない）` : `#${k} の後で止めた（${stopped === 'separated' ? '板が破断した' : '点が格子の外へ出た'}）`;
}

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

/** a quantity's own line: its name and unit, across the stands' columns (it heads the values' line below) */
function nameRow(name: string, unit: string, stands: number): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'name';
  const th = cell('th', name);
  th.setAttribute('scope', 'rowgroup');
  th.setAttribute('colspan', String(stands));
  if (unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    th.append(' ', u);
  }
  tr.append(th);
  return tr;
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
    for (let k = 0; k < stands; k++) {
      const th = cell('th', `#${k + 1}`, k === current && !passDone ? 'current' : undefined);
      th.style.color = standColor(k);
      th.setAttribute('scope', 'col');
      head.append(th);
    }
    // points that left the grid: only when a stand lost any
    const rows = results.some((r) => r.massLost > 0) ? [...ROWS, LOST] : ROWS;
    const bodies = rows.map(([name, value, unit], i) => {
      const tr = document.createElement('tr');
      tr.className = 'values';
      for (let k = 0; k < stands; k++) {
        const r = results[k];
        // the stand running now: only its entry thickness is known yet
        const now = k !== current ? '—' : i === 0 && h0Now != null ? mm(h0Now) : '…';
        tr.append(cell('td', r ? value(r) : now));
      }
      // a quantity is a group of its two lines
      const tbody = document.createElement('tbody');
      tbody.append(nameRow(name, unit, stands), tr);
      return tbody;
    });
    const thead = document.createElement('thead');
    thead.append(head);
    // under the table: why the tandem stopped before its last stand (src/mpm/tandem.ts, TandemStop), and why a
    // finished stand has no steady values
    const notes: string[] = [];
    const k = results.length; // the stand it stopped at (1 = the first)
    if (stopped) notes.push(`${STOP_TEXT[stopped](k, results[k - 1])}。その先のスタンドは計算していない`);
    const unsteady = results.filter((r) => r.steadyForce == null).map((r) => `#${r.stand + 1}`);
    if (unsteady.length) notes.push(`${unsteady.join('・')} は定常の読みが無い（板が短く、頭端が出口の先に届く前に尾端がバイトに入る）ので、荷重・出側板厚・先進率は —`);
    const caption = document.createElement('caption');
    caption.className = 'table-note';
    caption.textContent = notes.join('。');
    this.table.replaceChildren(...(notes.length ? [caption] : []), thead, ...bodies);
  }
}
