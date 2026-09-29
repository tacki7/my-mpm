// The instrument line at the top of the page: where the workers compute (この Mac / winpc; remote.ts), and how
// busy each machine is — CPU, GPU and memory, read every POLL_MS from this machine's dev server (/__stats,
// vite.config.ts) and the remote server (/stats, tools/remote/server.mjs). The machine that computes is inked;
// the other stays in steel. A machine that does not answer says so (the remote one: how to start it).
import { REMOTE_ADDR, REMOTE_NAME, choosePlace, placeLabel, remote, type Place } from './remote.ts';
import { radioGroup } from './radioGroup.ts';

/** one machine's reading (tools/remote/stats.mjs) */
export interface MachineReading {
  host: string;
  platform: string;
  cores: number;
  /** % over the last second */
  cpu: number;
  memUsed: number;
  memTotal: number;
  gpus: { name: string; util: number; memUsed: number | null; memTotal: number | null }[];
  at: number;
}

const POLL_MS = 1500;
const GB = 2 ** 30;

const readings: Record<Place, MachineReading | null> = { mac: null, winpc: null };
/** the machine answered its last poll */
const up: Record<Place, boolean> = { mac: false, winpc: false };

async function poll(url: string): Promise<MachineReading | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const m = (await r.json()) as MachineReading | null;
    return m && typeof m.cpu === 'number' ? m : null;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** a gauge: a label, a thin bar filled to `pct`, the value in words */
interface Gauge {
  root: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
}

function gauge(label: string): Gauge {
  const root = el('span', 'gauge');
  const fill = el('span', 'gauge-fill');
  const bar = el('span', 'gauge-bar');
  bar.append(fill);
  const value = el('span', 'gauge-value', '—');
  root.append(el('span', 'gauge-label', label), bar, value);
  return { root, fill, value };
}

function setGauge(g: Gauge, pct: number | null, text: string): void {
  g.fill.style.width = pct === null ? '0' : `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  g.value.textContent = text;
  g.root.classList.toggle('high', pct !== null && pct >= 90);
}

const pctText = (v: number) => `${Math.round(v)} %`;
const gbText = (used: number, total: number) => `${(used / GB).toFixed(1)} / ${(total / GB).toFixed(total >= 10 * GB ? 0 : 1)} GB`;

interface MachineRow {
  root: HTMLElement;
  cpu: Gauge;
  gpu: Gauge;
  vram: Gauge;
  mem: Gauge;
  status: HTMLElement;
}

function machineRow(place: Place, name: string): MachineRow {
  const root = el('div', 'machine');
  root.dataset.place = place;
  const title = el('span', 'machine-name', name);
  const cpu = gauge('CPU');
  const gpu = gauge('GPU');
  const vram = gauge('VRAM');
  const mem = gauge('メモリ');
  const status = el('span', 'machine-status');
  root.append(title, cpu.root, gpu.root, vram.root, mem.root, status);
  return { root, cpu, gpu, vram, mem, status };
}

function showRow(row: MachineRow, place: Place): void {
  const m = readings[place];
  row.root.classList.toggle('computing', remote.place === place);
  row.root.classList.toggle('down', !m);
  const parts = [row.cpu, row.gpu, row.vram, row.mem];
  for (const g of parts) g.root.hidden = !m;
  if (!m) {
    row.status.textContent = place === 'winpc' ? `繋がっていない（Mac のターミナルで npm run remote を実行する）` : '読めない（開発サーバで開くと出る）';
    row.status.title = `${REMOTE_ADDR} の計算サーバが答えない`;
    row.status.hidden = false;
    return;
  }
  row.status.hidden = true;
  setGauge(row.cpu, m.cpu, pctText(m.cpu));
  row.cpu.root.title = `CPU の使用率（${m.cores} 論理コアの平均）`;
  const g = m.gpus[0];
  row.gpu.root.hidden = !g;
  if (g) {
    setGauge(row.gpu, g.util, pctText(g.util));
    row.gpu.root.title = `${g.name} の使用率`;
  }
  // a discrete GPU's own memory; Apple silicon's GPU shares the machine's (no total of its own)
  const vram = g && g.memTotal ? g : null;
  row.vram.root.hidden = !vram;
  if (vram) {
    setGauge(row.vram, (100 * (vram.memUsed ?? 0)) / vram.memTotal!, gbText(vram.memUsed ?? 0, vram.memTotal!));
    row.vram.root.title = `${vram.name} の専用メモリ`;
  }
  setGauge(row.mem, (100 * m.memUsed) / m.memTotal, gbText(m.memUsed, m.memTotal));
  row.mem.root.title = '使っているメモリ / 積んでいるメモリ';
}

/** the line, into `root` (the masthead's first row); the readings start at once */
export function mountMachines(root: HTMLElement): void {
  root.replaceChildren();
  const where = el('div', 'place');
  where.setAttribute('role', 'radiogroup');
  where.setAttribute('aria-label', '計算する場所');
  where.append(el('span', 'place-label', '計算する場所'));
  for (const [p, label, title] of [
    ['mac', 'この Mac', 'このブラウザのワーカーで計算する'],
    ['winpc', REMOTE_NAME, `${REMOTE_NAME} で計算する（CPU のスレッドと GPU は ${REMOTE_NAME} のもの）。ページを開き直して、計算はやり直しになる`],
  ] as [Place, string, string][]) {
    const b = el('button', undefined, label);
    b.type = 'button';
    b.title = title;
    b.dataset.place = p;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(remote.place === p));
    b.addEventListener('click', () => {
      if (p !== remote.place || remote.note) choosePlace(p);
    });
    where.append(b);
  }
  radioGroup(where);
  const rows: Record<Place, MachineRow> = { mac: machineRow('mac', 'この Mac'), winpc: machineRow('winpc', REMOTE_NAME) };
  const note = el('span', 'place-note');
  // only when the page could not compute where it was asked to (the ink dot marks the machine that computes)
  note.textContent = remote.note ?? '';
  note.hidden = !remote.note;
  note.classList.add('warn');
  where.title = `${placeLabel()}で計算している`;
  root.append(where, rows.mac.root, rows.winpc.root, note);

  const tick = async () => {
    if (!document.hidden) {
      const [mac, win] = await Promise.all([poll('/__stats'), poll(`http://${REMOTE_ADDR}/stats`)]);
      readings.mac = mac;
      readings.winpc = win;
      up.mac = !!mac;
      up.winpc = !!win;
      showRow(rows.mac, 'mac');
      showRow(rows.winpc, 'winpc');
    }
    setTimeout(tick, POLL_MS);
  };
  showRow(rows.mac, 'mac');
  showRow(rows.winpc, 'winpc');
  void tick();
}

/** for headless checks (window.__mpm.machines) */
export function machinesState() {
  return { place: remote.place, want: remote.note ? REMOTE_NAME : remote.place, note: remote.note, hello: remote.hello, readings: { ...readings }, up: { ...up } };
}
