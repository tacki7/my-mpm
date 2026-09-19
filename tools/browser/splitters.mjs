// The draggable boundaries between the page's panes (src/app/splitters.ts) in a headless Chrome:
// a real mouse drag on each handle resizes the panes on both sides, the sizes stop at their limits,
// the arrow keys move a focused handle, the sizes come back after a reload, a double click goes back
// to the default, the charts redraw at their new size, and on a narrow screen there are no handles.
// Not a `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/splitters.mjs <url> [shot-prefix]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, near, between, done } from '../checks/lib.mjs';

const [target, prefix] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/splitters.mjs <url> [shot-prefix]');
  process.exit(64);
}
const u = new URL(target);
u.search = '?autorun=1&cells=6&L=8&stopafter=6000';

const c = await connect(process.env.CDP_PORT);
const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const key = (k, shift = false) =>
  c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k], modifiers: shift ? 8 : 0 });
const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
const box = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const drag = async (sel, dx, dy) => {
  const b = await box(sel);
  const x = b.x + b.w / 2;
  const y = b.y + b.h / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y);
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', x + (dx * k) / 5, y + (dy * k) / 5);
  await mouse('mouseReleased', x + dx, y + dy);
  await painted();
};
const shot = async (name) => {
  if (!prefix) return;
  await painted();
  console.log(`shot  ${await c.screenshot(`${prefix}-${name}.png`)}`);
};
// the canvas's backing store follows its drawn size (charts.ts sizes it at each draw)
const canvasWidth = (id) => c.evaluate(`document.getElementById('${id}').width`);

try {
  await c.setViewport(1600, 1000);
  await c.navigate(u.href);
  await c.evaluate("(() => { try { localStorage.removeItem('mpm-layout-v1'); } catch {} return true; })()");
  await c.navigate(u.href);
  await c.waitFor('__mpm.done', 180000);
  await painted();
  const handles = await c.evaluate("Array.from(document.querySelectorAll('.splitter')).map((e) => [e.dataset.size, e.getAttribute('role'), e.getAttribute('aria-orientation'), e.tabIndex, getComputedStyle(e).display])");
  ok(handles.length === 5 && handles.every((h) => h[1] === 'separator' && h[3] === 0 && h[4] !== 'none'), 'five handles, each a focusable separator', JSON.stringify(handles));

  // the conditions pane: drag right 80 px
  const l0 = (await box('.conditions')).w;
  const bite0 = (await box('#bite')).w;
  await drag('.split-left', 80, 0);
  const l1 = (await box('.conditions')).w;
  near(l1, l0 + 80, 0.02, 'dragging the left handle 80 px widens the conditions by 80 px');
  near((await box('#bite')).w, bite0 - 80, 0.02, '... and narrows the roll bite by as much');
  // past its limit it stops
  await drag('.split-left', 600, 0);
  near((await box('.conditions')).w, 520, 0.005, 'the conditions stop at 520 px');
  await drag('.split-left', -900, 0);
  near((await box('.conditions')).w, 180, 0.005, '... and at 180 px');
  await drag('.split-left', 70, 0); // 250 again for the rest

  // the record pane: drag left 60 px widens it
  const r0 = (await box('.record')).w;
  await drag('.split-right', -60, 0);
  near((await box('.record')).w, r0 + 60, 0.02, 'dragging the right handle 60 px left widens the record by 60 px');

  // the charts: drag the handle up 80 px, the charts grow and the bite shrinks
  const ch0 = (await box('#chart-force')).h;
  const bh0 = (await box('#bite')).h;
  await drag('.split-charts', 0, -80);
  near((await box('#chart-force')).h, ch0 + 80, 0.02, 'dragging the charts handle 80 px up makes the charts 80 px taller');
  between((await box('#bite')).h, bh0 - 81, bh0 - 79, '... and the roll bite 80 px shorter');

  // two charts trade width
  const f0 = await c.evaluate("Array.from(document.querySelectorAll('.charts > figure')).map((f) => f.getBoundingClientRect().width)");
  const cw0 = await canvasWidth('chart-hill');
  await drag('.split-col[data-size="c12"]', 60, 0);
  const f1 = await c.evaluate("Array.from(document.querySelectorAll('.charts > figure')).map((f) => f.getBoundingClientRect().width)");
  near(f1[0], f0[0] + 60, 0.03, 'dragging between the first two charts gives the first 60 px more');
  near(f1[1], f0[1] - 60, 0.03, '... and takes them from the second');
  near(f1[2], f0[2], 0.01, '... the third keeps its width');
  await painted();
  ok((await canvasWidth('chart-hill')) < cw0, 'the narrowed chart is drawn again at its new width', `${cw0} → ${await canvasWidth('chart-hill')}`);
  await shot('dragged');

  // keyboard: focus the right handle, ← twice widens the record by 2 × 16 px
  const r1 = (await box('.record')).w;
  await c.evaluate("document.querySelector('.split-right').focus()");
  await key('ArrowLeft');
  await key('ArrowLeft');
  await painted();
  near((await box('.record')).w, r1 + 32, 0.02, 'two ← on the focused right handle widen the record by 32 px');
  const now = await c.evaluate("+document.querySelector('.split-right').getAttribute('aria-valuenow')");
  near(now, (await box('.record')).w, 0.01, 'the handle reports the width as aria-valuenow');

  // the sizes come back after a reload
  const before = { l: (await box('.conditions')).w, r: (await box('.record')).w, h: (await box('#chart-force')).h };
  await c.navigate(u.href);
  await c.waitFor('__mpm.ready', 60000);
  await painted();
  const after = { l: (await box('.conditions')).w, r: (await box('.record')).w, h: (await box('#chart-force')).h };
  ok(Math.abs(after.l - before.l) < 1 && Math.abs(after.r - before.r) < 1 && Math.abs(after.h - before.h) < 1, 'the sizes are kept after a reload', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // a double click on a handle goes back to its default (first move it off the default)
  await drag('.split-left', 50, 0);
  near((await box('.conditions')).w, 300, 0.005, 'the conditions at 300 px before the double click');
  const lh = await box('.split-left');
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lh.x + 3, y: lh.y + 200, button: 'left', clickCount: 2 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lh.x + 3, y: lh.y + 200, button: 'left', clickCount: 2 });
  await painted();
  near((await box('.conditions')).w, 250, 0.005, 'a double click on the left handle puts the conditions back to 250 px');

  // a narrow screen: one column, no handles, no sideways scroll
  await c.setViewport(700, 1000);
  await painted();
  const shown = await c.evaluate("Array.from(document.querySelectorAll('.splitter')).filter((e) => getComputedStyle(e).display !== 'none').length");
  ok(shown === 0, 'at 700 px no handle is shown', `${shown} shown`);
  ok((await c.evaluate('document.documentElement.scrollWidth')) <= 700, 'at 700 px nothing scrolls sideways');
  await shot('narrow');
  await c.setViewport(1600, 1000);
  await c.evaluate("(() => { try { localStorage.removeItem('mpm-layout-v1'); } catch {} return true; })()");

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
