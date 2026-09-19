// Smoke test of the page in a headless Chrome: it loads without errors, a coarse
// rolling pass runs to the end, the steady numbers stay in their bands, every
// field tab redraws the roll bite, and a screenshot is written. Not a `@check`
// (it needs the dev server and Chrome); run it by hand after changing the page.
//
//   CDP_PORT=<cdp> node tools/browser/smoke.mjs <url> [out.png] [--timeout 180000]
//
// <url> is the page, e.g. http://localhost:<dev>/ . autorun=1, cells=6, L=8 and
// stopafter=12000 are added unless the URL sets them. The bands are for the
// standard preset on that coarse mesh (docs/validation.md: 3.20 kN/mm, 0.7509 mm).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, between, done } from '../checks/lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const timeout = +opt('timeout', 180000);
const [target, shot] = argv;
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/smoke.mjs <url> [out.png] [--timeout ms]');
  process.exit(64);
}

const url = new URL(target);
for (const [k, v] of [['autorun', '1'], ['cells', '6'], ['L', '8'], ['stopafter', '12000']]) {
  if (!url.searchParams.has(k)) url.searchParams.set(k, v);
}

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
let c;
let recorder = null;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  // one animation frame after the next: the page has drawn whatever was pending
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

  // Record the diagnostics of every frame the worker sends, from before the page's
  // own scripts run. Polling __mpm.diag instead misses frames (a 2-cell pass is over
  // in half a second), so what it sees would depend on the speed of the machine.
  ({ identifier: recorder } = await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const W = window.Worker;
      window.__smokeFrames = [];
      window.Worker = class extends W {
        constructor(...a) {
          super(...a);
          this.addEventListener('message', (e) => {
            if (e.data?.type === 'frame') window.__smokeFrames.push(e.data.diag);
          });
        }
      };
    })();`,
  }));

  await c.navigate(url.href);
  await c.waitFor('window.__mpm?.ready', 30000);
  ok(c.errors.length === 0, 'page loads without exceptions or console errors', c.errors.join(' | '));

  // ── a coarse pass ────────────────────────────────────────────────────────────
  await c.evaluate('window.__mpm.running || window.__mpm.run()');
  let finished = true;
  await c.waitFor('__mpm.done', timeout).catch(() => (finished = false));
  const last = await c.evaluate('__mpm.diag');
  const steady = (await c.evaluate('__smokeFrames')).filter((d) => d.phase === 'steady');
  ok(finished, 'the run finishes (__mpm.done)', `${last?.phase ?? 'no frame'} at step ${last?.step ?? 0}, ${secs()} s`);
  ok(last?.phase !== 'stalled', 'the sheet is bitten (not stalled)', last?.phase ?? 'no frame');
  ok(steady.length >= 2, 'steady frames are sampled', `${steady.length} frames`);
  between(mean(steady.map((d) => d.rollForce)) * 1e-6, 2.8, 4.0, 'steady roll force [kN/mm] (6 cells: 3.20; 4.31 with the contact band of before)');
  between(mean(steady.map((d) => d.exitThickness ?? NaN)) * 1e3, 0.745, 0.765, 'exit thickness [mm] (gap 0.75 + springback)');
  between(mean(steady.map((d) => d.forwardSlip ?? NaN)) * 100, 0, 6, 'forward slip [%]');
  const hist = await c.evaluate('__mpm.history.F');
  ok(hist.length >= 10 && hist.every(Number.isFinite), 'the force chart has finite data', `${hist.length} points`);

  // the shot is taken here, as the run left the page (a field change while stopped
  // sends a frame without contact tractions, so the friction hill would read zero)
  if (shot) {
    await painted();
    await c.screenshot(shot);
    console.log(`shot  ${shot}`);
  }

  // ── every field tab, clicked for real ─────────────────────────────────────────
  const tabs = await c.evaluate(`[...document.querySelectorAll('#field-tabs button')].map((b) => ({ id: b.dataset.field, label: b.textContent }))`);
  ok(tabs.length > 0, 'field tabs are present', `${tabs.length}`);
  const canvasHash = `(() => {
    const cv = document.getElementById('bite');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261;
    for (let i = 0; i < px.length; i += 4) h = Math.imul(h ^ (px[i] | (px[i + 1] << 8) | (px[i + 2] << 16)), 16777619);
    return h >>> 0;
  })()`;
  // start from the last tab so that the first click is a change too
  await c.evaluate(`__mpm.setField(${JSON.stringify(tabs.at(-1)?.id)})`);
  await c.waitFor(`document.getElementById('legend').dataset.field === ${JSON.stringify(tabs.at(-1)?.id)}`, 10000);
  await painted();
  let prev = await c.evaluate(canvasHash);
  for (const tab of tabs) {
    const before = c.errors.length;
    let detail = '';
    try {
      const r = await c.evaluate(`(() => {
        const b = document.querySelector('#field-tabs button[data-field=${JSON.stringify(tab.id)}]');
        b.scrollIntoView({ block: 'center' });
        const q = b.getBoundingClientRect();
        return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      }
      // the worker answers with a frame in the new field; the legend is redrawn with it
      await c.waitFor(`document.getElementById('legend').dataset.field === ${JSON.stringify(tab.id)}`, 5000);
      await painted();
      const now = await c.evaluate(canvasHash);
      const legend = await c.evaluate(`document.getElementById('legend').textContent`);
      const checked = await c.evaluate(`document.querySelector('#field-tabs button[data-field=${JSON.stringify(tab.id)}]').getAttribute('aria-checked')`);
      const problems = [];
      if (checked !== 'true') problems.push(`aria-checked ${checked}`);
      if (now === prev) problems.push('canvas unchanged');
      if (/NaN|Infinity/.test(legend)) problems.push(`legend "${legend.trim().replace(/\s+/g, ' ')}"`);
      if (c.errors.length > before) problems.push(c.errors.slice(before).join(' | '));
      detail = problems.join('; ');
      prev = now;
    } catch (e) {
      detail = String(e?.message ?? e);
    }
    ok(detail === '', `tab "${tab.label}" redraws the roll bite`, detail);
  }
  ok(c.errors.length === 0, 'no exceptions or console errors during the whole run', c.errors.join(' | '));
} catch (e) {
  ok(false, 'smoke test ran to the end', [String(e?.message ?? e), ...(c?.errors ?? [])].join(' | '));
} finally {
  // stop drawing (an open page keeps a core busy)
  if (c) {
    if (recorder) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: recorder }).catch(() => {});
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
  console.log(`total ${secs()} s  ${url.href}`);
}
done();
