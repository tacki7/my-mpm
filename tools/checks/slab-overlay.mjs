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
  near(s.force, k.force, 1e-12, `${id}${P.rolling.mu !== 0.08 && id === 'standard' ? `, μ ${P.rolling.mu}` : ''}: slab force = karman()`);
  if (want) near(s.force * 1e-6, want, 1e-3, `${id}: ${want} kN/mm`);
  ok(s.outside === null, `${id}: inside the method, drawn`);
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
}
done();
