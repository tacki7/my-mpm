// Saving the results: the force and torque over time, the latest contact pressure
// profile and the crack record as CSV files, the roll bite as a PNG, and a URL that
// starts the same conditions. Everything stays in the browser (downloads and the
// clipboard); nothing is sent anywhere. A tandem's files are on the whole pass's clock
// and end with a column of the stand (1, 2, …); a single pass's are as they were.
import type { SimParams } from '../mpm/params.ts';
import type { Frame } from './protocol.ts';
import { conditionsQuery } from './query.ts';

export interface ExportSources {
  /** stand: the stand of each row (0 = the first) */
  history: { t: number[]; F: number[]; T: number[]; stand: number[] };
  /** stands of the run shown */
  stands(): number;
  frame(): Frame | null;
  /** the conditions of the run shown, its preset and that preset's own conditions */
  params(): SimParams;
  presetId(): string;
  preset(): SimParams;
  /** the roll bite as drawn (a tandem: its stands side by side) */
  bite(): HTMLCanvasElement;
}

/** One CSV: a header row, then the rows (numbers written in full precision). */
export function csv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => (typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export function forceCsv(h: ExportSources['history'], stands = 1): string {
  const tandem = stands > 1;
  return csv(
    ['t_ms', 'force_kN_per_mm', 'torque_kN_m_per_m', ...(tandem ? ['stand'] : [])],
    h.t.map((t, i) => [t, h.F[i], h.T[i], ...(tandem ? [h.stand[i] + 1] : [])]),
  );
}

export function profileCsv(f: Frame): string {
  const p = f.profile;
  return csv(
    ['x_mm', 'pressure_MPa', 'friction_MPa'],
    p.x.map((x, i) => [x * 1e3, p.p[i] * 1e-6, p.tau[i] * 1e-6]),
  );
}

export function cracksCsv(f: Frame): string {
  const tandem = f.stands > 1;
  return csv(
    ['crack', 't_ms', 'step', 'x_mm', 'y_mm', 'from_head_mm', 'from_midplane_mm', 'eta', 's1_MPa', 'seq_MPa', 'ep', 'criterion', 'points', ...(tandem ? ['stand'] : [])],
    f.cracks.map((c) => [
      c.id + 1,
      c.tPass * 1e3,
      c.stepPass,
      c.cx * 1e3,
      c.cy * 1e3,
      c.sheetX * 1e3,
      c.sheetY * 1e3,
      c.eta,
      c.s1 * 1e-6,
      c.seq * 1e-6,
      c.ep,
      c.criterion,
      c.count,
      ...(tandem ? [c.stand + 1] : []),
    ]),
  );
}

export function download(name: string, data: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function buildExport(root: HTMLElement, src: ExportSources): void {
  root.append(el('h2', undefined, '結果の書き出し'));
  const status = el('p', 'export-status');
  status.setAttribute('aria-live', 'polite');
  const say = (text: string) => (status.textContent = text);
  const step = () => {
    const f = src.frame();
    return f ? f.stepOffset + f.diag.step : 0;
  };
  const text = (s: string) => new Blob([s], { type: 'text/csv;charset=utf-8' });

  const buttons = el('div', 'export-buttons');
  const button = (label: string, run: () => void) => {
    const b = el('button', undefined, label);
    b.type = 'button';
    b.addEventListener('click', run);
    buttons.append(b);
    return b;
  };
  button('荷重の推移（CSV）', () => {
    download(`rolling-force-step${step()}.csv`, text(forceCsv(src.history, src.stands())));
    say(`荷重の推移を保存した（${src.history.t.length} 行）`);
  });
  button('圧力分布（CSV）', () => {
    const f = src.frame();
    if (!f) return say('まだ計算していない');
    download(`contact-pressure-step${step()}.csv`, text(profileCsv(f)));
    say('圧力分布を保存した');
  });
  button('亀裂の一覧（CSV）', () => {
    const f = src.frame();
    if (!f) return say('まだ計算していない');
    download(`cracks-step${step()}.csv`, text(cracksCsv(f)));
    say(`亀裂の一覧を保存した（${f.cracks.length} 件）`);
  });
  button('ロールバイト（PNG）', () => {
    src.bite().toBlob((b) => {
      if (!b) return say('画像にできなかった');
      download(`roll-bite-step${step()}.png`, b);
      say('ロールバイトの画像を保存した');
    }, 'image/png');
  });
  root.append(buttons);

  const urlRow = el('div', 'export-url');
  const url = el('input');
  url.type = 'text';
  url.readOnly = true;
  url.id = 'conditions-url';
  url.hidden = true; // shown once there is a URL in it
  url.setAttribute('aria-label', '今の条件で始まる URL');
  const copy = el('button', undefined, '条件の URL をコピー');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const u = new URL(location.href);
    u.search = conditionsQuery(src.presetId(), src.preset(), src.params()).toString();
    url.value = u.href;
    url.hidden = false;
    try {
      await navigator.clipboard.writeText(u.href);
      say('条件の URL をコピーした。開くと同じ条件で始まる');
    } catch {
      url.select();
      say('クリップボードに書けなかった。下の欄の URL を選んでコピーする');
    }
  });
  urlRow.append(copy, url);
  root.append(urlRow, status);
}
