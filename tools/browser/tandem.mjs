// A tandem on the page, in a headless Chrome: `?stands=3` rolls the sheet through three stands with a
// real click on the run button, to the end; the page's per-stand results equal `node tools/tandem.mjs`
// for the same condition (below: the first stand closely, the later ones within the spread); the three pictures sit side
// by side, each showing its own stand in the steady phase, and a field tab or the principal directions
// redraw the finished ones too; the stress explorer's loading path runs through the three stands (numbered, a
// colour each, in the legend); the force chart has a slab level per stand; the table has a column per
// stand; the CSV files are downloaded with a stand column on the whole pass's clock, and the PNG holds
// the three pictures; real mouse events on the running stand's slot zoom, reset and pick a point; moving a boundary between the panes resizes the slots with the roll bite; a narrow
// screen (700 px) stacks the pictures without a sideways scroll; a strip broken through the thickness
// stops the tandem with the reason in the table and the status; five stands' table fits the record column at
// 1600 and 700 px; the stands field is the section view's only; and back
// to one stand, the page is as before (no slots, no table). Not a `@check` (it needs the dev server and
// Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/tandem.mjs <url> <out-dir>
//
// <out-dir> (a new, empty directory) gets the downloads and tandem.png, tandem-eta.png, tandem-narrow.png,
// tandem-5-1600.png and tandem-5-700.png (five stands' table);
// look at the pictures. About 5.5 minutes: run it with the CPU lock.
//
// The page and the tool do not agree bit for bit: Chrome's and Node's V8 round exp, log and atan2 differently
// in the last bit (tools/browser/planview.mjs). Over the first stand that grows to about 1e-7 in its results,
// and the second stand starts from states that differ by that much. The pass magnifies such a difference a
// great deal: in Node alone, h0 × (1 + 1e-7) moves the results of the three stands (standard, 6 cells, L 8 mm;
// Node 24, 2026-09-19) by up to 1.1e-3 in the steady force, 1.3e-4 in the exit thickness, 1.9e-5 in the
// thickness let out and 2.6e-2 in the forward slip of stands 2 and 3 (5.5e-4, 5.6e-5, 6.8e-6 and 0.13 in the
// first), with the same steps. Stepping the tandem as the worker does (its reads every 20 to 60 steps, the
// tracker, the page's params) gives the tool's results bit for bit, so the spread is not the page's doing.
// So the first stand must agree to 1e-5 (its steps and points exactly), and the later ones within twice that
// spread (their steps within one reading, 2000 steps: where the tail crosses between two readings may move).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';
import { DAMAGE_4340 } from '../../src/mpm/params.ts';

const [target, dir] = process.argv.slice(2);
if (!target || !dir || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/tandem.mjs <url> <out-dir>');
  process.exit(64);
}
mkdirSync(dir, { recursive: true });
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const STANDS = 3;
const COND = ['--cells', '6', '--L', '8'];

/** real mouse events on the running stand's slot (also run on a short tandem by hand to calibrate) */
async function mouseChecks(c) {
  const centre = await c.evaluate(`(() => { const b = document.getElementById('bite').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
  const under = await c.evaluate(`document.elementFromPoint(${centre.x}, ${centre.y})?.id || document.elementFromPoint(${centre.x}, ${centre.y})?.className || ''`);
  ok(under === 'bite', "what is under the running stand's slot is the live canvas #bite", under);
  const z0 = await c.evaluate('__mpm.view.zoom');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: -600 });
  await c.waitFor(`__mpm.view.zoom > ${z0} * 1.3`, 5000).catch(() => {});
  const z1 = await c.evaluate('__mpm.view.zoom');
  ok(z1 > z0 * 1.3, 'a real wheel on the slot zooms', `${z0.toFixed(2)} → ${z1.toFixed(2)}`);
  // while zoomed in: a point near the slot's centre that is the nearest, by a pixel or more, to the whole pixel it is
  // clicked at (a later stand's points can sit 1–2 px apart on screen, and a click lands on whole pixels)
  const pick = await c.evaluate(`(() => {
    const b = document.getElementById('bite').getBoundingClientRect();
    const all = [];
    for (let id = 0; ; id++) { const s = __mpm.screenOf(id); if (!s) break; all.push(s); }
    for (let id = 0; id < all.length; id++) {
      const s = all[id];
      if (Math.abs(s.x - (b.x + b.width / 2)) > b.width / 5 || Math.abs(s.y - (b.y + b.height / 2)) > b.height / 5) continue;
      const x = Math.round(s.x), y = Math.round(s.y);
      const d = Math.hypot(s.x - x, s.y - y);
      if (all.every((o, j) => j === id || Math.hypot(o.x - x, o.y - y) >= d + 1)) return { id, x, y };
    }
    return null;
  })()`);
  if (pick) for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: pick.x, y: pick.y, button: 'left', clickCount: 1 });
  let shown = !!pick;
  if (pick) await c.waitFor(`__mpm.explorer.role === 'selected' && __mpm.explorer.id === ${pick.id}`, 5000).catch(() => (shown = false));
  ok(shown, 'a real click on a point of the slot shows that point in the explorer', pick ? `point ${pick.id}, explorer ${JSON.stringify(await c.evaluate('__mpm.explorer'))}` : 'no point on its own near the centre');
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: centre.x, y: centre.y, button: 'left', clickCount: 2 });
  await c.waitFor('__mpm.view.zoom === 1', 5000).catch(() => {});
  ok(z1 > z0 * 1.3 && (await c.evaluate('__mpm.view.zoom')) === 1, 'a real double click resets the zoomed view');
}

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  const click = async (selector) => {
    const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const saved = async (name, timeout = 20000) => {
    const f = join(dir, name);
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < timeout) {
      if (existsSync(f)) {
        const n = statSync(f).size;
        if (n > 0 && n === last) return f;
        last = n;
      }
      await c.sleep(100);
    }
    return null;
  };
  const press = (label) => c.evaluate(`[...document.querySelectorAll('#export button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  const slots = () => c.evaluate('JSON.parse(JSON.stringify(__mpm.standFrames))');

  // ── three stands, from a real click to the end
  await c.navigate(page(`?stands=${STANDS}&cells=6&L=8`));
  await c.waitFor('window.__mpm?.ready', 30000);
  ok((await c.evaluate('__mpm.params.rolling.stands')) === STANDS && (await c.evaluate('__mpm.stands')) === STANDS, `?stands=${STANDS} reaches the conditions and the page`);
  const before = await slots();
  ok(before.length === STANDS && before[0].live && before.slice(1).every((s) => s.field === null), 'a slot per stand; the first is live, the others empty', before.map((s) => `#${s.stand + 1} ${s.live ? 'live' : s.field ?? '—'}`).join(', '));
  const labels = await c.evaluate(`[...document.querySelectorAll('.stand-label')].map((e) => e.textContent)`);
  ok(labels.join('|') === '#1（計算中）|#2（まだ）|#3（まだ）', 'the slots are labelled', labels.join(' '));
  await click('#run');
  await c.waitFor('__mpm.done', 600000);
  await painted();

  const page3 = await c.evaluate('__mpm.standResults');
  ok(page3.length === STANDS && page3.every((r) => r.phase === 'done'), `all ${STANDS} stands end 'done'`, page3.map((r) => r.phase).join(', '));
  ok(page3.slice(1).every((r, k) => r.h0 === page3[k].thicknessOut && r.h0 < page3[k].h0), 'each stand starts with the sheet the stand before let out, thinner', page3.map((r) => (r.h0 * 1e3).toFixed(4)).join(' → '));

  // ── the tool, same condition
  const tool = JSON.parse(execFileSync('node', ['tools/tandem.mjs', '--stands', String(STANDS), ...COND, '--json'], { encoding: 'utf8' })).stand;
  ok(
    tool.length === page3.length && tool.every((r, k) => r.particles === page3[k].particles && Math.abs(r.steps - page3[k].steps) <= (k === 0 ? 0 : 2000)),
    'page = tool: the same stands and points; the steps the same in the first stand, within one reading after',
    page3.map((r, k) => `#${k + 1} ${r.steps}/${tool[k]?.steps} steps`).join(', '),
  );
  // tolerances: the first stand, and twice the spread from h0 × (1 + 1e-7) in the stands after (above)
  const TOL = [
    { force: 1e-5, exit: 1e-5, out: 1e-5, slip: 1e-4 },
    { force: 2e-3, exit: 3e-4, out: 5e-5, slip: 5e-2 },
  ];
  for (let k = 0; k < Math.min(tool.length, page3.length); k++) {
    const p = page3[k];
    const t = tool[k];
    const tol = TOL[Math.min(k, 1)];
    near(p.steadyForce, t.steadyForce, tol.force, `page = tool: #${k + 1} steady force (${(t.steadyForce * 1e-6).toFixed(3)} kN/mm)`);
    near(p.exitThickness, t.exitThickness, tol.exit, `page = tool: #${k + 1} exit thickness`);
    near(p.thicknessOut, t.thicknessOut, tol.out, `page = tool: #${k + 1} thickness let out`);
    near(p.forwardSlip, t.forwardSlip, tol.slip, `page = tool: #${k + 1} forward slip`);
  }

  // ── the table: a column per stand, its force
  const table = await c.evaluate(`({ hidden: document.getElementById('stand-results-section').hidden, head: [...document.querySelectorAll('#stand-results thead th')].map((e) => e.textContent), force: [...document.querySelectorAll('#stand-results tbody')].find((g) => g.querySelector('tr.name th').textContent.startsWith('圧延荷重'))?.querySelector('tr.values')?.textContent ?? '' })`);
  const forces = page3.map((r) => (r.steadyForce * 1e-6).toFixed(2));
  ok(!table.hidden && table.head.filter(Boolean).join(' ') === '#1 #2 #3' && forces.every((f) => table.force.includes(f)), 'the table has a column per stand with its steady force', `${table.head.filter(Boolean).join(' ')}: ${table.force}`);

  // ── the pictures side by side
  const after = await slots();
  ok(
    after.every((s, k) => s.field === 'seq' && s.phase === 'steady' && s.step < page3[k].steps) && after[STANDS - 1].live,
    "every slot shows its own stand's picture from the steady phase (the last one in the live canvas)",
    after.map((s, k) => `#${s.stand + 1} ${s.phase} step ${s.step} of ${page3[k].steps}`).join(', '),
  );
  ok((await c.evaluate('__mpm.diag.phase')) === 'done', "the page's numbers stay those of the end", await c.evaluate('__mpm.diag.phase'));
  const endLabels = await c.evaluate(`[...document.querySelectorAll('.stand-label')].map((e) => e.textContent)`);
  ok(endLabels.join('|') === '#1|#2|#3', 'the pass over, no stand is labelled as running', endLabels.join(' '));
  const widths = after.map((s) => s.width);
  const biteW = await c.evaluate(`document.querySelector('.bite').getBoundingClientRect().width`);
  ok(widths.every((w) => Math.abs(w - biteW / STANDS) < 4), 'the pictures share the width of the roll bite', `${widths.map((w) => w.toFixed(0)).join(' / ')} px of ${biteW.toFixed(0)}`);
  const inked = await c.evaluate(`[...document.querySelectorAll('.stand-slot canvas:not([hidden])')].map((cv) => { const x = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; const seen = new Set(); for (let i = 0; i < x.length; i += 4 * 97) seen.add((x[i] << 16) | (x[i + 1] << 8) | x[i + 2]); return seen.size; })`);
  ok(inked.length === STANDS && inked.every((n) => n > 20), 'every picture is drawn (colours on each canvas)', inked.join(' / '));
  await c.screenshot(join(dir, 'tandem.png'));
  console.log(`shot  ${join(dir, 'tandem.png')}`);

  // ── the running stand's slot takes the mouse, not the stand's own canvas hidden under the live one (it did,
  //    while `.bite canvas { display: block }` overrode [hidden]): what is under the slot's centre is #bite, a real
  //    wheel zooms, a real double click resets, and a real click on a point shows it in the explorer
  await mouseChecks(c);
  // ── a boundary moved (src/app/splitters.ts): the slots follow the roll bite's new width and are drawn again
  const key = (k) => c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39 }[k] });
  await c.evaluate("document.querySelector('.split-right').focus()");
  for (let i = 0; i < 4; i++) await key('ArrowRight');
  await painted();
  await painted();
  const moved = await slots();
  const biteW2 = await c.evaluate(`document.querySelector('.bite').getBoundingClientRect().width`);
  const inked2 = await c.evaluate(`[...document.querySelectorAll('.stand-slot canvas:not([hidden])')].map((cv) => { const x = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; const seen = new Set(); for (let i = 0; i < x.length; i += 4 * 97) seen.add((x[i] << 16) | (x[i + 1] << 8) | x[i + 2]); return [cv.width, Math.round(cv.getBoundingClientRect().width * devicePixelRatio), seen.size]; })`);
  ok(
    biteW2 > biteW + 30 && moved.every((s) => Math.abs(s.width - biteW2 / STANDS) < 4) && inked2.every(([w, css, n]) => Math.abs(w - css) <= 1 && n > 20),
    'the record narrowed by the right boundary: the slots share the wider roll bite and are drawn again at their size',
    `bite ${biteW.toFixed(0)} → ${biteW2.toFixed(0)} px, slots ${moved.map((s) => s.width.toFixed(0)).join(' / ')}, canvases ${inked2.map(([w]) => w).join(' / ')}`,
  );
  for (let i = 0; i < 4; i++) await key('ArrowLeft');
  await painted();

  // ── another field and the principal directions: the finished stands are drawn again
  await click('#field-tabs button[data-field="eta"]');
  await c.waitFor(`__mpm.standFrames.every((s) => s.field === 'eta')`, 10000).catch(() => {});
  const eta = await slots();
  ok(eta.every((s) => s.field === 'eta'), 'a field tab redraws every stand in that field', eta.map((s) => s.field).join(', '));
  await c.evaluate(`(() => { const b = document.querySelector('input[name="dirs"]'); b.click(); })()`);
  await c.waitFor(`__mpm.standFrames.every((s) => s.dirs)`, 10000).catch(() => {});
  ok((await slots()).every((s) => s.dirs), 'the principal directions reach every stand');
  await painted();
  await c.screenshot(join(dir, 'tandem-eta.png'));
  console.log(`shot  ${join(dir, 'tandem-eta.png')}`);
  await c.evaluate(`document.querySelector('input[name="dirs"]').click()`);

  // ── the loading path through the stands
  const tracks = await c.evaluate('JSON.parse(JSON.stringify(__mpm.tracks))');
  const through = tracks.filter((t) => new Set(t.stand).size === STANDS);
  ok(tracks.length > 0 && through.length === tracks.length, 'the followed points carry their path through every stand', tracks.map((t) => `${t.role} ${[...new Set(t.stand)].map((k) => k + 1).join('')}`).join(', '));
  ok(tracks.every((t) => t.stand.length * 3 === t.path.length && t.stand.every((k, i) => i === 0 || k >= t.stand[i - 1])), 'a stand number per path sample, in order');
  const legend = await c.evaluate(`document.querySelector('.locus-legend').textContent`);
  ok(['#1', '#2', '#3'].every((s) => legend.includes(s)), 'the loading-path legend names the stands', legend.slice(0, 80));

  // ── the force chart: a slab level per stand
  const force = await c.evaluate(`document.getElementById('legend-force').textContent`);
  ok(/スタンドごと/.test(force) && (force.match(/\d\.\d+/g) ?? []).length >= STANDS, 'the force chart gives the slab level of each stand', force.slice(0, 90));

  // ── the files
  const h = await c.evaluate('__mpm.history');
  const last = page3.reduce((a, r) => a + r.steps, 0);
  await press('荷重の推移（CSV）');
  const fForce = await saved(`rolling-force-step${last}.csv`);
  const lines = fForce ? readFileSync(fForce, 'utf8').trim().split('\n') : [];
  const rows = lines.slice(1).map((l) => l.split(',').map(Number));
  ok(lines[0] === 't_ms,force_kN_per_mm,torque_kN_m_per_m,stand', 'the force history ends with a stand column', `${lines[0]} (step ${last})`);
  ok(rows.length === h.t.length && rows.every((r, i) => r[0] === h.t[i] && r[3] === h.stand[i] + 1), 'its rows are __mpm.history, the time running on over the stands', `${rows.length} rows, stands ${[...new Set(rows.map((r) => r[3]))].join(',')}`);
  ok(rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]), 'the time only grows');
  await press('亀裂の一覧（CSV）');
  const fCr = await saved(`cracks-step${last}.csv`);
  const cr = fCr ? readFileSync(fCr, 'utf8').trim().split('\n') : [];
  ok(cr[0]?.startsWith('crack,t_ms,step,') && cr[0].endsWith(',points,stand'), 'the crack list ends with a stand column', cr[0]);
  await press('ロールバイト（PNG）');
  const fPng = await saved(`roll-bite-step${last}.png`);
  const png = fPng ? readFileSync(fPng) : Buffer.alloc(0);
  const pw = png.length > 24 ? png.readUInt32BE(16) : 0;
  const canvasW = await c.evaluate(`document.getElementById('bite').width`);
  ok(png.subarray(1, 4).toString() === 'PNG' && pw >= STANDS * canvasW - STANDS, 'the PNG holds the stands side by side', `${pw} px wide, one picture ${canvasW} px`);

  // ── a narrow screen: the pictures one under the other, no sideways scroll
  await c.setViewport(700, 1600);
  await painted();
  const narrow = await c.evaluate(`({ over: document.documentElement.scrollWidth - innerWidth, slots: [...document.querySelectorAll('.stand-slot')].map((e) => { const b = e.getBoundingClientRect(); return [b.width, b.height, b.top]; }) })`);
  ok(narrow.over <= 0 && narrow.slots.every(([w, hgt]) => w > 600 && hgt >= 150) && narrow.slots.every((s, k) => k === 0 || s[2] > narrow.slots[k - 1][2]), 'narrow screen (700 px): the pictures one under the other, full width, no sideways scroll', narrow.slots.map(([w, hgt]) => `${w.toFixed(0)}×${hgt.toFixed(0)}`).join(', ') + `, overflow ${narrow.over} px`);
  await c.screenshot(join(dir, 'tandem-narrow.png'));
  console.log(`shot  ${join(dir, 'tandem-narrow.png')}`);
  await c.setViewport(1600, 1000);

  // ── a crack through the thickness in stand 1 (4340's damage, a weak spot at the mid-plane): the tandem stops
  //    there, as a mill does at a strip break, and says so; the second slot is left uncomputed (ductility 0.01, the
  //    panel's lowest; 0.02 does not break)
  const cond = Buffer.from(JSON.stringify({ damage: { ...DAMAGE_4340, etaCutoff: -2 }, defects: [{ kind: 'weak', x: 2e-3, y: 0, ax: 0.15e-3, ay: 0.6e-3, ductility: 0.01 }] })).toString('base64url');
  await c.navigate(page(`?stands=2&cells=4&L=4&autorun=1&cond=${cond}`));
  await c.waitFor('__mpm.done', 120000);
  await painted();
  const broke = await c.evaluate(`({ stopped: __mpm.stopped, results: __mpm.standResults.map((r) => r.separated), note: document.querySelector('#stand-results caption')?.textContent ?? '', phase: document.getElementById('phase').textContent, labels: [...document.querySelectorAll('.stand-label')].map((e) => e.textContent) })`);
  ok(
    broke.stopped === 'separated' && broke.results.join() === 'true' && broke.note.includes('#1 の後で止めた: 板が破断した') && broke.phase === '#1 の後で止めた（板が破断した）' && broke.labels.join('|') === '#1|#2（計算しない）',
    'a break through the thickness in stand 1: the tandem stops there, the table and the status say why, the second slot stays uncomputed',
    `${broke.stopped}; ${broke.phase}; ${broke.note.slice(0, 30)}; ${broke.labels.join(' ')}`,
  );

  // ── five stands, the input's most, with the table full of real values (4 cells, a 4 mm strip: about 85 s):
  //    nothing in the record column scrolls sideways and no row head wraps, at 1600 and at 700 px
  await c.navigate(page('?stands=5&cells=4&L=4&autorun=1'));
  await c.waitFor('__mpm.done', 600000);
  for (const [w, h] of [[1600, 1000], [700, 1600]]) {
    await c.setViewport(w, h);
    await painted();
    const t = await c.evaluate(`(() => {
      const rec = document.querySelector('.record'), wrap = document.querySelector('.stand-results .table-scroll');
      const heads = [...document.querySelectorAll('#stand-results tr.name th')].map((e) => e.getBoundingClientRect().height);
      const top = document.querySelector('#stand-results thead th').getBoundingClientRect().height;
      const force = [...document.querySelectorAll('#stand-results tbody')].find((g) => g.querySelector('tr.name th').textContent.startsWith('圧延荷重'));
      return { recOver: rec.scrollWidth - rec.clientWidth, wrapOver: wrap.scrollWidth - wrap.clientWidth, heads, top, values: force ? [...force.querySelectorAll('tr.values td')].map((d) => d.textContent) : [] };
    })()`);
    ok(
      t.values.length === 5 && t.values.filter((v) => /^\d/.test(v)).length >= 3 && t.recOver <= 0 && t.wrapOver <= 0 && Math.max(...t.heads) <= 1.5 * t.top,
      `five stands' table at ${w} px: the forces filled (the first two stands of a 4 mm strip have no steady phase), no sideways scroll, every quantity's name on one line`,
      `forces ${t.values.join(' ')}; overflow record ${t.recOver} / table ${t.wrapOver} px; row heads ${Math.min(...t.heads).toFixed(0)}–${Math.max(...t.heads).toFixed(0)} px (a head line ${t.top.toFixed(0)})`,
    );
    await c.screenshot(join(dir, `tandem-5-${w}.png`));
    console.log(`shot  ${join(dir, `tandem-5-${w}.png`)}`);
  }
  // the widest the numbers get: every value filled with its longest usual form (a table of its own, from the
  // page's module through the dev server, on the same section), after the real ones
  for (const [w, h] of [[1600, 1000], [700, 1600]]) {
    await c.setViewport(w, h);
    await painted();
    const worst = await c.evaluate(`(async () => {
      const { StandTable } = await import('/src/app/standTable.ts');
      const t = new StandTable(document.getElementById('stand-results-section'), document.getElementById('stand-results'));
      const res = [1e-3, 0.748e-3, 0.561e-3, 0.42e-3, 0.315e-3].map((h, k) => ({ stand: k, h0: h, sheetLength: 0, particles: 0, steps: 0, t: 0, phase: 'done', steadyForce: 13.72e6, steadyTorque: 0, exitThickness: h * 0.75, forwardSlip: 0.1044, thicknessOut: h * 0.75, massLost: 0.0123, separated: false, maxDamage: 0.9123, nFailed: 12345, cracks: 0, cracksBorn: 0, crackGrowth: 0 }));
      t.update(5, res, 4, true, null, 'lost');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rec = document.querySelector('.record'), wrap = document.querySelector('.stand-results .table-scroll');
      return { recOver: rec.scrollWidth - rec.clientWidth, wrapOver: wrap.scrollWidth - wrap.clientWidth, rows: document.querySelectorAll('#stand-results tr.name').length };
    })()`);
    ok(worst.recOver <= 0 && worst.wrapOver <= 0 && worst.rows === 8, `five stands' table at ${w} px, every value at its widest and the lost-mass line: no sideways scroll`, `overflow record ${worst.recOver} / table ${worst.wrapOver} px, ${worst.rows} quantities`);
  }
  await c.setViewport(1600, 1000);

  // ── the plan view has one stand: the stands field is hidden there
  await c.evaluate(`document.querySelector('.view-switch button[data-mode="plan"]').click()`);
  await c.waitFor('__mpm.plan.active', 30000);
  const planField = await c.evaluate(`document.querySelector('input[name="stands"]').closest('.field').getBoundingClientRect().height`);
  await c.evaluate(`document.querySelector('.view-switch button[data-mode="section"]').click()`);
  const sectionField = await c.evaluate(`document.querySelector('input[name="stands"]').closest('.field').getBoundingClientRect().height`);
  ok(planField === 0 && sectionField > 0, 'the stands field shows in the section view only', `plan ${planField} px, section ${sectionField} px`);

  // ── one stand again: nothing of the tandem left on the page
  await c.navigate(page('?cells=6&L=8'));
  await c.waitFor('window.__mpm?.ready', 30000);
  const single = await c.evaluate(`({ row: document.querySelectorAll('.stand-row').length, table: document.getElementById('stand-results-section').hidden, stands: __mpm.stands, inBite: document.getElementById('bite').parentElement.classList.contains('bite') })`);
  ok(single.row === 0 && single.table && single.stands === 1 && single.inBite, 'one stand: no slots, no stand table, the roll bite where it was', JSON.stringify(single));
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
}
done();
