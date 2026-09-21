// The 「2 次元」「3 次元」 tabs and the 3 次元 page, in a headless Chrome: the page opens on 2 次元 as before;
// a real click on 「3 次元」 shows the 3D page (the section, the plan view and their controls are gone, the panel
// has the 3D strip's settings and not the conditions the 3D model lacks); a 4 mm strip is rolled to the end and
// its steady values compared with `node tools/solid.mjs` (relative 1e-5: Chrome's and Node's V8 differ in the
// last bit of a few Math functions); every field tab redraws; a real drag turns the drawing, the wheel zooms, a
// double click puts it back; the view buttons; the conditions URL opens the same 3D condition; back on 2 次元 the
// section still runs, and showing 3 次元 pauses it; a narrow screen (700 px). Not a `@check`. About 3 minutes.
//
//   CDP_PORT=<cdp> node tools/browser/solid.mjs <url> [out-prefix]
//
// Writes <out-prefix>-solid.png, -top.png, -cut.png, -narrow.png when a prefix is given; look at them.
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/solid.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const centre = async (selector) => {
    const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    return r;
  };
  const mouse = (type, x, y, more = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...more });
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

  // ── the page opens on 2 次元, as it was
  await c.navigate(page('?cells=6&L=8'));
  await c.waitFor('window.__mpm?.ready', 30000);
  ok((await visible('#bite')) && !(await visible('#solid-canvas')) && (await visible('.view-switch')), 'the page opens on 2 次元: the roll bite and the 断面/平面図 switch, no 3D picture');
  ok(await c.evaluate(`document.getElementById('dim-tab-2').getAttribute('aria-selected') === 'true' && !__mpm.solid.active`), 'the 2 次元 tab is the selected one');

  // ── a real click on 3 次元
  await click('#dim-tab-3');
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  ok((await visible('#solid-canvas')) && !(await visible('#bite')) && !(await visible('#plan-canvas')) && !(await visible('.view-switch')), 'a click on 3 次元 shows the 3D picture; the section, the plan view and their switch are gone');
  ok((await visible('[name="solid-width"]')) && !(await visible('[name="tb"]')) && !(await visible('[name="stands"]')) && (await visible('[name="mu"]')), 'the panel has the 3D strip and the shared conditions, not the tensions or the stands');
  ok(await c.evaluate(`document.getElementById('dim-tab-3').getAttribute('aria-selected') === 'true' && document.getElementById('dim-panel').getAttribute('aria-labelledby') === 'dim-tab-3'`), 'the 3 次元 tab is selected and names the panel');

  // ── roll a 4 mm strip to the end; the tool, same condition
  const W = 4;
  await c.navigate(page(`?dim=3&W3=${W}`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  const s = await c.evaluate('JSON.parse(JSON.stringify(__mpm.solid.diag.steady))');
  ok(s && s.looks > 0, 'the strip has steady looks', `${s?.looks}`);
  const tool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', String(W), '--L', '12', '--cells', '4', '--json'], { encoding: 'utf8' }));
  ok(tool.steady.looks === s.looks, 'page = tool: the same steady looks', `page ${s.looks}, tool ${tool.steady.looks}`);
  near(s.force * 1e-3, tool.steady.force_kN, 1e-5, `page = tool: roll force on the whole width [kN] (W ${W} mm, 4 cells, strip 12 mm)`);
  near(s.spread * 100, tool.steady.spread_percent, 1e-5, 'page = tool: spread W1/W0 − 1 [%]');
  near(2 * s.halfThickness[0] * 1e3, tool.steady.centreThickness_mm, 1e-5, 'page = tool: exit thickness at the mid-width [mm]');
  ok(s.spread > 0.03, 'the strip spreads', `${(s.spread * 100).toFixed(2)} %`);
  const table = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent)`);
  const row = table.find((t) => t.startsWith('圧延荷重')) ?? '';
  ok(row.includes((s.force * 1e-3).toFixed(2)), 'the results table shows the steady roll force', row);
  ok((table.find((t) => t.startsWith('幅広がり W1/W0')) ?? '').includes((s.spread * 100).toFixed(2)), 'and the spread');
  await shot('solid');

  // ── every field tab
  const tabs = await c.evaluate(`[...document.querySelectorAll('#solid-tabs button')].map((b) => b.dataset.field)`);
  for (const id of tabs) {
    await click(`#solid-tabs button[data-field="${id}"]`);
    await c.waitFor(`document.getElementById('solid-legend').dataset.field === ${JSON.stringify(id)}`, 10000);
  }
  ok(tabs.length === 9 && c.errors.length === 0, `every field tab redraws the strip (${tabs.join(', ')})`, c.errors.join(' | '));
  await click('#solid-whole');
  await painted();
  const ms = await c.evaluate('__mpm.solid.drawMs(10)');
  ok(ms < 30, 'a redraw of the whole strip under 30 ms', `${ms.toFixed(1)} ms`);

  // ── turning, zooming, putting back
  const at = await centre('#solid-canvas');
  const v0 = await c.evaluate('__mpm.solid.view');
  await mouse('mousePressed', at.x, at.y);
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', at.x + 20 * k, at.y + 8 * k, { buttons: 1 });
  await mouse('mouseReleased', at.x + 100, at.y + 40);
  const v1 = await c.evaluate('__mpm.solid.view');
  ok(v1.yaw < v0.yaw - 0.3 && v1.pitch > v0.pitch + 0.1, 'a drag to the right turns the drawing with the hand (yaw falls)', `yaw ${v0.yaw.toFixed(2)} → ${v1.yaw.toFixed(2)}, pitch ${v0.pitch.toFixed(2)} → ${v1.pitch.toFixed(2)}`);
  ok(await c.evaluate(`document.querySelectorAll('.look-from button[aria-checked="true"]').length === 0`), 'and no named direction is the current one then');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -400 });
  await painted();
  const v2 = await c.evaluate('__mpm.solid.view');
  ok(v2.zoom > v1.zoom * 1.3, 'the wheel zooms', `${v1.zoom.toFixed(2)} → ${v2.zoom.toFixed(2)}`);
  await mouse('mousePressed', at.x, at.y, { clickCount: 2 });
  await mouse('mouseReleased', at.x, at.y, { clickCount: 2 });
  const v3 = await c.evaluate('__mpm.solid.view');
  ok(v3.yaw === v0.yaw && v3.pitch === v0.pitch && v3.zoom === 1, 'a double click puts the drawing back');
  await click('.look-from button[data-look="top"]');
  const v4 = await c.evaluate('__mpm.solid.view');
  near(v4.pitch, Math.PI / 2, 1e-12, '「上から」 looks straight down');
  await shot('top');
  await click('.look-from button[data-look="oblique"]');
  await click('#solid-cut');
  await click('#solid-rolls');
  const v5 = await c.evaluate('__mpm.solid.view');
  ok(v5.cut && !v5.rolls, '「板幅の中央で切る」 and 「ロール」 toggle');
  await shot('cut');

  // ── the conditions URL
  const url = await c.evaluate('__mpm.solid.url');
  ok(/(^|&)dim=3(&|$)/.test(url) && url.includes(`W3=${W}`) && !/(^|&)L=/.test(url), 'the conditions URL has the tab and the 3D strip, not the section\'s length', url);
  await c.navigate(page(`?${url}&mu=0.1`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  const again = await c.evaluate('({ s: __mpm.solid.settings, mu: __mpm.solid.params.rolling.mu, L: __mpm.solid.params.rolling.sheetLength })');
  ok(Math.abs(again.s.width - W * 1e-3) < 1e-12 && again.mu === 0.1 && Math.abs(again.L - 12e-3) < 1e-12, 'it opens the 3 次元 tab with that strip; the shared conditions (μ) reach the 3D model');

  // ── back on 2 次元 the section runs; showing 3 次元 pauses it
  await c.navigate(page('?cells=6&L=8&dim=3'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready && __mpm.ready', 60000);
  await click('#dim-tab-2');
  await c.waitFor('!__mpm.solid.active', 5000);
  ok((await visible('#bite')) && !(await visible('#solid-canvas')), 'a click on 2 次元 shows the roll bite again');
  await click('#run');
  await c.waitFor('__mpm.running && __mpm.frames > 3', 30000);
  await click('#dim-tab-3');
  await c.waitFor('__mpm.solid.active && !__mpm.running', 10000);
  await c.sleep(500); // the frames already on their way when the pause was sent
  const f0 = await c.evaluate('__mpm.frames');
  await c.sleep(600);
  const f1 = await c.evaluate('__mpm.frames');
  ok(f1 === f0, 'showing 3 次元 pauses the section\'s run', `${f0} → ${f1} frames`);
  ok(await c.evaluate(`document.getElementById('run').textContent === '圧延を始める' && !document.getElementById('run').disabled`), 'and the run button is the 3D model\'s');
  await click('#dim-tab-2');
  await c.waitFor('!__mpm.solid.active', 5000);
  ok(await c.evaluate(`document.getElementById('run').textContent === '続ける'`), 'back on 2 次元 the button continues the section');

  // ── a narrow screen
  await c.setViewport(700, 1000);
  await c.navigate(page('?dim=3'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await painted();
  const narrow = await c.evaluate(`({ canvas: document.getElementById('solid-canvas').getBoundingClientRect().height, over: document.documentElement.scrollWidth - innerWidth, tabs: document.getElementById('dim-tabs').getBoundingClientRect().width })`);
  ok(narrow.canvas >= 300 && narrow.over <= 0 && narrow.tabs > 200, '700 px: the 3D picture and the tabs fit, no sideways scroll', JSON.stringify(narrow));
  await shot('narrow');

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c?.close();
}
done();
