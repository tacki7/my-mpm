// Page state checks in a headless Chrome, for bugs that only show in the page:
// a restart while running, ?stopafter, the conditions panel against the URL,
// a URL whose roll geometry has no bite, and an exception while drawing. Not a
// `@check` (it needs the dev server and Chrome); run it after changing the page.
//
//   CDP_PORT=<cdp> node tools/browser/ui-state.mjs <url>
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, done } from '../checks/lib.mjs';

const [target] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/ui-state.mjs <url>');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};

const c = await connect(process.env.CDP_PORT);
try {
  await c.setViewport(1600, 1000);
  // Count animation frames the page asks for, and let a test make one canvas text
  // draw throw, from before the page's own scripts run.
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__raf = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => (window.__raf++, raf(cb));
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...a) {
        if (window.__throwOnce) {
          window.__throwOnce = false;
          window.__threw = true;
          throw new Error('test: one failing draw');
        }
        return fillText.apply(this, a);
      };
    })();`,
  });
  const opened = async (q) => {
    await c.navigate(page(q));
    await c.waitFor('window.__mpm?.ready', 30000);
  };

  // ── a restart while running: no frame of the old run may reach the new one ──
  await opened('?autorun=1&cells=6&L=8');
  for (let k = 1; k <= 3; k++) {
    await c.waitFor('__mpm.running && __mpm.diag?.step > 2000', 60000);
    const tOld = await c.evaluate('__mpm.diag.t * 1e3');
    await c.evaluate('__mpm.restart()');
    let restarted = true;
    await c.waitFor('__mpm.running && __mpm.history.t.length >= 3', 20000).catch(() => (restarted = false));
    const t = await c.evaluate('__mpm.history.t.slice(0, 3)');
    ok(restarted, `restart ${k} while running: ?autorun=1 starts the new run`, `running ${await c.evaluate('__mpm.running')}, ${t.length} samples`);
    ok(t.length > 0 && t[0] < 0.5 * tOld, `restart ${k}: the force history starts from the new run`, `first t ${t.map((v) => v.toFixed(3)).join(', ')} ms, old run at ${tOld.toFixed(3)} ms`);
    if (!restarted) break;
  }
  await c.evaluate("document.getElementById('pause').click()");

  // ── ?stopafter ──────────────────────────────────────────────────────────────
  await opened('?autorun=1&cells=6&L=8&stopafter=2345');
  await c.waitFor('__mpm.done', 60000);
  ok((await c.evaluate('__mpm.diag.step')) === 2345, 'stopafter=2345 stops at step 2345', `step ${await c.evaluate('__mpm.diag.step')}`);
  await c.evaluate('__mpm.run()');
  await c.waitFor('!__mpm.running', 180000);
  const after = await c.evaluate('__mpm.diag');
  ok(after.phase === 'done', '"続ける" after stopafter runs on to the end', `${after.phase} at step ${after.step}`);
  await opened('?autorun=1&cells=6&L=8&stopafter=1e4');
  await c.waitFor('__mpm.done', 60000);
  ok((await c.evaluate('__mpm.diag.step')) === 10000, 'stopafter=1e4 is read as 10 000', `step ${await c.evaluate('__mpm.diag.step')}`);

  // ── the conditions panel against the URL ────────────────────────────────────
  const input = (name) => `document.querySelector('#panel input[name="${name}"]')`;
  const edit = (name, v) => c.evaluate(`(() => { const e = ${input(name)}; e.value = '${v}'; e.dispatchEvent(new Event('input')); })()`);
  const restart = () => c.evaluate("document.getElementById('reset').click()");
  await opened('?mu=0.8&ms=5e6');
  await edit('tb', '10');
  await restart();
  const p1 = await c.evaluate('__mpm.params');
  ok(p1.rolling.mu === 0.8 && p1.numerics.massScale === 5e6, 'values the URL accepts survive "条件を反映"', `μ ${p1.rolling.mu}, mass scale ${p1.numerics.massScale}`);
  await edit('mu', '5');
  await restart();
  const p2 = await c.evaluate('__mpm.params.rolling.mu');
  const shown = await c.evaluate(`${input('mu')}.value`);
  ok(+shown === p2, 'an out-of-range entry is clamped and the panel shows what runs', `runs μ ${p2}, panel shows ${shown}`);
  // stepUp() is what the ▲ of a number input does
  const spin = (name, v) => c.evaluate(`(() => { const e = ${input(name)}; e.value = '${v}'; e.stepUp(); return e.value; })()`);
  const ms = await spin('ms', '10000');
  const V = await spin('V', '1');
  ok(+ms === 11000 && +V === 1.1, 'the spin buttons step from round values', `mass scale 10000 → ${ms}, roll speed 1 → ${V}`);

  // ── a URL whose roll geometry has no bite ───────────────────────────────────
  await opened('?h0=50&r=70&R=5&cells=6&L=8');
  const g = await c.evaluate('__mpm.geometry');
  const r = await c.evaluate('__mpm.params.rolling');
  ok(Number.isFinite(g.contactLength) && g.contactLength > 0 && g.n > 0, 'h0=50&r=70&R=5 (no bite) is ignored', `contact length ${g.contactLength}, ${g.n} points, h0 ${r.h0 * 1e3} mm, R ${r.rollRadius * 1e3} mm`);

  // ── an exception while drawing does not stop the drawing ────────────────────
  await opened('?autorun=1&cells=6&L=8');
  await c.waitFor('__mpm.frames > 3', 30000);
  await c.evaluate('window.__throwOnce = true');
  await c.waitFor('window.__threw', 10000);
  const raf0 = await c.evaluate('window.__raf');
  let alive = true;
  await c.waitFor(`window.__raf > ${raf0 + 10}`, 5000).catch(() => (alive = false));
  ok(alive, 'drawing goes on after one draw throws', `${(await c.evaluate('window.__raf')) - raf0} animation frames since`);

  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
