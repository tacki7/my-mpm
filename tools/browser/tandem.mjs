// A tandem on the page, in a headless Chrome: `?stands=3` rolls the sheet through three stands with a
// real click on the run button, to the end; the page's per-stand results equal `node tools/tandem.mjs`
// for the same condition (the steps and points exactly, the values to 1e-5); the three pictures sit side
// by side, each holding its own stand's last frame, and a field tab or the principal directions redraw
// the finished ones too; the stress explorer's loading path runs through the three stands (numbered, a
// colour each, in the legend); the force chart has a slab level per stand; the table has a column per
// stand; the CSV files are downloaded with a stand column on the whole pass's clock, and the PNG holds
// the three pictures; a narrow screen (700 px) stacks the pictures without a sideways scroll; and back
// to one stand, the page is as before (no slots, no table). Not a `@check` (it needs the dev server and
// Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/tandem.mjs <url> <out-dir>
//
// <out-dir> (a new, empty directory) gets the downloads and tandem.png, tandem-eta.png, tandem-narrow.png;
// look at the pictures. About a minute.
//
// The page and the tool agree to about 1e-6, not bit for bit (Chrome's and Node's V8 round exp, log and
// atan2 differently in the last bit; tools/browser/planview.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

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
  ok(tool.length === page3.length && tool.every((r, k) => r.steps === page3[k].steps && r.particles === page3[k].particles), 'page = tool: the same stands, steps and points', page3.map((r, k) => `#${k + 1} ${r.steps}/${tool[k]?.steps} steps`).join(', '));
  for (let k = 0; k < Math.min(tool.length, page3.length); k++) {
    const p = page3[k];
    const t = tool[k];
    near(p.steadyForce, t.steadyForce, 1e-5, `page = tool: #${k + 1} steady force (${(t.steadyForce * 1e-6).toFixed(3)} kN/mm)`);
    near(p.exitThickness, t.exitThickness, 1e-5, `page = tool: #${k + 1} exit thickness`);
    near(p.thicknessOut, t.thicknessOut, 1e-5, `page = tool: #${k + 1} thickness let out`);
    near(p.forwardSlip, t.forwardSlip, 1e-4, `page = tool: #${k + 1} forward slip`);
  }

  // ── the table: a column per stand, its force
  const table = await c.evaluate(`({ hidden: document.getElementById('stand-results-section').hidden, head: [...document.querySelectorAll('#stand-results thead th')].map((e) => e.textContent), force: [...document.querySelectorAll('#stand-results tbody tr')].find((r) => r.firstChild.textContent === '圧延荷重')?.textContent ?? '' })`);
  const forces = page3.map((r) => (r.steadyForce * 1e-6).toFixed(2));
  ok(!table.hidden && table.head.filter(Boolean).join(' ') === '#1 #2 #3' && forces.every((f) => table.force.includes(f)), 'the table has a column per stand with its steady force', `${table.head.filter(Boolean).join(' ')}: ${table.force}`);

  // ── the pictures side by side
  const after = await slots();
  ok(after.every((s, k) => s.field === 'seq' && s.step === page3[k].steps) && after[STANDS - 1].live, "every slot holds its own stand's last frame (the last one live)", after.map((s) => `#${s.stand + 1} step ${s.step}`).join(', '));
  const widths = after.map((s) => s.width);
  const biteW = await c.evaluate(`document.querySelector('.bite').getBoundingClientRect().width`);
  ok(widths.every((w) => Math.abs(w - biteW / STANDS) < 4), 'the pictures share the width of the roll bite', `${widths.map((w) => w.toFixed(0)).join(' / ')} px of ${biteW.toFixed(0)}`);
  const inked = await c.evaluate(`[...document.querySelectorAll('.stand-slot canvas:not([hidden])')].map((cv) => { const x = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; const seen = new Set(); for (let i = 0; i < x.length; i += 4 * 97) seen.add((x[i] << 16) | (x[i + 1] << 8) | x[i + 2]); return seen.size; })`);
  ok(inked.length === STANDS && inked.every((n) => n > 20), 'every picture is drawn (colours on each canvas)', inked.join(' / '));
  await c.screenshot(join(dir, 'tandem.png'));
  console.log(`shot  ${join(dir, 'tandem.png')}`);

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
