// The plan view on the page, in a headless Chrome: switch to 平面図 with a real click, roll a strip to
// the end, and compare its steady values with `node tools/planview.mjs` for the same condition; run
// it again and get the same numbers bit for bit; press every field tab (no exceptions, a redraw under
// 16 ms); a brittle strip cracks and the crack record and the legend say where and when; the
// conditions URL opens the same plan condition; the section view still works after switching back;
// and a narrow screen (700 px) keeps the plan picture and has no sideways scroll. Not a `@check`.
//
//   CDP_PORT=<cdp> node tools/browser/planview.mjs <url> [out-prefix]
//
// Writes <out-prefix>-plan.png, -crack.png, -narrow.png when a prefix is given; look at them.
//
// The page and the tool agree to about 1e-7, not bit for bit: Chrome's V8 and Node's V8 round a few
// Math functions (exp, log, atan2) differently in the last bit, and that grows over thousands of steps.
// The number of looks and steady samples must match exactly; the values within 1e-5.
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/planview.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const click = async (selector) => {
    const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const visible = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getBoundingClientRect().height > 0; })()`);

  // ── switch with a real click, then roll to the end
  const L = 28;
  await c.navigate(page(`?L=${L}&damage=none`));
  await c.waitFor('window.__mpm?.ready', 30000);
  await click('.view-switch button[data-mode="plan"]');
  await c.waitFor('__mpm.plan.active && __mpm.plan.ready', 30000);
  ok((await visible('#plan-canvas')) && !(await visible('#bite')), 'a click on 平面図 shows the plan view and hides the roll bite');
  await click('#run');
  await c.waitFor('__mpm.plan.done', 600000);
  await painted();
  const first = await c.evaluate('JSON.parse(JSON.stringify({ steady: __mpm.plan.diag.steady, step: __mpm.plan.diag.step, settings: __mpm.plan.settings }))');
  const s = first.steady;
  ok(s.samples > 0, 'the strip reaches the steady window', `${s.samples} of ${s.looks} steady looks, step ${first.step}`);

  // the tool, same condition
  const W = first.settings.width * 1e3;
  const cells = first.settings.cells;
  const tool = JSON.parse(execFileSync('node', ['tools/planview.mjs', '--W', String(W), '--cells', String(cells), '--L', String(L), '--json'], { encoding: 'utf8' }));
  ok(tool.steadySamples === s.samples && tool.steadyLooks === s.looks, 'page = tool: the same looks and steady samples', `page ${s.samples}/${s.looks}, tool ${tool.steadySamples}/${tool.steadyLooks}`);
  near(s.forceHalfWidth * 1e-3, tool.forceHalfWidth_kN, 1e-5, `page = tool: roll force on the half width [kN] (W ${W} mm, ${cells} cells, strip ${L} mm)`);
  near(s.forcePerWidthByZ[0] * 1e-6, tool.forcePerWidthMid_kN_per_mm, 1e-5, 'page = tool: force per unit width in the middle [kN/mm]');
  near(s.spread, tool.spread, 1e-5, 'page = tool: spread W1/W0 − 1');
  near(s.centreExitThickness * 1e3, tool.centreExitThickness_mm, 1e-5, 'page = tool: exit thickness in the middle [mm]');
  const table = await c.evaluate(`[...document.querySelectorAll('#plan-results tr')].map((r) => r.textContent)`);
  const midRow = table.find((t) => t.startsWith('中央の単位幅荷重')) ?? '';
  ok(midRow.includes((s.forcePerWidthByZ[0] * 1e-6).toFixed(3)), 'the results table shows the steady force per unit width in the middle', midRow);
  if (shots) {
    await c.screenshot(`${shots}-plan.png`);
    console.log(`shot  ${shots}-plan.png`);
  }

  // ── the same condition again: the same numbers, bit for bit
  await click('#reset');
  await c.waitFor('__mpm.plan.ready && __mpm.plan.frames <= 1', 30000);
  await click('#run');
  await c.waitFor('__mpm.plan.done', 600000);
  const again = await c.evaluate('JSON.parse(JSON.stringify(__mpm.plan.diag.steady))');
  ok(JSON.stringify(again) === JSON.stringify(s), 'run again: the same steady values, bit for bit', `force ${again.forceHalfWidth} / ${s.forceHalfWidth} N`);

  // ── every field tab: redrawn, no exceptions, under 16 ms a redraw
  const tabs = await c.evaluate(`[...document.querySelectorAll('#plan-tabs button')].map((b) => b.dataset.field)`);
  let slowest = 0;
  for (const f of tabs) {
    await click(`#plan-tabs button[data-field="${f}"]`);
    await c.waitFor(`document.getElementById('plan-legend').dataset.field === ${JSON.stringify(f)}`, 10000);
    await painted();
    slowest = Math.max(slowest, await c.evaluate('__mpm.plan.drawMs(10)'));
  }
  ok(tabs.length === 6 && c.errors.length === 0, `every field tab redraws the plan (${tabs.join(', ')})`, c.errors.join(' | '));
  ok(slowest < 16, 'one redraw of the plan takes under 16 ms', `slowest ${slowest.toFixed(2)} ms`);

  // ── the conditions URL opens the same plan condition
  const url = await c.evaluate('__mpm.plan.url');
  await c.navigate(page(`?${url}&W=16&wcells=8&notch=0.5`));
  await c.waitFor('__mpm.plan.ready', 30000);
  const reopened = await c.evaluate('__mpm.plan.settings');
  ok(url.includes('view=plan') && reopened.width === 16e-3 && reopened.cells === 8 && Math.abs(reopened.notch - 0.5e-3) < 1e-12, 'the URL keys view=plan, W, wcells and notch set the plan view', JSON.stringify(reopened));

  // ── a brittle strip (CL 0.1): it cracks, the record and the legend show it (where it cracks on this
  //    coarse grid is docs/validation.md's business, not this check's)
  await c.navigate(page(`?view=plan&L=16&W=20&wcells=10&damage=cockcroft-latham&cond=${b64({ damage: { clCrit: 0.1 } })}&autorun=1`));
  await c.waitFor('__mpm.plan.cracks.length > 0 || __mpm.plan.done', 600000);
  await c.evaluate(`document.querySelector('#plan-tabs button[data-field="damage"]').click()`);
  await c.waitFor(`document.getElementById('plan-legend').dataset.field === 'damage'`, 10000);
  await painted();
  const crack = await c.evaluate('({ cracks: __mpm.plan.cracks.map((k) => ({ t: k.t, z: k.sheetZ, x: k.sheetX })), half: __mpm.plan.geometry.halfWidth0, log: [...document.querySelectorAll("#plan-crack-log li")].map((l) => l.textContent), key: !!document.querySelector("#plan-legend .failed-key") })');
  const k0 = crack.cracks[0];
  ok(!!k0, 'CL 0.1: the strip cracks', k0 ? `${((crack.half - k0.z) * 1e3).toFixed(2)} mm in from the edge, ${(k0.x * 1e3).toFixed(2)} mm from the head, ${(k0.t * 1e3).toFixed(2)} ms` : 'no crack');
  const says = k0 ? [`${(k0.t * 1e3).toFixed(2)} ms`, `頭端から ${(k0.x * 1e3).toFixed(2)} mm`, `端から ${((crack.half - k0.z) * 1e3).toFixed(2)} mm`] : [];
  ok(crack.log.length === crack.cracks.length && says.length > 0 && says.every((w) => crack.log[0].includes(w)), 'the crack record has one entry per crack, the first with its time and place', crack.log[0] ?? 'empty');
  ok(crack.key, 'the legend says what the ink points and the vermilion stamps are');
  if (shots) {
    await c.screenshot(`${shots}-crack.png`);
    console.log(`shot  ${shots}-crack.png`);
  }
  await c.evaluate('__mpm.plan.setMode("section")');
  // (the crack run goes on in the worker; switching away pauses it)

  // ── back to the section view: it runs as before
  await c.navigate(page('?view=plan&cells=6&L=8'));
  await c.waitFor('__mpm.plan.ready', 30000);
  await click('.view-switch button[data-mode="section"]');
  await c.waitFor('!__mpm.plan.active', 10000);
  ok((await visible('#bite')) && !(await visible('#plan-canvas')), 'a click on 断面 shows the roll bite again');
  await click('#run');
  await c.waitFor('__mpm.diag && __mpm.diag.step >= 2000', 120000);
  ok((await c.evaluate('__mpm.diag.step')) >= 2000 && !(await c.evaluate('__mpm.plan.running')), 'the section model runs from the shared button (the plan view is not running)');

  // ── a narrow screen: the plan picture keeps its size, nothing scrolls sideways
  await c.evaluate('__mpm.plan.setMode("plan")');
  await c.setViewport(700, 1400);
  await painted();
  await painted();
  const narrow = await c.evaluate(`({ canvas: document.getElementById('plan-canvas').getBoundingClientRect().height, over: document.documentElement.scrollWidth - innerWidth })`);
  ok(narrow.canvas >= 300 && narrow.over <= 0, 'narrow screen (700 px): the plan picture keeps its height, no sideways scroll', `canvas ${narrow.canvas.toFixed(0)} px high, overflow ${narrow.over} px`);
  if (shots) {
    await c.screenshot(`${shots}-narrow.png`);
    console.log(`shot  ${shots}-narrow.png`);
  }
  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close?.();
  }
}
done();
