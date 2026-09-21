// The time left beside the clock (src/app/eta.ts), in a headless Chrome: the page samples what it shows four times
// a second while a run goes to its end, and each shown value is then held against the time the run really still
// took. The section model (one stand, then a pause in the middle: the pause is not part of the estimate), a tandem
// of two stands (the stand to come is a guess until it runs), the plan view and the 3D tab. Nothing is shown
// before a run starts or after it ends. Not a `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/eta.mjs <url> [out-prefix] [--timeout 300000]
//
// Writes <out-prefix>-section.png (the masthead while it runs) when a prefix is given; look at it. Prints one
// PASS / FAIL line per item and exits 1 if any failed. About 4 minutes.
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
const timeout = +opt('timeout', 300000);
const [target, shots] = argv;
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/eta.mjs <url> [out-prefix] [--timeout ms]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** what the page samples: the hook's seconds and the text on show, against the page's own clock */
const sampler = (hook, doneExpr) => `(() => {
  window.__eta = [];
  clearInterval(window.__etaTimer);
  window.__etaTimer = setInterval(() => {
    const h = ${hook};
    window.__eta.push({ w: performance.now(), eta: h.eta, text: document.getElementById('eta').textContent, running: h.running, done: !!(${doneExpr}) });
  }, 250);
  return true;
})()`;

/** the shown values of a finished run against what was really left: relative errors after `from` of the way (the running samples only) */
function errors(samples, from, paused = 0) {
  const end = samples.find((s) => s.done);
  const run = samples.filter((s) => s.running && s.eta != null && s.w < end.w);
  const w0 = samples.find((s) => s.running).w;
  const late = run.filter((s) => s.w - w0 >= from * (end.w - w0 - paused));
  return { n: run.length, late: late.map((s) => Math.abs(s.eta - (end.w - s.w) / 1e3) / Math.max((end.w - s.w) / 1e3, 3)), total: (end.w - w0) / 1e3, first: run[0] ? (run[0].w - w0) / 1e3 : null };
}

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const text = () => c.evaluate(`document.getElementById('eta').textContent`);
  // the sampler's next turn sees the end
  const samples = async () => (await c.waitFor('window.__eta.at(-1)?.done', 10000), c.evaluate('window.__eta'));
  const click = (id) => c.evaluate(`(document.getElementById(${JSON.stringify(id)}).click(), true)`);

  // ── the section model, one stand
  await c.navigate(page('?cells=8&L=16'));
  await c.waitFor('window.__mpm?.ready', 30000);
  ok((await text()) === '', 'nothing is shown before the run starts', JSON.stringify(await text()));
  await c.evaluate(sampler('__mpm', '__mpm.done'));
  await click('run');
  await c.waitFor('__mpm.eta != null', 30000);
  ok(/^残り 約 \d/.test(await text()), 'the time left is shown beside the clock while it runs', await text());
  if (shots) await c.screenshot(`${shots}-section.png`, { x: 0, y: 0, width: 1600, height: 120, scale: 1 });
  await c.waitFor('__mpm.done', timeout);
  {
    const e = errors(await samples(), 0.25);
    between(e.first, 0, 6, `the first estimate comes within seconds (run ${e.total.toFixed(1)} s)`);
    between(median(e.late), 0, 0.15, `section: the shown time left against the real one, median error after a quarter of the run (${e.late.length} samples)`);
    between(Math.max(...e.late), 0, 0.4, 'section: the worst of them');
    ok((await text()) === '', 'nothing is shown after the run ends', JSON.stringify(await text()));
  }

  // ── a pause is not part of it
  await click('reset');
  await c.waitFor('window.__mpm?.ready && __mpm.frames <= 1', 30000);
  await c.evaluate(sampler('__mpm', '__mpm.done'));
  await click('run');
  await c.waitFor('__mpm.eta != null && __mpm.diag.phase === "steady"', timeout);
  await click('pause');
  // the worker's last running frames may still be on their way when the button says paused
  await c.waitFor('!__mpm.running', 10000);
  await c.waitFor(`new Promise((r) => { const a = __mpm.frames; setTimeout(() => r(__mpm.frames === a), 500); })`, 10000);
  const before = await c.evaluate('__mpm.eta');
  await new Promise((r) => setTimeout(r, 4000));
  ok((await c.evaluate('__mpm.eta')) === before && /^残り/.test(await text()), 'paused: the time left stands still and stays on show', `${before.toFixed(1)} s, ${await text()}`);
  await click('run');
  await c.waitFor('__mpm.done', timeout);
  {
    // the samples after the pause, against the real end
    const all = await samples();
    const resumed = all.findIndex((s, i) => i > 0 && s.running && !all[i - 1].running && all.slice(0, i).some((q) => q.running));
    const e = errors(all.slice(resumed), 0);
    between(median(e.late), 0, 0.15, `after the pause the estimate does not count the 4 s it stood (median error, ${e.late.length} samples)`);
  }

  // ── a tandem of two stands: the second stand is a guess until it runs
  for (const handoff of ['steady', 'done']) {
    await c.navigate(page(`?cells=6&L=10&stands=2&handoff=${handoff}`));
    await c.waitFor('window.__mpm?.ready', 30000);
    await c.evaluate(sampler('__mpm', '__mpm.done'));
    await click('run');
    await c.waitFor('__mpm.done', timeout);
    const all = await samples();
    const e = errors(all, 0.25);
    between(median(e.late), 0, 0.35, `tandem, handoff ${handoff}: median error after a quarter of the pass (run ${e.total.toFixed(1)} s, ${e.late.length} samples)`);
    between(Math.max(...e.late), 0, 1.0, `tandem, handoff ${handoff}: the worst of them`);
  }

  // ── the plan view
  await c.navigate(page('?view=plan&W=20'));
  await c.waitFor('window.__mpm?.plan?.ready', 30000);
  await c.evaluate(sampler('__mpm.plan', '__mpm.plan.done'));
  await click('run');
  await c.waitFor('__mpm.plan.done', timeout);
  {
    const e = errors(await samples(), 0.25);
    between(median(e.late), 0, 0.2, `plan view: median error after a quarter of the run (run ${e.total.toFixed(1)} s, ${e.late.length} samples)`);
    ok((await text()) === '', 'plan view: nothing is shown after the run ends', JSON.stringify(await text()));
  }

  // ── the 3D tab
  await c.navigate(page('?dim=3&W3=2&L3=8&cells3=4'));
  await c.waitFor('window.__mpm?.solid?.ready', 30000);
  await c.evaluate(sampler('__mpm.solid', '__mpm.solid.done'));
  await click('run');
  await c.waitFor('__mpm.solid.done', timeout);
  {
    const e = errors(await samples(), 0.25);
    between(median(e.late), 0, 0.2, `3D: median error after a quarter of the run (run ${e.total.toFixed(1)} s, ${e.late.length} samples)`);
    ok((await text()) === '', '3D: nothing is shown after the run ends', JSON.stringify(await text()));
  }
  await c.navigate('about:blank');
} catch (e) {
  ok(false, 'the run went through', String(e?.stack ?? e));
} finally {
  c?.close();
}
done();
