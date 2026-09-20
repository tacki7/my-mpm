// The plan view on the page, in a headless Chrome: switch to 平面図 with a real click, roll a strip to
// the end, and compare its steady values with `node tools/planview.mjs` for the same condition; run
// it again and get the same numbers bit for bit; press every field tab (no exceptions, a redraw under
// 16 ms); a brittle strip cracks and the crack record and the legend say where and when; the
// conditions URL opens the same plan condition; the section view still works after switching back and
// pauses when 平面図 is shown; the shared clock follows the view on screen; a panel edit not applied
// yet reaches neither view on a switch, and 「条件を反映してやり直す」 gives it to both;
// and a narrow screen (700 px) keeps the plan picture and has no sideways scroll. Not a `@check`.
//
//   CDP_PORT=<cdp> node tools/browser/planview.mjs <url> [out-prefix]
//
// Writes <out-prefix>-plan.png, -crack.png, -narrow.png when a prefix is given; look at them.
//
// The page and the tool agree to about 2e-6 (the spread; the forces to about 1e-7), not bit for bit:
// Chrome's V8 and Node's V8 round a few Math functions (exp, log, atan2) differently in the last bit,
// and that grows over thousands of steps. The looks and steady samples must match exactly; the values
// within 1e-5.
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

  // ── a strip too short for the steady window (16 mm): the note says so before the run, and at the end
  //    the load rows are empty rather than the tail's last look
  await c.navigate(page('?view=plan&L=16&damage=none'));
  await c.waitFor('__mpm.plan.ready && __mpm.plan.frames >= 1', 30000);
  const before = await c.evaluate(`document.getElementById('plan-results-note').textContent`);
  await click('#run');
  await c.waitFor('__mpm.plan.done', 120000);
  const after = await c.evaluate(`({ note: document.getElementById('plan-results-note').textContent, mid: [...document.querySelectorAll('#plan-results tr')].map((r) => r.textContent).find((t) => t.startsWith('中央の単位幅荷重')) })`);
  ok(before.includes('28 mm') && after.note.includes('28 mm') && after.mid?.includes('—'), 'a 16 mm strip: the note asks for 28 mm before and after the run, and the load rows stay empty', `${after.mid} / ${after.note.slice(-40)}`);

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

  // ── back to the section view: it runs as before; switching to 平面図 pauses it
  await c.navigate(page('?view=plan&cells=6&L=8'));
  await c.waitFor('__mpm.plan.ready', 30000);
  await click('.view-switch button[data-mode="section"]');
  await c.waitFor('!__mpm.plan.active', 10000);
  ok((await visible('#bite')) && !(await visible('#plan-canvas')), 'a click on 断面 shows the roll bite again');
  await click('#run');
  await c.waitFor('__mpm.diag && __mpm.diag.step >= 2000', 120000);
  ok((await c.evaluate('__mpm.diag.step')) >= 2000 && !(await c.evaluate('__mpm.plan.running')), 'the section model runs from the shared button (the plan view is not running)');
  await click('.view-switch button[data-mode="plan"]');
  await c.waitFor('__mpm.plan.active && !__mpm.running', 10000);
  await click('#run');
  // the section worker sends the frame it was computing when the pause came, then stops: read it once
  // the plan view has run a while, and again later
  await c.waitFor(`__mpm.plan.diag && __mpm.plan.diag.step >= 1500`, 120000);
  const sectionAt = await c.evaluate('__mpm.diag.step');
  await c.waitFor(`__mpm.plan.diag && __mpm.plan.diag.step >= 2500`, 120000);
  ok((await c.evaluate('__mpm.diag.step')) === sectionAt, 'switching to 平面図 pauses the section model (its step stays while the plan view runs 1000 steps)', `section at step ${sectionAt}`);

  // ── the shared clock shows the view on screen
  const clock = () => c.evaluate(`document.getElementById('clock').textContent`);
  const stepText = (expr) => c.evaluate(`(${expr}).toLocaleString() + ' step'`);
  ok((await clock()).includes(await stepText('__mpm.plan.diag.step')), 'the clock shows the plan view while it runs', await clock());
  await click('.view-switch button[data-mode="section"]');
  await c.waitFor('!__mpm.plan.active', 10000);
  await painted();
  ok((await clock()).includes(await stepText('__mpm.diag.step')), "back to 断面 in the middle of a plan run: the clock shows the section model's step", `${await clock()} (section ${sectionAt}, plan ${await c.evaluate('__mpm.plan.diag.step')})`);

  // ── the panel's pending edit: switching views (the first switch starts the plan view) does not apply
  //    it; 「条件を反映してやり直す」 applies it to both
  await c.navigate(page('?cells=6&L=8'));
  await c.waitFor('window.__mpm?.ready && !__mpm.plan.ready', 30000);
  const mu0 = await c.evaluate('__mpm.params.rolling.mu');
  await c.evaluate(`(() => { const i = document.querySelector('input[name="mu"]'); i.value = '0.12'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('.view-switch button[data-mode="plan"]');
  await c.waitFor('__mpm.plan.active', 10000);
  await click('.view-switch button[data-mode="section"]');
  await c.waitFor('!__mpm.plan.active', 10000);
  const kept = await c.evaluate(`({ mu: __mpm.params.rolling.mu, planMu: __mpm.plan.params.rolling.mu, pending: document.getElementById('reset').classList.contains('pending') })`);
  ok(kept.mu === mu0 && kept.planMu === mu0 && kept.pending, 'an edit not applied yet: switching to 平面図 and back applies it nowhere and it stays pending', JSON.stringify(kept));
  // another edit, the plan view started now: 「条件を反映してやり直す」 in the section view reaches both
  await c.evaluate(`(() => { const i = document.querySelector('input[name="mu"]'); i.value = '0.14'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('#reset');
  await c.waitFor('__mpm.ready && __mpm.plan.ready', 30000);
  const applied = await c.evaluate(`({ mu: __mpm.params.rolling.mu, planMu: __mpm.plan.params.rolling.mu, planFrames: __mpm.plan.frames, pending: document.getElementById('reset').classList.contains('pending') })`);
  ok(applied.mu === 0.14 && applied.planMu === 0.14 && !applied.pending, '「条件を反映してやり直す」 in the section view: both views take the new conditions', JSON.stringify(applied));

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
  // ── the whole strip: the picture frames the bite, and 全体を見る puts the strip's whole length inside it
{
  await c.navigate(page('?view=plan&W=20&wcells=10&L=28&damage=none&autorun=1'));
  await c.waitFor('__mpm.plan.done', 300000);
  await painted();
  // the ink of the drawn points, by canvas column: does it reach the right edge?
  const edge = () =>
    c.evaluate(`(() => {
      const cv = document.getElementById('plan-canvas');
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      // the points are drawn in the field's colours; the bite's band, the dashed lines and the notes are ink or
      // steel over the paper, which is grey once composited (the raw pixels of a translucent ink line are not).
      // Only the rows above the mid-width are read: the note 「板幅の中央」 sits at the right edge on that line
      const col = (x) => {
        for (let y = Math.floor(cv.height * 0.15); y < cv.height * 0.45; y += 3) {
          const i = 4 * (y * cv.width + x);
          const a = d[i + 3] / 255;
          if (a < 0.03) continue;
          const p = [0, 1, 2].map((k) => d[i + k] * a + [230, 233, 231][k] * (1 - a));
          if (Math.abs(p[0] - p[1]) > 12 || Math.abs(p[1] - p[2]) > 12) return true;
        }
        return false;
      };
      let right = 0;
      for (let x = cv.width - 1; x >= 0; x--) if (col(x)) { right = x; break; }
      return { right, width: cv.width, margin: cv.width - 1 - right };
    })()`);
  const bite = await edge();
  // (a version without the button answers with empty words, so this reads as a plain failure)
  const button = () => c.evaluate(`(() => { const b = document.querySelector('#plan-tools button'); return b ? { text: b.textContent, pressed: b.getAttribute('aria-pressed') } : { text: '(no button)', pressed: null }; })()`);
  const before = await button();
  await c.evaluate(`document.querySelector('#plan-tools button')?.click(); true`);
  await painted();
  const whole = await edge();
  const after = await button();
  ok(bite.margin < 4 && whole.margin > 8 && before.pressed === 'false' && after.pressed === 'true' && after.text.includes('バイト'),
    'after the pass the strip runs off the right edge; 全体を見る brings its whole length inside',
    `right edge ${bite.right}/${bite.width} → ${whole.right}/${whole.width} (margin ${bite.margin} → ${whole.margin} px), 「${before.text}」 → 「${after.text}」`);
  await c.evaluate(`document.querySelector('#plan-tools button')?.click(); true`);
  await painted();
  const back = await edge();
  ok(back.margin < 4 && (await button()).pressed === 'false', 'pressing it again frames the bite as before', `margin ${back.margin} px`);
}

ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close?.();
  }
}
done();
