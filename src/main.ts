// Page wiring: conditions → worker → roll-bite view, charts, results and the crack record.
import { cloneParams, type SimParams } from './mpm/params.ts';
import { PRESETS, presetById } from './mpm/presets.ts';
import type { Diagnostics, FieldName } from './mpm/solver.ts';
import { css, lattice, split, temper } from './app/colormap.ts';
import { FIELDS, damageLabel, fieldInfo } from './app/fields.ts';
import { Explorer } from './app/explorer.ts';
import { buildExport } from './app/export.ts';
import { buildPanel } from './app/panel.ts';
import type { CrackView, Frame, FromWorker, Geometry, ToWorker } from './app/protocol.ts';
import { applyQuery, stopAfterOf } from './app/query.ts';
import { Overview } from './app/overview.ts';
import { BiteView } from './app/view.ts';
import { attachViewControls } from './app/viewControls.ts';
import { drawForceChart, drawHillChart, slabReference, type ForceChartData } from './app/slabOverlay.ts';

let forceChart: ForceChartData | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const query = new URLSearchParams(location.search);
let presetId = presetById(query.get('preset') ?? '')?.id ?? 'standard';
let params: SimParams = applyQuery(presetById(presetId)!.build(), query);
let field: FieldName = (FIELDS.find((f) => f.id === query.get('field'))?.id ?? 'seq') as FieldName;
const stopAfter = stopAfterOf(query);

const view = new BiteView($<HTMLCanvasElement>('bite'));
const explorer = new Explorer(
  $('explorer'),
  $('locus'),
  (id) => send({ type: 'select', particle: id }),
  () => (dirty = true),
);
$('bite').addEventListener('click', (e) => explorer.select(view.pick(e.clientX, e.clientY)));
const history: { t: number[]; F: number[]; T: number[] } = { t: [], F: [], T: [] };
let geometry: Geometry | null = null;
let last: Frame | null = null;
// mean of the kinetic-energy ratio measured in the steady phase (held after it ends)
let kineticSum = 0;
let kineticN = 0;
let frames = 0;
let running = false;
let dirty = false;
let edited = false;
let awaitingReady = false; // frames of the run a restart replaced may still be on their way
buildExport($('export'), {
  history,
  frame: () => last,
  params: () => params,
  presetId: () => presetId,
  preset: () => presetById(presetId)!.build(),
  bite: $<HTMLCanvasElement>('bite'),
});

// ── view: zoom, pan, overview ───────────────────────────────────────────────
const overview = new Overview($<HTMLCanvasElement>('overview'), view, () => (dirty = true));
attachViewControls({
  canvas: $<HTMLCanvasElement>('bite'),
  toolbar: $('view-tools'),
  view,
  redraw: () => (dirty = true),
  onDirs: (on) => send({ type: 'dirs', on }),
});

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
  b.textContent = f.tab ?? f.label;
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
      awaitingReady = false;
      // new conditions, new picture: back to the default window
      if (!geometry || geometry.h0 !== m.geometry.h0 || geometry.contactLength !== m.geometry.contactLength) view.resetView();
      geometry = m.geometry;
      view.geometry = geometry;
      if (query.get('autorun') === '1' && frames === 0) run();
    } else if (m.type === 'frame') {
      if (!awaitingReady) onFrame(m);
    }
    else if (m.type === 'error') showError(m.message);
  };
  worker.onerror = (e) => showError(e.message);
}

function restart() {
  if (edited) {
    params = panel.read(params);
    panel.show(params); // what runs, after clamping
  }
  edited = false;
  $('reset').classList.remove('pending');
  history.t.length = 0;
  kineticSum = 0;
  kineticN = 0;
  history.F.length = 0;
  history.T.length = 0;
  last = null;
  view.frame = null;
  running = false;
  frames = 0;
  crackSeen = 0;
  $('crack-log').replaceChildren();
  explorer.reset();
  view.marks = [];
  awaitingReady = true;
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
  const done = last?.diag.phase === 'done' || last?.diag.phase === 'stalled';
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
    history.T.push(d.rollTorque * 1e-3);
    if (d.kineticRatio != null) {
      kineticSum += d.kineticRatio;
      kineticN++;
    }
  }
  dirty = true;
  updateButtons();
  updateResults(d, f);
  updateCracks(f.cracks);
  explorer.update(f, params);
  view.marks = explorer.marks();
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
    [params.damage.model === 'none' ? '最大損傷（3 指標の最大）' : '最大損傷', d.maxDamage.toFixed(3), ''],
    // quasi-static: the condition's estimate ρ ms V² r / 2k̄, and what was measured in the steady phase —
    // the kinetic energy the rolls put in per second over the plastic work per second (its mean, kept after)
    ['慣性の見積もり', (d.inertiaRatio * 100).toFixed(1), '%'],
    ['慣性 / 塑性仕事率（定常）', kineticN ? ((kineticSum / kineticN) * 100).toFixed(1) : '—', '%'],
    ['亀裂になった点', String(d.nFailed), '個'],
    ['粒子数', String(d.nActive), '個'],
    ['時間刻み', (d.dt * 1e9).toFixed(1), 'ns'],
    ['1 ステップの計算時間', f.msPerStep ? f.msPerStep.toFixed(2) : '—', 'ms'],
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
    stamp.className = 'stamp pressed';
    stamp.textContent = String(c.id + 1);
    stamp.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'sr-only';
    name.textContent = `亀裂 ${c.id + 1}：`;
    const where = Math.abs(c.sheetY) < 0.15 * params.rolling.h0 ? '板厚中心' : c.sheetY > 0 ? '上面側' : '下面側';
    body.innerHTML = `<strong>${(c.t * 1e3).toFixed(2)} ms　${where}</strong>
      <span>先端から ${(c.sheetX * 1e3).toFixed(2)} mm、中心から ${(c.sheetY * 1e3).toFixed(3)} mm の点</span>
      <span>η ${c.eta.toFixed(2)}　σ1 ${(c.s1 * 1e-6).toFixed(0)} MPa　εp ${c.ep.toFixed(3)}</span>`;
    body.prepend(name);
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
    stops.push(css(info.scale === 'diverging' ? split(info.flip ? 1 - t : t) : info.scale === 'lattice' ? lattice(t) : temper(t)));
  }
  const unit = info.unit ? ` ${info.unit}` : '';
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  $('legend').dataset.field = field; // what it shows (checks wait on this, the tabs may use shorter names)
  $('legend').innerHTML = `
    <div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
    <div class="ends"><span>${info.scale === 'lattice' ? '' : fmt(lo) + unit}</span><span>${field === 'damage' ? damageLabel(params.damage.model) : info.label}</span><span>${info.scale === 'lattice' ? '' : fmt(hi) + unit}</span></div>
    <div class="exag">板厚方向を ${view.state.exaggeration.toFixed(1)} 倍に拡大して表示</div>
    ${last && last.diag.nFailed > 0 ? '<div class="failed-key"><span class="swatch"></span>藍墨の点は亀裂になった点。朱の印は亀裂の番号（右の記録と同じ）</div>' : ''}`;
}

function drawCharts() {
  const g = geometry;
  if (!g) return;
  forceChart = drawForceChart($<HTMLCanvasElement>('chart-force'), $('legend-force'), history.t, history.F, params);
  drawHillChart($<HTMLCanvasElement>('chart-hill'), $('legend-hill'), last?.profile, g.contactLength, last?.diag, params);
  explorer.draw();
}

function frameLoop() {
  try {
    if (dirty) {
      dirty = false;
      view.draw();
      overview.draw();
      drawLegend();
      drawCharts();
    } else if (view.animating()) view.draw(); // a crack's stamp is being pressed
  } finally {
    requestAnimationFrame(frameLoop); // one failing draw must not stop the drawing
  }
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
    return last?.diag.phase === 'done' || last?.diag.phase === 'stalled' || (stopAfter !== null && (last?.diag.step ?? 0) >= stopAfter && !running);
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
  /** the slab method for the running condition, as drawn over the charts */
  get slab() {
    const s = slabReference(params);
    return { force: s.force, torque: s.torque, xNeutral: s.xNeutral, crossed: s.crossed, sticking: s.sticking, tensionAtYield: s.tensionAtYield, outside: s.outside, points: s.p.length };
  },
  /** what the force chart last drew: time [ms], one frame's means and the moving average [kN/mm], the window [ms] */
  get forceChart() {
    return forceChart;
  },
  get explorer() {
    return { role: explorer.shownRole, id: explorer.shown?.id ?? null };
  },
  /** the points the stress explorer follows, with their paths (flat η, εp, D) */
  get tracks() {
    return last?.tracks ?? [];
  },
  /** client coordinates of a material point on the roll-bite canvas (headless checks click there) */
  screenOf: (id: number) => view.screenOf(id),
  /** zoom, pan (m), exaggeration mode and in use, principal directions */
  get view() {
    const s = view.state;
    return { zoom: s.zoom, panX: s.panX, panY: s.panY, exMode: s.exMode, exaggeration: s.exaggeration, dirs: s.dirs, dirsInFrame: !!last?.dirs };
  },
  /** mean time of one roll-bite redraw over n redraws of the current frame [ms] */
  drawMs(n = 20) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) view.draw();
    return (performance.now() - t0) / n;
  },
  /** a crack's stamp is still being pressed onto the sheet */
  get pressing() {
    return view.animating();
  },
  /** press the stamps again, on the sheet and in the record (to capture the moment) */
  pressAgain() {
    view.pressAgain();
    for (const s of document.querySelectorAll<HTMLElement>('#crack-log .stamp')) {
      s.classList.remove('pressed');
      void s.offsetWidth; // restart the CSS animation
      s.classList.add('pressed');
    }
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
