// The roll-bite view in a headless Chrome: the wheel zooms about the pointer, a
// drag pans, a double click and the 0 key go back, + zooms, the thickness
// exaggeration can be chosen, a click on the overview moves the view, and the
// principal-direction glyphs come with the stresses from the worker. Not a
// `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/view.mjs <url> [shot-prefix]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, between, done } from '../checks/lib.mjs';

const [target, prefix] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/view.mjs <url> [shot-prefix]');
  process.exit(64);
}
const u = new URL(target);
u.search = '?autorun=1&cells=6&L=8&stopafter=9000';

const c = await connect(process.env.CDP_PORT);
const mouse = (type, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
const key = (k) => c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined });
const view = () => c.evaluate('__mpm.view');
const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
const shot = async (name) => {
  if (!prefix) return;
  await painted();
  console.log(`shot  ${await c.screenshot(`${prefix}-${name}.png`)}`);
};

try {
  await c.setViewport(1600, 1000);
  await c.navigate(u.href);
  await c.waitFor('__mpm.done', 180000);
  const b = await c.evaluate(`(() => { const r = document.getElementById('bite').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cx = b.x + b.w * 0.6;
  const cy = b.y + b.h * 0.5;
  ok((await view()).zoom === 1, 'starts at the default window');

  // wheel: zoom in about the pointer
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -600 });
  await c.waitFor('__mpm.view.zoom > 1.5', 5000).catch(() => {});
  const z = await view();
  between(z.zoom, 1.5, 80, 'the wheel zooms in', );
  await shot('zoomed');

  // drag: pan (the picture follows the pointer: dragging right shows what is to the left)
  const before = await view();
  await mouse('mousePressed', cx, cy, { clickCount: 1 });
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', cx + 30 * k, cy, { buttons: 1 });
  await mouse('mouseReleased', cx + 150, cy, { clickCount: 1 });
  const d = await view();
  ok(d.panX < before.panX, 'a drag to the right pans to the left', `panX ${(before.panX * 1e3).toFixed(3)} → ${(d.panX * 1e3).toFixed(3)} mm`);
  const ex = await c.evaluate('__mpm.explorer');
  ok(ex.role !== 'selected', 'a drag does not pick a point for the stress explorer', JSON.stringify(ex));

  // double click: back (from a zoomed and panned view)
  for (const n of [1, 2]) {
    await mouse('mousePressed', cx, cy, { clickCount: n });
    await mouse('mouseReleased', cx, cy, { clickCount: n });
  }
  await c.waitFor('__mpm.view.zoom === 1 && __mpm.view.panX === 0 && __mpm.view.panY === 0', 5000).catch(() => {});
  const r1 = await view();
  ok(r1.zoom === 1 && r1.panX === 0 && r1.panY === 0, 'a double click goes back to the default window', JSON.stringify(r1));

  // keys with the canvas focused
  await c.evaluate("document.getElementById('bite').focus()");
  await key('+');
  const k1 = await view();
  between(k1.zoom, 1.24, 1.26, '+ zooms in by 1.25');
  await key('0');
  const k0 = await view();
  ok(k0.zoom === 1 && k0.panX === 0, '0 goes back');
  await key('ArrowRight');
  ok((await view()).panX > 0, '→ moves the view toward the head');
  await key('0');

  // thickness exaggeration
  await c.evaluate("(() => { const s = document.querySelector('#view-tools select[name=exaggeration]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()");
  await c.waitFor('__mpm.view.exaggeration === 1', 5000).catch(() => {});
  ok((await view()).exaggeration === 1, 'exaggeration 1 is used', `${(await view()).exaggeration}`);
  const legend = await c.evaluate("document.getElementById('legend').textContent");
  ok(/1\.0 倍/.test(legend), 'the legend states it', legend.replace(/\s+/g, ' ').trim());
  await shot('ex1');
  await c.evaluate("(() => { const s = document.querySelector('#view-tools select[name=exaggeration]'); s.value = 'auto'; s.dispatchEvent(new Event('change')); })()");

  // overview: a click near its right end moves the view toward the head
  const o = await c.evaluate(`(() => { const r = document.getElementById('overview').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await mouse('mousePressed', o.x + o.w * 0.95, o.y + o.h / 2, { clickCount: 1 });
  await mouse('mouseReleased', o.x + o.w * 0.95, o.y + o.h / 2, { clickCount: 1 });
  await c.waitFor('__mpm.view.panX > 0', 5000).catch(() => {});
  ok((await view()).panX > 0, 'a click on the overview moves the view there', `panX ${((await view()).panX * 1e3).toFixed(2)} mm`);
  await shot('overview');
  await c.evaluate("[...document.querySelectorAll('#view-tools button')].find((b) => b.textContent === '元に戻す').click()");
  ok((await view()).panX === 0, '元に戻す goes back');

  // principal directions: the worker sends the stresses, the glyphs are drawn
  await c.evaluate("(() => { const i = document.querySelector('#view-tools input[name=dirs]'); i.click(); })()");
  await c.waitFor('__mpm.view.dirs && __mpm.view.dirsInFrame', 5000).catch(() => {});
  const dv = await view();
  ok(dv.dirs && dv.dirsInFrame, 'turning the directions on brings the stresses with the frame');
  await shot('dirs');

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
