// Page wiring: conditions → worker → roll-bite view, charts, results and the crack record.
import { cloneParams, type SimParams } from './mpm/params.ts';
import { PRESETS, presetById } from './mpm/presets.ts';
import type { Diagnostics, FieldName } from './mpm/solver.ts';
import { css, lattice, split, temper } from './app/colormap.ts';
import { FIELDS, damageLabel, fieldInfo } from './app/fields.ts';
import { Explorer } from './app/explorer.ts';
import { buildExport } from './app/export.ts';
import { buildPanel } from './app/panel.ts';
import { setupSplitters } from './app/splitters.ts';
import type { CrackView, Frame, FromWorker, Geometry, ToWorker } from './app/protocol.ts';
import { applyQuery, stopAfterOf } from './app/query.ts';
import { Overview } from './app/overview.ts';
import { PlanMode } from './app/planMode.ts';
import { BiteView } from './app/view.ts';
import { StandViews } from './app/standViews.ts';
import { StandTable, stopPhrase } from './app/standTable.ts';
import { passReadout, readoutKind, readoutNote } from './app/passReadout.ts';
import { BurstHint } from './app/burstHint.ts';
import type { StandResult } from './mpm/tandem.ts';
import { attachViewControls } from './app/viewControls.ts';
import { attachKeyPick } from './app/keyPick.ts';
import { ChartSummary } from './app/chartSummary.ts';
import { PresetNote } from './app/presetNote.ts';
import { radioGroup } from './app/radioGroup.ts';
import { say } from './app/liveText.ts';
import { SteadyForce, SteadyProfile, drawForceChart, drawHillChart, slabRatio, slabReference, type ForceChartData, type StandStart } from './app/slabOverlay.ts';

let forceChart: ForceChartData | null = null;
const steadyForce = new SteadyForce();
/** the friction hill over the steady phase of the stand on show (it stays after the sheet has left the rolls) */
const steadyProfile = new SteadyProfile();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const query = new URLSearchParams(location.search);
let presetId = presetById(query.get('preset') ?? '')?.id ?? 'standard';
let params: SimParams = applyQuery(presetById(presetId)!.build(), query);
let field: FieldName = (FIELDS.find((f) => f.id === query.get('field'))?.id ?? 'seq') as FieldName;
const stopAfter = stopAfterOf(query);

const view = new BiteView($<HTMLCanvasElement>('bite'));
// a tandem's stands side by side (one stand: unused)
const standViews = new StandViews(document.querySelector<HTMLElement>('.bite')!, view, $<HTMLCanvasElement>('bite'));
/** stands of the run shown, and the finished stands' results */
let runStands = 1;
let standResults: StandResult[] = [];
/** a tandem: when each stand began on the pass's clock [ms] and its condition (its entry thickness) */
let standStarts: StandStart[] = [];
/** a tandem: each stand's geometry, as the worker sent it (the first on 'ready', the next with each stand's end) */
let standGeometries: Geometry[] = [];
const burstHint = new BurstHint($('burst-hint'));
const standTable = new StandTable($('stand-results-section'), $('stand-results'));
/** a stand that begins on the pass's clock at t0 [ms] with entry thickness h0: the run's conditions with that h0,
 * and the strain of the stands before for the slab method (plane strain from the thickness) */
const standStart = (t0: number, h0: number): StandStart => {
  const P = cloneParams(params);
  P.rolling.h0 = h0;
  return { t0, P, ep0: (2 / Math.sqrt(3)) * Math.log(params.rolling.h0 / h0) };
};
const explorer = new Explorer(
  $('explorer'),
  $('locus'),
  (id) => send({ type: 'select', particle: id, stand: view.frame?.stand ?? 0 }),
  () => (dirty = true),
);
$('bite').addEventListener('click', (e) => explorer.select(view.pick(e.clientX, e.clientY)));
attachKeyPick($<HTMLCanvasElement>('bite'), view, (id) => explorer.select(id));
const chartSummary = new ChartSummary($('chart-force').parentElement!, $('chart-hill').parentElement!, $('locus'));
// t is the whole pass's time (the stands one after the other), stand the stand of each point (0 first)
const history: { t: number[]; F: number[]; T: number[]; stand: number[] } = { t: [], F: [], T: [], stand: [] };
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
  stands: () => runStands,
  frame: () => last,
  params: () => params,
  presetId: () => presetId,
  preset: () => presetById(presetId)!.build(),
  bite: () => standViews.image(),
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
// the preset's note shows three lines; its button 続きを読む shows the rest
const presetNote = new PresetNote($('preset-note'));
const showNote = () => presetNote.show(presetById(presetId)?.note ?? '');
showNote();

// the plan view (板幅方向): its own worker and picture; the shared buttons go to it while it is shown.
// Both views run the same conditions (params): 「条件を反映してやり直す」 and a preset restart both, and
// switching views never applies the panel's pending edits.
const plan = new PlanMode(
  {
    query,
    panelRoot: $('panel'),
    conditions: () => params,
    presetId: () => presetId,
    preset: () => presetById(presetId)!.build(),
    onEdit: () => {
      edited = true;
      $('reset').classList.add('pending');
    },
    onMode: (mode) => {
      if (mode === 'plan' && running) {
        running = false;
        send({ type: 'pause' });
      }
      if (mode === 'section') showClock();
      updateButtons();
      dirty = true;
    },
  },
  stopAfter,
);

presetSel.addEventListener('change', () => {
  presetId = presetSel.value;
  params = presetById(presetId)!.build();
  panel.show(params);
  showNote();
  restart();
  plan.applyConditions(params);
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
radioGroup(tabs);
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
      standGeometries = [geometry];
      standViews.setup(runStands, geometry);
      if (query.get('autorun') === '1' && frames === 0 && !plan.active) run();
    } else if (m.type === 'frame') {
      if (!awaitingReady) onFrame(m);
    } else if (m.type === 'stand') {
      if (awaitingReady) return;
      // a stand is over: its slot keeps its last frame, the live view goes on with the next stand
      standViews.hold(m.stand, m.frame, m.geometry);
      standResults[m.stand] = m.result;
      updateStandTable();
      if (m.next && !m.refresh) {
        standGeometries[m.stand + 1] = m.next;
        geometry = m.next;
        view.geometry = m.next;
        standViews.setCurrent(m.stand + 1);
        steadyForce.reset(); // the steady force, the friction hill and the inertia ratio of the stand on show
        steadyProfile.reset();
        kineticSum = 0;
        kineticN = 0;
        // no sheet until the next stand's first frame (the last one would be drawn in the new stand's rolls)
        view.frame = null;
      } else {
        if (!m.next && !m.refresh) standViews.finish();
        view.frame = standViews.liveFrame(last); // the pass is over: the last stand's kept picture
      }
      dirty = true;
    }
    else if (m.type === 'error') showError(m.message);
  };
  worker.onerror = (e) => showError(e.message);
}

/** the panel's edits into params (what runs, after clamping) */
function readConditions() {
  if (edited) {
    params = panel.read(params);
    panel.show(params);
  }
  edited = false;
  $('reset').classList.remove('pending');
}

function restart() {
  readConditions();
  history.t.length = 0;
  kineticSum = 0;
  kineticN = 0;
  history.F.length = 0;
  history.T.length = 0;
  history.stand.length = 0;
  runStands = params.rolling.stands ?? 1;
  standResults = [];
  standStarts = [];
  steadyForce.reset();
  steadyProfile.reset();
  chartSummary.clear();
  last = null;
  view.frame = null;
  running = false;
  frames = 0;
  crackSeen = 0;
  $('crack-log').replaceChildren();
  explorer.reset();
  view.marks = [];
  awaitingReady = true;
  send({ type: 'init', params: cloneParams(params), stands: runStands, field, stopAfter });
  updateButtons();
}

function run() {
  running = true;
  send({ type: 'run' });
  updateButtons();
}

$('run').addEventListener('click', () => (plan.active ? plan.run() : run()));
$('pause').addEventListener('click', () => {
  if (plan.active) return plan.pause();
  running = false;
  send({ type: 'pause' });
  updateButtons();
});
$('reset').addEventListener('click', () => {
  // the new conditions go to both views; only the one shown runs
  restart();
  plan.applyConditions(params);
});

function updateButtons() {
  if (plan.active) return plan.updateButtons();
  const done = !!last?.passDone;
  ($('run') as HTMLButtonElement).disabled = running || done;
  ($('pause') as HTMLButtonElement).disabled = !running;
  $('run').textContent = frames > 1 && !done ? '続ける' : '圧延を始める';
}

// ── frames ──────────────────────────────────────────────────────────────────
function onFrame(f: Frame) {
  last = f;
  if (runStands > 1 && geometry && standStarts.length <= f.stand) standStarts.push(standStart(f.tOffset * 1e3, geometry.h0));
  frames++;
  running = f.running;
  view.frame = standViews.liveFrame(f);
  const d = f.diag;
  const tPass = (f.tOffset + d.t) * 1e3;
  if (d.step > 0 && (history.t.length === 0 || tPass > history.t[history.t.length - 1])) {
    history.t.push(tPass);
    history.stand.push(f.stand);
    history.F.push(d.rollForce * 1e-6);
    history.T.push(d.rollTorque * 1e-3);
    steadyForce.add(d);
    steadyProfile.add(f.profile, d);
    if (d.kineticRatio != null) {
      kineticSum += d.kineticRatio;
      kineticN++;
    }
  }
  dirty = true;
  updateButtons();
  updateResults(d, f);
  updateStandTable();
  updateCracks(f.cracks);
  explorer.update(f, params);
  view.marks = explorer.marks();
  // the charts' words for a screen reader: when the steady reading comes and at the end of the pass
  chartSummary.update(f.passDone ? 'done' : steadyForce.mean != null ? `steady ${f.stand}` : null, runStands, () => {
    const s = standStarts[f.stand];
    return { force: steadyForce.mean, slab: slabReference(s?.P ?? params, s?.ep0), profile: steadyProfile.mean, point: explorer.shown };
  });
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
  // the load, torque, exit thickness and slip: the steady means once there are any (they stay after the pass)
  const pass = passReadout(d, f.steady);
  $('results-note').textContent = readoutNote(readoutKind(d, f.steady));
  // the shape against the central-burst map (the stand on show's entry thickness), and the mid-plane η measured
  burstHint.update(standStarts[f.stand]?.P ?? params, f.midEta);
  const rows: [string, string, string][] = [
    ...pass.map((r): [string, string, string] => [r.label, r.text, r.unit]),
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
    ...rows.map(([k, v, u], i) => {
      const tr = document.createElement('tr');
      const r = pass[i];
      if (r) {
        // checks read the full value
        tr.dataset.key = r.key;
        tr.dataset.value = r.value != null ? String(r.value) : '';
        tr.dataset.steady = r.steady ? '1' : '0';
      }
      const th = document.createElement('th');
      th.scope = 'row';
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
  showClock();
  // a tandem that stopped before its last stand says why here too
  say($('phase'), f.stopped ? stopPhrase(f.stopped, f.results.length) : phaseText[d.phase]);
}

/** a tandem: the stands' table (one stand: hidden) */
function updateStandTable() {
  standTable.update(runStands, standResults, last?.stand ?? 0, !!last?.passDone, geometry?.h0 ?? null, last?.stopped ?? null);
}

/** the shared clock, from the section model's last frame, while the section view is shown */
function showClock() {
  if (plan.active) return;
  const d = last?.diag;
  const t = (last?.tOffset ?? 0) + (d?.t ?? 0);
  const step = (last?.stepOffset ?? 0) + (d?.step ?? 0);
  const stand = runStands > 1 ? `　スタンド ${(last?.stand ?? 0) + 1} / ${runStands}` : '';
  $('clock').textContent = `t = ${(t * 1e3).toFixed(2)} ms　${step.toLocaleString()} step${stand}`;
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
    // sheetY is measured in the entry sheet of the stand it started in
    const h0 = standResults[c.stand]?.h0 ?? (runStands > 1 && geometry ? geometry.h0 : params.rolling.h0);
    const where = Math.abs(c.sheetY) < 0.15 * h0 ? '板厚中心' : c.sheetY > 0 ? '上面側' : '下面側';
    const stand = runStands > 1 ? `#${c.stand + 1}　` : '';
    body.innerHTML = `<strong>${stand}${(c.tPass * 1e3).toFixed(2)} ms　${where}</strong>
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
  // a tandem: each stand's slab level and mark; the friction hill of the stand on show
  const shown = standStarts[last?.stand ?? 0];
  forceChart = drawForceChart($<HTMLCanvasElement>('chart-force'), $('legend-force'), history.t, history.F, params, steadyForce.mean, runStands > 1 ? standStarts : undefined);
  drawHillChart($<HTMLCanvasElement>('chart-hill'), $('legend-hill'), last?.profile, g.contactLength, last?.diag, shown?.P ?? params, shown?.ep0, steadyProfile.mean);
  explorer.draw();
}

function frameLoop() {
  try {
    if (dirty) {
      dirty = false;
      standViews.prepare();
      view.draw();
      standViews.draw();
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
  standViews.resize();
  dirty = true;
});
ro.observe($('bite'));
// the panes' boundaries can be dragged; the charts redraw at their new size (the bite has its observer)
setupSplitters(() => {
  dirty = true;
});

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
    return !!last?.passDone || (stopAfter !== null && (last?.stepOffset ?? 0) + (last?.diag.step ?? 0) >= stopAfter && !running);
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
  /** the slab method for the running condition (a tandem: the stand on show), as drawn over the charts; Δ, and MPM / slab over the steady phase (null before it) */
  get slab() {
    const shown = standStarts[last?.stand ?? 0];
    const s = slabReference(shown?.P ?? params, shown?.ep0);
    return {
      force: s.force,
      torque: s.torque,
      xNeutral: s.xNeutral,
      crossed: s.crossed,
      sticking: s.sticking,
      tensionAtYield: s.tensionAtYield,
      outside: s.outside,
      points: s.p.length,
      delta: s.delta,
      steadyForce: steadyForce.mean,
      ratio: slabRatio(s, steadyForce.mean),
    };
  },
  /** the friction hill: the frame's profile and the steady phase's mean (null before it), x [m], p and τ [Pa] */
  get hill() {
    const m = steadyProfile.mean;
    const copy = (pr: { x: ArrayLike<number>; p: ArrayLike<number>; tau: ArrayLike<number> }) => ({ x: Array.from(pr.x), p: Array.from(pr.p), tau: Array.from(pr.tau) });
    return { frame: last ? copy(last.profile) : null, steady: m ? copy(m) : null };
  },
  /** what the force chart last drew: time [ms], one frame's means and the moving average [kN/mm], the window [ms] */
  get forceChart() {
    return forceChart;
  },
  get explorer() {
    return { role: explorer.shownRole, id: explorer.shown?.id ?? null };
  },
  /** the tandem: the stand on show (0 first), the stands of the run, the finished stands' results */
  get stand() {
    return last?.stand ?? 0;
  },
  get stands() {
    return runStands;
  },
  get standResults() {
    return standResults.map((r) => ({ ...r }));
  },
  /** what the roll bite is drawing: the stand of its frame (null: no sheet) and the stand of its geometry (the rolls) */
  get drawn() {
    const g = view.geometry;
    return { frameStand: view.frame ? view.frame.stand : null, geometryStand: g ? standGeometries.indexOf(g) : null };
  },
  /** why the tandem stopped before its last stand ('stalled' | 'separated' | 'lost'), null otherwise */
  get stopped() {
    return last?.stopped ?? null;
  },
  /** the pictures side by side: each slot's stand, the field and step of the frame it holds (null: none yet), live or held */
  get standFrames() {
    return standViews.hook();
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
  /** the plan view (板幅方向; tools/browser/planview.mjs) */
  plan: plan.hook(),
};

startWorker();
setField(field);
restart();
requestAnimationFrame(frameLoop);
if (query.get('view') === 'plan') plan.setMode('plan');
