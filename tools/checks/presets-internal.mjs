// Internal cracks come from the stress state, not from the weak band alone:
// the central-burst plate (Δ ≈ 3.6, front tension, centreline segregation band)
// splits on the centreline in steady rolling; the same band does not crack when
// the plate is thinner against the contact arc (Δ ≈ 1.4) or without tension.
// (That the standard thin-sheet pass does not crack is asserted by rolling-smoke.mjs.)
// docs/presets.md has the measurements behind the numbers.
// @check
import { ok, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { presetById } from '../../src/mpm/presets.ts';

const mm = 1e-3;

/** Roll to the end (or until `stop` says so); returns the sim and the time the front tension came on. */
function roll(P, stop = () => false) {
  const t0 = performance.now();
  const s = new Sim(P);
  let tOn = Infinity;
  while (s.step < 200000) {
    for (let k = 0; k < 250; k++) s.advance();
    if (tOn === Infinity && s.headX() > s.xExitProbe) tOn = s.t;
    if (s.phase() === 'done' || stop(s, tOn)) break;
  }
  console.log(`      (${s.n} points, ${s.step} steps, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  return { s, tOn };
}

const fmt = (c) => `t ${(c.t / mm).toFixed(2)} ms, ${(c.sheetX / mm).toFixed(1)} mm from the head, y ${(c.sheetY / mm).toFixed(2)} mm, η ${c.eta.toFixed(2)}`;

// 1) central burst. The front tension is switched on as a step when the head passes the
// exit probe; the first few ms after that are a transient (a stress wave through the
// mass-scaled plate) that can crack the band by itself, so only later cracks count.
const burst = presetById('central-burst').build();
const h0 = burst.rolling.h0;
const TRANSIENT = 3e-3;
const steadyCentre = (s, tOn) => s.cracks.filter((c) => c.t > tOn + TRANSIENT && Math.abs(c.sheetY) < h0 / 4 && c.eta > 0);
const a = roll(burst, (s, tOn) => steadyCentre(s, tOn).length > 0);
const found = steadyCentre(a.s, a.tOn);
ok(found.length > 0, 'central-burst: a centreline crack (|y| < h0/4, η > 0) in steady rolling under front tension', found.length ? fmt(found[0]) : `${a.s.cracks.length} cracks in all, max D ${a.s.diagnostics().maxDamage.toFixed(3)}`);
const off = a.s.cracks.filter((c) => Math.abs(c.sheetY) >= h0 / 4);
ok(off.length === 0, 'central-burst: no crack away from the centreline', off.length ? fmt(off[0]) : '');

// 2) same band, same tension, but Δ ≈ 1.4: deformation reaches the centre, no tensile plastic flow there
const thin = presetById('central-burst').build();
Object.assign(thin.rolling, { h0: 4 * mm, reduction: 0.08, rollRadius: 25 * mm, sheetLength: 8 * mm });
thin.numerics.cellsThrough = 12;
thin.defects = [{ ...thin.defects[0], x: 4 * mm, ax: 5 * mm, ay: 0.06 * 4 * mm }];
const b = roll(thin);
ok(b.s.cracks.length === 0, 'same band at Δ ≈ 1.4: no crack', `max D ${b.s.diagnostics().maxDamage.toFixed(3)}`);

// 3) central-burst without the front tension
const free = presetById('central-burst').build();
free.rolling.frontTension = 0;
free.rolling.sheetLength = 8 * mm;
free.defects = [{ ...free.defects[0], x: 4 * mm, ax: 5 * mm }];
const c = roll(free);
ok(c.s.cracks.length === 0, 'central-burst without front tension: no crack', `max D ${c.s.diagnostics().maxDamage.toFixed(3)}`);

done();
