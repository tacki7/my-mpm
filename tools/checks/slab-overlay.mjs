// What the page draws over its charts (src/app/slabOverlay.ts): the slab method's force for
// the running condition equals karman() for it, the conditions outside the method are left
// out with a reason, the result is kept per condition, and the moving average takes the
// grid-crossing ripple out of the roll force. tools/browser/slab-overlay.mjs checks the page.
// @check
import { ok, near, between, done } from './lib.mjs';
import { SteadyForce, forceNote, movingAverage, slabRatio, slabReference, smoothingWindow, thicknessRatio } from '../../src/app/slabOverlay.ts';
import { karman } from '../../src/mpm/slab.ts';
import { presetById } from '../../src/mpm/presets.ts';

// ── the slab method as drawn = karman() for the same condition
for (const [id, mod, want] of [
  ['standard', () => {}, 3.027],
  ['central-burst', () => {}, 3.486],
  ['standard', (p) => (p.rolling.mu = 0.12), null],
]) {
  const P = presetById(id).build();
  mod(P);
  const s = slabReference(P);
  const k = karman(P.rolling, P.material);
  const name = `${id}${P.rolling.mu !== 0.08 && id === 'standard' ? `, μ ${P.rolling.mu}` : ''}`;
  near(s.force, k.force, 1e-12, `${name}: slab force = karman()`);
  if (want) near(s.force * 1e-6, want, 1e-3, `${name}: ${want} kN/mm`);
  ok(s.outside === null, `${name}: inside the method, drawn`);
}

// ── outside the method: not drawn, and why
{
  const ft = slabReference(presetById('front-tension').build());
  ok(ft.tensionAtYield && ft.outside?.includes('張力'), 'front-tension: tension at 2k, left out with the reason', ft.outside ?? 'drawn');
  const hf = slabReference(presetById('high-friction').build());
  ok(hf.sticking && hf.outside?.includes('固着'), 'high-friction: sticking friction, left out with the reason', hf.outside ?? 'drawn');
}

// ── solved once per condition
{
  const P = presetById('standard').build();
  const a = slabReference(P);
  ok(slabReference({ ...P, rolling: { ...P.rolling } }) === a, 'the same condition again: the kept result, not solved again');
  ok(slabReference({ ...P, rolling: { ...P.rolling, mu: 0.1 } }) !== a, 'a changed condition: solved again');
}

// ── the moving average: two periods of the ripple (2h/v_in) take it out
{
  const P = presetById('standard').build();
  P.numerics.cellsThrough = 6;
  const w = smoothingWindow(P);
  near(w, (4 * (1e-3 / 6)) / 0.75, 1e-12, 'window = 2 × 2h/v_in (6 cells: 0.89 ms)');
  // a steady 4.3 kN/mm with a 3 % ripple of that period, sampled every 25 µs
  const T = w / 2;
  const t = [];
  const y = [];
  for (let i = 0; i < 2000; i++) {
    t.push(i * 0.025);
    y.push(4.3 * (1 + 0.042 * Math.sin((2 * Math.PI * i * 25e-6) / T)));
  }
  const cv = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) / m;
  };
  const tail = (a) => a.slice(200);
  between(cv(tail(y)), 0.02, 0.04, 'the raw signal ripples by 3 %');
  ok(cv(tail(movingAverage(t, y, w * 1e3))) < 0.002, 'the moving average leaves under 0.2 %', `${(cv(tail(movingAverage(t, y, w * 1e3))) * 100).toFixed(3)} %`);
  ok(movingAverage(t, y, 0).every((v, i) => v === y[i]), 'a window of 0 is the raw signal');
  // centred: a ramp (the load rising into the bite) comes back as it is, not shifted by half the window
  const ramp = t.map((ti) => 2 * ti);
  const wMs = w * 1e3;
  const avg = movingAverage(t, ramp, wMs);
  let lag = 0;
  let inner = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < wMs / 2 || t[i] > t[t.length - 1] - wMs / 2) continue;
    lag = Math.max(lag, Math.abs(avg[i] - ramp[i]));
    inner++;
  }
  ok(inner > 1000 && lag < 1e-9, 'a ramp is not delayed (centred window)', `largest shift ${lag.toExponential(1)} kN/mm over ${inner} points`);
  // up to the newest frame too: the window narrows symmetrically at the ends instead of going one-sided
  let edge = 0;
  for (let i = 0; i < t.length; i++) edge = Math.max(edge, Math.abs(avg[i] - ramp[i]));
  ok(edge < 1e-9, 'a ramp is not delayed at the ends either (the newest frame is not lagged)', `largest shift ${edge.toExponential(1)} kN/mm`);
  // a non-finite sample breaks the line there only (charts.ts), it does not poison the rest
  const holed = y.slice();
  holed[300] = NaN;
  holed[301] = Infinity;
  const ma = movingAverage(t, holed, wMs);
  const bad = ma.filter((v) => !Number.isFinite(v)).length;
  ok(bad === 0, 'NaN / Inf samples are left out of the moving average', `${bad} non-finite points`);
}

// ── the note under the force chart follows the condition: Δ = mean thickness / contact length decides
// whether the slab method holds, and the ratio appears once the steady phase has started
{
  const std = slabReference(presetById('standard').build());
  const lc = Math.sqrt(0.1 * 0.25e-3 - 0.25e-3 ** 2 / 4);
  near(std.delta, 0.875e-3 / lc, 1e-12, 'standard: Δ = mean thickness / contact length (0.875 / 5.00 mm)');
  // the last argument says the pass is the standard preset's, whose measured range the note may quote
  const before = forceNote(std, null, undefined, true);
  ok(before.includes('定常になると') && before.includes('標準条件では 1.03〜1.07') && !before.includes('板が厚い'), 'standard, before the steady phase: no ratio, the standard range', before);
  const steady = forceNote(std, 1.0712 * std.force, undefined, true);
  ok(steady.includes('定常の MPM / スラブ法 = 1.07。') && steady.includes('標準条件では 1.03〜1.07'), 'standard, steady: the ratio 1.07 and the standard range', steady);
  // another condition gets the ratio, but the range is named as the standard condition's, not its own
  const other = forceNote(std, 1.0712 * std.force, undefined, false);
  ok(other.includes('定常の MPM / スラブ法 = 1.07。') && other.includes('この条件で測った範囲は無い') && other.includes('目安'), 'another condition: the ratio, and the range named as the standard condition\'s', other);
  near(slabRatio(std, 1.0712 * std.force), 1.0712, 1e-9, 'standard: MPM / slab = the steady force over the slab force');

  const P = presetById('central-burst').build();
  const thick = slabReference(P);
  near(thick.delta, thicknessRatio(P.rolling), 1e-12, 'central-burst: Δ from the preset');
  const d = thick.delta.toFixed(2);
  const tb = forceNote(thick, null);
  const ts = forceNote(thick, 1.47 * thick.force);
  ok(thick.delta > 1 && tb.includes(`Δ = 平均板厚 / 接触長 = ${d} > 1`) && tb.includes('低く見積もる') && tb.includes('スラブ法の線は参考') && !tb.includes('標準条件'),
    `central-burst (Δ ${d}), before the steady phase: the method underestimates a thick plate, the line is a reference`, tb);
  ok(ts.includes('定常の MPM / スラブ法 = 1.47（参考）') && !ts.includes('標準条件'), 'central-burst, steady: the ratio as a reference', ts);

  const ft = slabReference(presetById('front-tension').build());
  ok(forceNote(ft, 3e6) === '' && slabRatio(ft, 3e6) === null, 'front-tension (outside the method): no note, no ratio, whatever the steady force');

  // the steady mean: only the steady frames, each by the steps it covers, and a restart forgets them
  const sf = new SteadyForce();
  ok(sf.mean === null, 'steady mean: null before any frame');
  for (const [phase, rollForce, step] of [['bite', 1e6, 100], ['steady', 3e6, 400], ['steady', 3.4e6, 500], ['tail-out', 1e6, 600], ['steady', NaN, 700]]) sf.add({ phase, rollForce, step });
  near(sf.mean, 3.1e6, 1e-12, 'steady mean: the steady frames by their steps (300 × 3.0 and 100 × 3.4; bite, tail-out and NaN left out)');
  sf.reset();
  ok(sf.mean === null, 'steady mean: null again after a restart');
  sf.add({ phase: 'steady', rollForce: 2e6, step: 50 });
  near(sf.mean, 2e6, 1e-12, 'steady mean: counts the steps from 0 again after a restart');
}

// ── not crossing: the reason names the end the neutral point went to
{
  const ex = presetById('standard').build();
  ex.rolling.mu = 0.01; // too little friction: neutral point at the exit
  const a = slabReference(ex);
  ok(!a.crossed && a.outside?.includes('出口'), 'μ 0.01: neutral point at the exit, friction cannot draw the strip in', a.outside ?? 'drawn');
  const pull = presetById('standard').build();
  pull.rolling.frontTension = 450e6; // below 2k at the exit, but the strip is pulled through faster than the rolls
  const b = slabReference(pull);
  ok(!b.crossed && !b.tensionAtYield && b.outside?.includes('入口'), 'front tension 450 MPa: neutral point at the entry, the strip is pulled through', b.outside ?? 'drawn');
}
done();
