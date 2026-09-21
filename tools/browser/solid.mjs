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
  ok((await visible('[name="solid-width"]')) && !(await visible('[name="tb"]')) && !(await visible('[name="L"]')) && (await visible('[name="stands"]')) && (await visible('[name="flatten"]')) && (await visible('[name="control"]')) && (await visible('[name="length"]')) && (await visible('[name="mu"]')), 'the panel has the 3D strip and the shared conditions (the stands, the rolls that follow the pass, the length steady), not the tensions or the section\'s length');
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

  // ── a tandem, the length steady, rolls that follow the pass: set in the panel, run to the end, against the tool
  await c.setViewport(1600, 1000);
  await c.navigate(page('?dim=3&W3=2'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  const choose = (name, value) => c.evaluate(`(() => { const e = document.querySelector('[name="${name}"]'); e.value = '${value}'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('stands', '2');
  await choose('handoff', 'steady');
  await choose('length', 'steady');
  await choose('flatten', 'hitchcock');
  await choose('control', 'reduction');
  ok(await c.evaluate(`document.querySelector('[name="solid-length"]').disabled`), 'the length steady: the 3D length is not an input');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.stands === 2', 60000);
  const autoL = await c.evaluate(`({ shown: parseFloat(document.querySelector('[name="solid-length"]').value), L: __mpm.solid.geometry.sheetLength * 1e3, p: __mpm.solid.params.rolling })`);
  ok(Math.abs(autoL.shown - autoL.L) < 0.051 && autoL.L > 20 && autoL.p.flattening === 'hitchcock' && autoL.p.gapControl === 'reduction', 'the field shows the length worked out (longer for the rolls to settle)', `${autoL.shown} mm`);
  await click('#run');
  await c.waitFor('__mpm.solid.stand === 1 && __mpm.solid.diag.phase === "bite"', 600000);
  await painted();
  await shot('tandem-mid');
  ok(await c.evaluate(`!document.getElementById('solid-stand-section').hidden && document.querySelectorAll('#solid-stand-results thead th').length === 2 && document.querySelector('#solid-stand-results thead th.current').textContent === '#2'`), 'the stands\' table: two columns, #2 the running one');
  await c.waitFor('__mpm.solid.done', 900000);
  await painted();
  await shot('tandem-end');
  const res = await c.evaluate('__mpm.solid.standResults');
  const tandemTool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--length', 'steady', '--stands', '2', '--handoff', 'steady', '--flatten', 'hitchcock', '--control', 'reduction', '--json'], { encoding: 'utf8' }));
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  const t1 = tandemTool.stands[0];
  ok(res.length === 2 && res[0].phase === 'steady' && res[0].rollsSettled && res[1].rollsSettled, 'both stands ran, #1 handed on while steady, the rolls settled');
  ok(rel(res[0].steady.force * 1e-3, t1.steady.force_kN) < 1e-5 && rel(res[0].rollRadius * 1e3, t1.rollRadius_mm) < 1e-5 && rel(res[0].thicknessOut * 1e3, t1.thicknessOut_mm) < 1e-5, "page = tool, #1: force, R', the strip that came out (1e-5)", `${(res[0].steady.force * 1e-3).toFixed(4)} kN, R' ${(res[0].rollRadius * 1e3).toFixed(2)} mm`);
  // #2 starts from #1's strip, where the last bit of exp and log (Chrome's V8 against Node's) has grown
  const t2 = tandemTool.stands[1];
  ok(rel(res[1].steady.force * 1e-3, t2.steady.force_kN) < 0.01 && rel(res[1].thicknessOut * 1e3, t2.thicknessOut_mm) < 1e-3, 'page = tool, #2: force within 1 %, the strip within 0.1 %', `${(res[1].steady.force * 1e-3).toFixed(4)} against ${t2.steady.force_kN.toFixed(4)} kN`);
  const target2 = res[1].h0 * 0.75;
  ok(rel(res[0].thicknessOut, 0.75e-3) < 2e-3 && rel(res[1].thicknessOut, target2) < 2e-3, 'a constant reduction: each stand\'s strip comes out at 75 % of what came in', `${(res[0].thicknessOut * 1e3).toFixed(4)}, ${(res[1].thicknessOut * 1e3).toFixed(4)} mm`);
  const tUrl = await c.evaluate('__mpm.solid.url');
  ok(/stands=2/.test(tUrl) && /handoff=steady/.test(tUrl) && /length=steady/.test(tUrl) && /flatten=hitchcock/.test(tUrl) && /control=reduction/.test(tUrl) && /dim=3/.test(tUrl), 'the conditions URL carries the tandem and the rolls', tUrl);

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
