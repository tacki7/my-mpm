// The slab-method reference and the moving average on the page's charts, in a headless
// Chrome: the drawn slab force equals karman() for the running condition (two presets and a
// changed μ), the conditions outside the method draw no slab line and say why in the legend
// (front-tension: tension at 2k; high-friction: sticking), the moving average of the roll
// force stays within 1 % over the steady phase of a coarse pass, the note under the force
// chart follows the condition (the standard pass: MPM / slab over its steady frames; the
// thick central-burst plate, Δ > 1: the method underestimates, the ratio as a reference),
// and the legends do not overlap on a narrow screen. Not a `@check` (it needs the dev server
// and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/slab-overlay.mjs <url> [out-prefix] [--timeout 180000]
//
// Writes <out-prefix>-standard.png, -narrow.png, -thick.png and -thick-narrow.png when a prefix
// is given; look at them. Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, near, between, done } from '../checks/lib.mjs';
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
            if (e.data?.type === 'frame') window.__frames.push({ t: e.data.diag.t, step: e.data.diag.step, phase: e.data.diag.phase, F: e.data.diag.rollForce });
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
    // before the steady phase: no ratio; the note depends on Δ only
    const f = await legend('legend-force');
    const thick = slab.delta > 1;
    ok(
      slab.ratio === null &&
        !f.includes('定常の MPM') &&
        (thick
          ? f.includes(`Δ = 平均板厚 / 接触長 = ${slab.delta.toFixed(2)}`) && f.includes('スラブ法の線は参考')
          : f.includes('定常になると') && (name === 'standard' ? f.includes('標準条件では 1.03〜1.07') : f.includes('この条件で測った範囲は無い'))),
      `${name}: before running, Δ ${slab.delta.toFixed(2)} → the ${thick ? 'thick-plate' : name === 'standard' ? 'standard' : 'other condition'} note, no ratio`,
      f.slice(f.indexOf('kN/mm') + 5),
    );
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
  // the ratio: the steady frames' force as the worker sent them, each by the steps since the frame before, over the slab force
  const ratioNote = async (name, lo, hi, reference) => {
    const slab = await c.evaluate('__mpm.slab');
    const all = await c.evaluate('__frames');
    let sum = 0;
    let steps = 0;
    let n = 0;
    for (let i = 0; i < all.length; i++) {
      const w = all[i].step - (i ? all[i - 1].step : 0);
      if (all[i].phase !== 'steady' || !Number.isFinite(all[i].F) || !(w > 0)) continue;
      sum += w * all[i].F;
      steps += w;
      n++;
    }
    const mean = sum / steps;
    near(slab.steadyForce, mean, 1e-9, `${name}: the steady force is the mean over the steady frames by their steps (${n} frames, ${steps} steps)`);
    near(slab.ratio, mean / slab.force, 1e-9, `${name}: ratio = steady force / slab force`);
    between(slab.ratio, lo, hi, `${name}: MPM / slab over the steady phase`);
    const f = await legend('legend-force');
    const want = `定常の MPM / スラブ法 = ${slab.ratio?.toFixed(2)}${reference ? '（参考）' : '。'}`;
    ok(f.includes(want), `${name}: the note gives it ("${want}")`, f.slice(f.indexOf('kN/mm') + 5));
    return slab;
  };
  await ratioNote('standard, 6 cells', 1.0, 1.12, false);
  ok(!(await legend('legend-force')).includes('板が厚い'), 'standard: no thick-plate note');
  if (shots) {
    await c.screenshot(`${shots}-standard.png`);
    console.log(`shot  ${shots}-standard.png`);
  }

  // ── a narrow screen: the legends wrap, their items do not overlap, nothing runs out of the figure
  const narrow = async (name, shot) => {
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
    for (const l of layout) ok(l.overlap === 0 && l.overflow <= 0, `${name}, narrow screen (700 px): ${l.id} items do not overlap or run out`, `${l.overlap} overlaps, overflow ${l.overflow} px`);
    if (shots) {
      await c.screenshot(`${shots}-${shot}.png`);
      console.log(`shot  ${shots}-${shot}.png`);
    }
    await c.setViewport(1600, 1000);
  };
  await narrow('standard', 'narrow');

  // ── a thick plate (Δ > 1): the slab method underestimates, the ratio is a reference
  await open('?preset=central-burst&cells=6&autorun=1');
  finished = true;
  await c.waitFor('__mpm.done', timeout).catch(() => (finished = false));
  await painted();
  const thick = await c.evaluate('__mpm.slab');
  ok(finished && thick.delta > 1, 'central-burst (6 cells) runs to the end, Δ > 1', `Δ ${thick.delta.toFixed(2)}`);
  await ratioNote('central-burst, 6 cells', 1.1, 2, true);
  const tf = await legend('legend-force');
  ok(tf.includes(`Δ = 平均板厚 / 接触長 = ${thick.delta.toFixed(2)} > 1`) && tf.includes('低く見積もる') && !tf.includes('標準条件'), 'central-burst: the thick-plate note, not the standard range', tf.slice(tf.indexOf('kN/mm') + 5));
  if (shots) {
    await c.screenshot(`${shots}-thick.png`);
    console.log(`shot  ${shots}-thick.png`);
  }
  await narrow('central-burst', 'thick-narrow');

  // ── the measured range under the chart belongs to the standard condition: another material must not borrow it
  await c.navigate(page('?cells=6&L=8&autorun=1'));
  await c.waitFor('__mpm.done', timeout);
  const std = await legend('legend-force');
  ok(std.includes('標準条件では 1.03〜1.07'), 'the standard pass quotes the measured range', std.slice(std.indexOf('スラブ法')));
  await c.navigate(page('?cells=6&L=8&mat=s4340&r=35&autorun=1'));
  await c.waitFor('__mpm.done', timeout);
  const other = await legend('legend-force');
  ok(!other.includes('標準条件では 1.03〜1.07') && other.includes('この条件で測った範囲は無い') && other.includes('目安'), 'another condition (4340, 35 %) says the range is not its own', other.slice(other.indexOf('スラブ法')));

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close?.();
  }
}
done();
