// What the page draws over its charts (src/app/slabOverlay.ts): the slab method's force for
// the running condition equals karman() for it, the conditions outside the method are left
// out with a reason, the result is kept per condition, and the moving average takes the
// grid-crossing ripple out of the roll force. tools/browser/slab-overlay.mjs checks the page.
// @check
import { ok, near, between, done } from './lib.mjs';
import { movingAverage, slabReference, smoothingWindow } from '../../src/app/slabOverlay.ts';
import { karman } from '../../src/mpm/slab.ts';
import { presetById } from '../../src/mpm/presets.ts';

// ── the slab method as drawn = karman() for the same condition
for (const [id, mod, want] of [
  ['standard', () => {}, 3.027],
  ['central-burst', () => {}, 3.687],
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
