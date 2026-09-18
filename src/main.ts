// Page wiring: conditions → worker → roll-bite view, charts, results and the crack record.
import { cloneParams, type SimParams } from './mpm/params.ts';
import { PRESETS, presetById } from './mpm/presets.ts';
import type { Diagnostics, FieldName } from './mpm/solver.ts';
import { drawChart } from './app/charts.ts';
import { css, lattice, split, temper } from './app/colormap.ts';
import { FIELDS, fieldInfo } from './app/fields.ts';
import { buildPanel } from './app/panel.ts';
import type { CrackView, Frame, FromWorker, Geometry, ToWorker } from './app/protocol.ts';
import { applyQuery } from './app/query.ts';
import { BiteView } from './app/view.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const query = new URLSearchParams(location.search);
let presetId = presetById(query.get('preset') ?? '')?.id ?? 'standard';
let params: SimParams = applyQuery(presetById(presetId)!.build(), query);
let field: FieldName = (FIELDS.find((f) => f.id === query.get('field'))?.id ?? 'seq') as FieldName;
const stopAfter = query.has('stopafter') ? Math.max(1, parseInt(query.get('stopafter')!, 10)) : null;

const view = new BiteView($<HTMLCanvasElement>('bite'));
const history: { t: number[]; F: number[] } = { t: [], F: [] };
let geometry: Geometry | null = null;
let last: Frame | null = null;
let frames = 0;
let running = false;
let dirty = false;
let edited = false;

// ── conditions ──────────────────────────────────────────────────────────────
const presetSel = $<HTMLSelectElement>('preset');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = p.label;
  presetSel.append(o);
}
presetSel.value = presetId;
const panel = buildPanel($('panel'), () => {
  edited = true;
  $('reset').classList.add('pending');
});
panel.show(params);
const showNote = () => ($('preset-note').textContent = presetById(presetId)?.note ?? '');
showNote();

presetSel.addEventListener('change', () => {
  presetId = presetSel.value;
  params = presetById(presetId)!.build();
  panel.show(params);
  showNote();
  restart();
});

// ── field tabs ──────────────────────────────────────────────────────────────
const tabs = $('field-tabs');
for (const f of FIELDS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = f.label;
  b.setAttribute('role', 'radio');
  b.dataset.field = f.id;
  b.addEventListener('click', () => setField(f.id));
  tabs.append(b);
}
function setField(id: FieldName) {
  field = id;
  for (const b of tabs.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.field === id));
  send({ type: 'field', field });
}

// ── worker ──────────────────────────────────────────────────────────────────
let worker: Worker;
function send(m: ToWorker) {
  worker.postMessage(m);
}

function startWorker() {
  worker = new Worker(new URL('./app/sim.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'ready') {
      geometry = m.geometry;
      view.geometry = geometry;
      if (query.get('autorun') === '1' && frames === 0) run();
    } else if (m.type === 'frame') onFrame(m);
    else if (m.type === 'error') showError(m.message);
  };
  worker.onerror = (e) => showError(e.message);
}

function restart() {
  if (edited) params = panel.read(params);
  edited = false;
  $('reset').classList.remove('pending');
  history.t.length = 0;
  history.F.length = 0;
  last = null;
  view.frame = null;
  running = false;
  frames = 0;
  crackSeen = 0;
  $('crack-log').replaceChildren();
  send({ type: 'init', params: cloneParams(params), field, stopAfter });
  updateButtons();
}

function run() {
  running = true;
  send({ type: 'run' });
  updateButtons();
}

$('run').addEventListener('click', run);
$('pause').addEventListener('click', () => {
  running = false;
  send({ type: 'pause' });
  updateButtons();
});
$('reset').addEventListener('click', restart);

function updateButtons() {
  const done = last?.diag.phase === 'done';
  ($('run') as HTMLButtonElement).disabled = running || done;
  ($('pause') as HTMLButtonElement).disabled = !running;
  $('run').textContent = frames > 1 && !done ? '続ける' : '圧延を始める';
}

// ── frames ──────────────────────────────────────────────────────────────────
function onFrame(f: Frame) {
  last = f;
  frames++;
  running = f.running;
  view.frame = f;
  const d = f.diag;
  if (d.step > 0 && (history.t.length === 0 || d.t * 1e3 > history.t[history.t.length - 1])) {
    history.t.push(d.t * 1e3);
    history.F.push(d.rollForce * 1e-6);
  }
  dirty = true;
  updateButtons();
  updateResults(d, f);
  updateCracks(f.cracks);
}

const phaseText: Record<Diagnostics['phase'], string> = {
  approach: 'ロールに向かっている',
  bite: '噛み込み中',
  steady: '定常圧延',
  'tail-out': '尾端が抜けるところ',
  done: '圧延が終わった',
  stalled: '板が止まった（噛み込めない）',
};

function updateResults(d: Diagnostics, f: Frame) {
  const rows: [string, string, string][] = [
    ['圧延荷重', (d.rollForce * 1e-6).toFixed(3), 'kN/mm'],
    ['圧延トルク', (d.rollTorque * 1e-3).toFixed(3), 'kN·m/m'],
    ['出側板厚', d.exitThickness != null ? (d.exitThickness * 1e3).toFixed(4) : '—', 'mm'],
    ['先進率', d.forwardSlip != null ? (d.forwardSlip * 100).toFixed(2) : '—', '%'],
    ['最大損傷', d.maxDamage.toFixed(3), ''],
    ['亀裂になった点', String(d.nFailed), '個'],
    ['粒子数', String(d.nActive), '個'],
    ['時間刻み', (d.dt * 1e9).toFixed(1), 'ns'],
    ['計算の速さ', f.msPerStep ? f.msPerStep.toFixed(2) : '—', 'ms/step'],
  ];
  const tb = $('results');
  tb.replaceChildren(
    ...rows.map(([k, v, u]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = k;
      const td = document.createElement('td');
      td.textContent = v;
      const tu = document.createElement('td');
      tu.className = 'unit';
      tu.textContent = u;
      tr.append(th, td, tu);
      return tr;
    }),
  );
  $('clock').textContent = `t = ${(d.t * 1e3).toFixed(2)} ms　${d.step.toLocaleString()} step`;
  $('phase').textContent = phaseText[d.phase];
}

let crackSeen = 0;
function updateCracks(cracks: CrackView[]) {
  const ol = $('crack-log');
  if (cracks.length === 0) {
    if (!ol.firstChild) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだ亀裂はない。前方張力を上げる、延性を下げる（D2 を小さく）と生まれやすい。';
      ol.append(li);
    }
    return;
  }
  if (crackSeen === 0) ol.replaceChildren();
  for (let i = crackSeen; i < cracks.length; i++) {
    const c = cracks[i];
    const li = document.createElement('li');
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = String(c.id + 1);
    const body = document.createElement('div');
    const where = Math.abs(c.sheetY) < 0.15 * params.rolling.h0 ? '板厚中心' : c.sheetY > 0 ? '上面側' : '下面側';
    body.innerHTML = `<strong>${(c.t * 1e3).toFixed(2)} ms　${where}</strong>
      <span>先端から ${(c.sheetX * 1e3).toFixed(2)} mm、中心から ${(c.sheetY * 1e3).toFixed(3)} mm の点</span>
      <span>η ${c.eta.toFixed(2)}　σ1 ${(c.s1 * 1e-6).toFixed(0)} MPa　εp ${c.ep.toFixed(3)}</span>`;
    li.append(stamp, body);
    ol.append(li);
  }
  crackSeen = cracks.length;
}

function showError(msg: string) {
  $('phase').textContent = `計算が止まった: ${msg}`;
  running = false;
  updateButtons();
}

// ── drawing ─────────────────────────────────────────────────────────────────
function drawLegend() {
  const info = fieldInfo(field);
  const [lo, hi] = view.state.range;
  const stops: string[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    stops.push(css(info.scale === 'diverging' ? split(t) : info.scale === 'lattice' ? lattice(t) : temper(t)));
  }
  const unit = info.unit ? ` ${info.unit}` : '';
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  $('legend').innerHTML = `
    <div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
    <div class="ends"><span>${info.scale === 'lattice' ? '' : fmt(lo) + unit}</span><span>${info.label}</span><span>${info.scale === 'lattice' ? '' : fmt(hi) + unit}</span></div>
    <div class="exag">板厚方向を ${view.state.exaggeration.toFixed(1)} 倍に拡大して表示</div>`;
}

function drawCharts() {
  const g = geometry;
  if (!g) return;
  drawChart($<HTMLCanvasElement>('chart-force'), {
    xLabel: '時間 [ms]',
    yLabel: '荷重 [kN/mm]',
    series: [{ x: history.t, y: history.F, color: '#1d2a3a', label: '圧延荷重' }],
  });
  const pr = last?.profile;
  const xs = pr ? pr.x.map((x) => x * 1e3) : [];
  drawChart($<HTMLCanvasElement>('chart-hill'), {
    xLabel: '圧延方向の位置 [mm]（出口 = 0）',
    yLabel: '[MPa]',
    series: pr
      ? [
          { x: xs, y: pr.p.map((v) => v * 1e-6), color: '#1f3f7a', label: '圧力 p' },
          { x: xs, y: pr.tau.map((v) => v * 1e-6), color: '#9c4a1c', label: '摩擦応力 τ', dash: [5, 3] },
        ]
      : [],
    marks: [
      { x: -g.contactLength * 1e3, label: '入口' },
      { x: 0, label: '出口' },
    ],
  });
}

function frameLoop() {
  if (dirty) {
    dirty = false;
    view.draw();
    drawLegend();
    drawCharts();
  }
  requestAnimationFrame(frameLoop);
}

const ro = new ResizeObserver(() => {
  view.resize();
  dirty = true;
});
ro.observe($('bite'));

// ── test hook (headless checks read this; see CLAUDE.md) ────────────────────
declare global {
  interface Window {
    __mpm: unknown;
  }
}
window.__mpm = {
  get frames() {
    return frames;
  },
  get running() {
    return running;
  },
  get ready() {
    return geometry !== null;
  },
  get done() {
    return last?.diag.phase === 'done' || (stopAfter !== null && (last?.diag.step ?? 0) >= stopAfter && !running);
  },
  get diag() {
    return last?.diag ?? null;
  },
  get cracks() {
    return last?.cracks ?? [];
  },
  get geometry() {
    return geometry;
  },
  get params() {
    return cloneParams(params);
  },
  history,
  run,
  restart,
  setField,
};

startWorker();
setField(field);
restart();
requestAnimationFrame(frameLoop);
