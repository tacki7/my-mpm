// The slab-method reference and the moving average on the page's charts, in a headless
// Chrome: the drawn slab force equals karman() for the running condition (two presets and a
// changed μ), the conditions outside the method draw no slab line and say why in the legend
// (front-tension: tension at 2k; high-friction: sticking), the moving average of the roll
// force stays within 1 % over the steady phase of a coarse pass, and the legends do not
// overlap on a narrow screen. Not a `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/slab-overlay.mjs <url> [out-prefix] [--timeout 180000]
//
// Writes <out-prefix>-standard.png and <out-prefix>-narrow.png when a prefix is given;
// look at them. Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';
import { karman } from '../../src/mpm/slab.ts';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const timeout = +opt('timeout', 180000);
const [target, shots] = argv;
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/slab-overlay.mjs <url> [out-prefix] [--timeout ms]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;
const cv = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) / m;
};

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  // every frame's diagnostics from the worker, recorded from before the page runs (see smoke.mjs)
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const W = window.Worker;
      window.__frames = [];
      window.Worker = class extends W {
        constructor(...a) {
          super(...a);
          this.addEventListener('message', (e) => {
            if (e.data?.type === 'frame') window.__frames.push({ t: e.data.diag.t, phase: e.data.diag.phase });
          });
        }
      };
    })();`,
  });
  const legend = (id) => c.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const open = async (query) => {
    await c.navigate(page(query));
    await c.waitFor('window.__mpm?.ready', 30000);
    await c.waitFor(`document.getElementById('legend-force').textContent.length > 0`, 10000);
  };

  // ── inside the method: the drawn force is karman() for the running condition
  for (const [name, query] of [
    ['standard', '?cells=6&L=8'],
    ['central-burst', '?preset=central-burst&cells=6'],
    ['standard, μ 0.12', '?cells=6&L=8&mu=0.12'],
  ]) {
    await open(query);
    const P = await c.evaluate('__mpm.params');
    const slab = await c.evaluate('__mpm.slab');
    const want = karman(P.rolling, P.material);
    near(slab.force, want.force, 1e-12, `${name}: the drawn slab force = karman() for the page's condition (${(want.force * 1e-6).toFixed(3)} kN/mm)`);
    ok(slab.outside === null && slab.points > 100, `${name}: inside the method, the slab curves are drawn`, `${slab.points} points`);
    ok((await legend('legend-force')).includes('スラブ法（Kármán）') && (await legend('legend-hill')).includes('スラブ法 p'), `${name}: the legends name the slab method`);
  }

  // ── outside the method: no slab line, the reason in the legends
  for (const [name, query, word] of [
    ['front-tension', '?preset=front-tension&cells=6', '張力'],
    ['high-friction', '?preset=high-friction&cells=6', '固着'],
  ]) {
    await open(query);
    const slab = await c.evaluate('__mpm.slab');
    const f = await legend('legend-force');
    const h = await legend('legend-hill');
    ok(slab.outside?.includes(word) && !f.includes('スラブ法（Kármán）') && f.includes(word) && h.includes(word) && !h.includes('スラブ法 p'), `${name}: no slab line, the legends say why ("${word}")`, slab.outside ?? 'drawn');
  }

  // ── a coarse pass: over the steady phase the moving average (the main line) stays within 1 %
  await open('?autorun=1&cells=6&L=8');
  let finished = true;
  await c.waitFor('__mpm.done', timeout).catch(() => (finished = false));
  await painted();
  const frames = await c.evaluate('__frames');
  const steady = frames.filter((f) => f.phase === 'steady').map((f) => f.t * 1e3);
  const chart = await c.evaluate('__mpm.forceChart');
  ok(finished && steady.length > 10 && chart, 'the pass runs to the end with steady frames', `${steady.length} steady frames`);
  if (steady.length && chart) {
    // half a window inside each end of the steady phase (the centred average there holds only steady frames)
    const from = Math.min(...steady) + chart.windowMs / 2;
    const to = Math.max(...steady) - chart.windowMs / 2;
    const pick = (a) => a.filter((_, i) => chart.t[i] >= from && chart.t[i] <= to);
    const smooth = pick(chart.smooth);
    const raw = pick(chart.raw);
    ok(smooth.length > 10 && cv(smooth) < 0.01, 'steady phase: the moving average varies by less than 1 %', `${(cv(smooth) * 100).toFixed(2)} % (one frame's means: ${(cv(raw) * 100).toFixed(2)} %), window ${chart.windowMs.toFixed(3)} ms, ${smooth.length} points`);
  }
  if (shots) {
    await c.screenshot(`${shots}-standard.png`);
    console.log(`shot  ${shots}-standard.png`);
  }

  // ── a narrow screen: the legends wrap, their items do not overlap, nothing runs out of the figure
  await c.setViewport(700, 1400);
  await painted();
  await painted();
  const layout = await c.evaluate(`['legend-force', 'legend-hill'].map((id) => {
    const el = document.getElementById(id);
    const r = [...el.children].map((e) => e.getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j];
      if (a.width && b.width && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlap++;
    }
    return { id, overlap, overflow: el.scrollWidth - el.clientWidth };
  })`);
  for (const l of layout) ok(l.overlap === 0 && l.overflow <= 0, `narrow screen (700 px): ${l.id} items do not overlap or run out`, `${l.overlap} overlaps, overflow ${l.overflow} px`);
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
