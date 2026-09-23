// The 「条件の比較」 tab (src/app/sweepMode.ts, src/app/sweep.worker.ts), in a headless Chrome:
// - the URL (dim=c, sv, sn, sp, sj) opens the tab with its spec; the panel has the sweep's fieldset and the 3D
//   strip's, not the shared stands and handoff; the stage is the sweep's (the 3D drawing and the section are gone)
// - a real click on 「比較を始める」 rolls three conditions (W 2 mm, 4 cells, the thickness 0.9 → 1.1 mm, two passes)
//   three at once; 一時停止 holds every condition's progress, 「続ける」 goes on; leaving the tab pauses the row
// - at the end the summaries are `node tools/sweep.mjs` 's (the first pass's force and width relative 1e-5, the
//   rest 1 %: as tools/browser/solid.mjs, a later stand amplifies the last bit of Math.exp), the six charts are
//   drawn in the conditions' colours, the table has a row per condition, the CSV a line per condition
// - the URL of the spec opens the same spec; an edit of the panel is taken up by 「条件を反映してやり直す」
// - 700 px: nothing wider than the page
//
//   CDP_PORT=<cdp> node tools/browser/sweep.mjs <url> [out-prefix]
//
// About 4 min (the node run of the same row included). Prints one PASS / FAIL line per item and exits 1 if any
// failed. Look at the pictures (<out-prefix>-*.png).
import { spawnSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/sweep.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;
const SPEC = 'dim=c&W3=2&cells3=4&sv=h0:0.9:1.1&sn=3&sp=2&sj=3';

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const centre = async (selector) => {
    const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    return r;
  };
  const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const click = async (selector) => {
    const r = await centre(selector);
    await mouse('mousePressed', r.x, r.y);
    await mouse('mouseReleased', r.x, r.y);
  };
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const visible = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getBoundingClientRect().height > 0; })()`);
  const shot = async (name) => {
    if (!shots) return;
    await painted();
    await c.screenshot(`${shots}-${name}.png`);
    console.log(`shot  ${shots}-${name}.png`);
  };
  /** the pixels of a chart in colour (not the axes' greys) */
  const coloured = (id) =>
    c.evaluate(`(() => { const cv = document.getElementById(${JSON.stringify(id)}); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) n++; return n; })()`);
  const CHARTS = ['crown', 'force', 'spread', 'profile', 'flat', 'width'].map((k) => `sweep-chart-${k}`);

  // ── the URL opens the tab with its spec
  await c.navigate(page(`/?${SPEC}`));
  await c.waitFor('window.__mpm?.sweep?.active', 30000);
  const spec = await c.evaluate('__mpm.sweep.spec');
  ok(
    (await c.evaluate(`document.body.dataset.dim === 'c' && document.getElementById('dim-tab-c').getAttribute('aria-selected') === 'true'`)) &&
      JSON.stringify(spec.vary) === JSON.stringify({ h0: [0.0009, 0.0011] }) &&
      spec.count === 3 &&
      spec.stands === 2 &&
      spec.handoff === 'steady' &&
      (await c.evaluate('__mpm.sweep.jobs')) === 3,
    'the URL opens the 条件の比較 tab with its spec',
    JSON.stringify(spec),
  );
  const shown = await c.evaluate(`({
    stage: getComputedStyle(document.getElementById('sweep-stage')).display !== 'none',
    solid: !!document.querySelector('section.dim3-only') && [...document.querySelectorAll('section.dim3-only')].every((e) => e.getBoundingClientRect().height === 0),
    bite: document.getElementById('bite').getBoundingClientRect().height === 0,
    width3: document.querySelector('[name="solid-width"], #solid-width')?.getBoundingClientRect().height > 0,
    stands: document.querySelector('[name="stands"]').getBoundingClientRect().height === 0,
    handoff: document.querySelector('[name="handoff"]').getBoundingClientRect().height === 0,
    sweepBox: document.querySelector('[name="sweep-h0"]').checked && document.querySelector('[name="sweep-h0-from"]').value === '0.9' && document.querySelector('[name="sweep-width-from"]').disabled,
  })`);
  ok(Object.values(shown).every(Boolean), 'the stage is the sweep\'s, the panel has its fieldset and the 3D strip\'s, not the shared stands and handoff', JSON.stringify(shown));
  ok((await c.evaluate(`document.getElementById('run').textContent`)) === '比較を始める', 'the button says 比較を始める');
  const before = await Promise.all(CHARTS.map(coloured));
  ok(before.every((n) => n < 20), 'nothing is drawn in colour before the row is rolled', before.join(', '));
  await shot('empty');

  // ── a real click starts the row; 一時停止 holds it
  await click('#run');
  await c.waitFor('__mpm.sweep.running && __mpm.sweep.cases.every((c) => c.state === "running" && c.progress > 0.05)', 120000);
  ok((await c.evaluate('__mpm.sweep.workers')) === 3, 'three conditions at once, a worker each');
  await click('#pause');
  await c.waitFor('!__mpm.sweep.running', 5000);
  // a worker takes the pause up between its slices (150 ms): the slice it is in still reports
  await c.evaluate('new Promise((r) => setTimeout(r, 500))');
  const held = await c.evaluate('__mpm.sweep.cases.map((c) => c.progress)');
  await c.evaluate('new Promise((r) => setTimeout(r, 1500))');
  const still = await c.evaluate('__mpm.sweep.cases.map((c) => c.progress)');
  ok(held.every((p, i) => p === still[i]) && (await c.evaluate(`document.getElementById('run').textContent`)) === '続ける', '一時停止 holds every condition (1.5 s), the button says 続ける', `${held.map((p) => p.toFixed(3))} → ${still.map((p) => p.toFixed(3))}`);
  await shot('paused');
  await click('#run');
  await c.waitFor('__mpm.sweep.running', 5000);
  await c.evaluate('new Promise((r) => setTimeout(r, 1500))');
  const on = await c.evaluate('__mpm.sweep.cases.map((c) => c.progress)');
  ok(on.every((p, i) => p > still[i]), '「続ける」 goes on', on.map((p) => p.toFixed(3)).join(', '));
  // leaving the tab pauses the row; coming back it is still paused
  await click('#dim-tab-2');
  await c.waitFor(`document.body.dataset.dim === '2'`, 5000);
  ok(!(await c.evaluate('__mpm.sweep.running')) && !(await c.evaluate('__mpm.sweep.active')), 'the 2 次元 tab pauses the row');
  await click('#dim-tab-c');
  await c.waitFor('__mpm.sweep.active', 5000);
  ok(!(await c.evaluate('__mpm.sweep.running')) && (await c.evaluate(`document.getElementById('run').textContent`)) === '続ける', 'back on the tab it is paused, to go on with 続ける');
  await click('#run');

  // ── the node run of the same row, while the page rolls
  const t0 = Date.now();
  const node = spawnSync(process.execPath, ['tools/sweep.mjs', '--W', '2', '--cells', '4', '--vary', 'h0=0.9:1.1', '--n', '3', '--stands', '2', '--jobs', '3', '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (node.status !== 0) throw new Error(`tools/sweep.mjs: ${node.stderr}`);
  const want = JSON.parse(node.stdout);
  console.log(`      node tools/sweep.mjs: ${((Date.now() - t0) / 1e3).toFixed(0)} s`);
  await c.waitFor('__mpm.sweep.done', 900000, 500);
  await painted();

  // ── the results
  const got = await c.evaluate('__mpm.sweep.summaries');
  const states = await c.evaluate('__mpm.sweep.cases.map((c) => c.state)');
  ok(states.every((s) => s === 'done') && got.every(Boolean), 'every condition rolled to its last pass', states.join(', '));
  for (let i = 0; i < 3; i++) {
    const g = got[i];
    const w = want.cases[i].summary;
    near(g.force[0], w.force[0], 1e-5, `#${i + 1} pass 1 force = node's`, `${(g.force[0] * 1e-3).toFixed(4)} vs ${(w.force[0] * 1e-3).toFixed(4)} kN`);
    near(g.width[0], w.width[0], 1e-5, `#${i + 1} pass 1 width = node's`);
    near(g.force[1], w.force[1], 0.01, `#${i + 1} pass 2 force = node's within 1 %`, `${(g.force[1] * 1e-3).toFixed(4)} vs ${(w.force[1] * 1e-3).toFixed(4)} kN`);
    near(g.spread, w.spread, 0.01, `#${i + 1} spread = node's within 1 %`, `${(g.spread * 100).toFixed(3)} vs ${(w.spread * 100).toFixed(3)} %`);
  }
  ok(got[2].force[0] > got[0].force[0], 'a thicker strip rolls harder (#3 over #1, pass 1)');
  const after = await Promise.all(CHARTS.map(coloured));
  ok(after.every((n) => n > 50), 'the six charts are drawn in colour', CHARTS.map((id, i) => `${id.slice(12)} ${after[i]}`).join(', '));
  const table = await c.evaluate(`[...document.querySelectorAll('#sweep-table tbody tr')].map((r) => [r.dataset.state, r.textContent])`);
  ok(table.length === 3 && table.every(([s]) => s === 'done'), 'the table has a row per condition, done', table.map(([s, t]) => `${s}: ${t.slice(0, 40)}`).join(' | '));
  const csv = (await c.evaluate('__mpm.sweep.csv()')).trim().split('\n');
  ok(csv.length === 4 && csv[1].split(',').length === csv[0].split(',').length, 'the CSV: a head and a line per condition', csv[0]);
  ok((await c.evaluate(`document.getElementById('run').disabled && document.getElementById('pause').disabled`)) && c.errors.length === 0, 'at the end both buttons are off, no errors', c.errors.join(' | '));
  await shot('done');

  // ── the spec's URL, and an edit
  const url = await c.evaluate('__mpm.sweep.url');
  await c.navigate(page(`/?${url}`));
  await c.waitFor('window.__mpm?.sweep?.active', 30000);
  ok(JSON.stringify(await c.evaluate('__mpm.sweep.spec')) === JSON.stringify(spec), 'the URL of the spec opens the same spec', url);
  await click('[name="sweep-width"]');
  await c.evaluate(`(() => { const i = document.querySelector('[name="sweep-width-to"]'); i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  ok(await c.evaluate(`document.getElementById('reset').classList.contains('pending') && !document.querySelector('[name="sweep-width-to"]').disabled`), 'ticking 板幅 opens its inputs; an edit marks 条件を反映してやり直す');
  await click('#reset');
  const edited = await c.evaluate('__mpm.sweep.spec');
  ok(JSON.stringify(edited.vary) === JSON.stringify({ h0: [0.0009, 0.0011], width: [0.002, 0.003] }) && (await c.evaluate('__mpm.sweep.cases.length')) === 0, 'the reset takes the edit up (the width 2 → 3 mm), the row is empty again', JSON.stringify(edited.vary));
  ok((await c.evaluate('__mpm.sweep.url')).includes('W%3A2%3A3'), '… and the URL has it');

  // ── 700 px
  await c.setViewport(700, 1000);
  await painted();
  const wide = await c.evaluate('document.documentElement.scrollWidth');
  ok(wide <= 700 && (await visible('#sweep-chart-crown')), 'at 700 px nothing is wider than the page', `${wide} px`);
  await shot('narrow');
  await c.setViewport(1600, 1000);
  await c.navigate('about:blank');
} catch (err) {
  ok(false, 'the page', String(err?.stack ?? err));
} finally {
  c?.close();
}
done();
