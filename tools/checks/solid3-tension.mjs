// Strip tensions in the 3D model (Sim3.updateTension, as the section model's tension.mjs): the grip's load is the
// tension times the end column's actual section, the exit strip carries the front tension and the entry strip the
// back tension (both about 96 MPa for 100 here: the volume counts the section a little small, as in the section
// model), 'steady' waits for the front tension's ramp, and the back tension lets go once the tail is at the rolls.
// W 2 mm, 4 cells, 12 mm, about a minute.
// @check
import { ok, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';

const MPa = 1e6;

function strip(tb, tf) {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 12e-3;
  P.damage.model = 'none';
  P.rolling.backTension = tb;
  P.rolling.frontTension = tf;
  return new Sim3(solidParams(P, { width: 2e-3, planeStrain: false }));
}

/** section-weighted mean of σxx over the points with x in [x0, x1] */
function sectionStress(s, x0, x1) {
  let f = 0;
  let a = 0;
  for (let p = 0; p < s.n; p++) {
    if (!s.active[p] || s.px[p] < x0 || s.px[p] > x1) continue;
    const A = s.section(p);
    f += (s.sxx[p] - s.pres[p]) * A;
    a += A;
  }
  return a ? f / a : NaN;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

// ── front tension
{
  const s = strip(0, 100 * MPa);
  const phases = [];
  const exit = [];
  let loadOff = 0;
  let loads = 0;
  let short = 0;
  let ph;
  do {
    for (let k = 0; k < 500; k++) s.advance();
    ph = s.phase();
    if (phases.at(-1) !== ph) phases.push(ph);
    if (s.frontNow > 0) {
      loads++;
      if (Math.abs(s.endLoad(2) - s.frontNow * s.endSection(2)) > 1e-3 * s.endLoad(2)) loadOff++;
    }
    if (ph === 'steady') {
      exit.push(sectionStress(s, s.xExitProbe, s.xExitProbe + 2e-3));
      if (s.frontNow !== 100 * MPa) short++;
    }
  } while (ph !== 'done' && ph !== 'stalled' && s.step < 60000);
  ok(loads > 5 && loadOff === 0, 'front grip load = σf × the head column section, every look with the tension on', `${loads} looks`);
  ok(phases.join(' ') === 'bite adjusting steady tail-out done', "phases: 'adjusting' while the front tension ramps up, then 'steady'", phases.join(' '));
  ok(exit.length >= 3 && short === 0, "every 'steady' look is under the whole front tension", `${short} of ${exit.length} under less`);
  near(mean(exit) / MPa, 100, 0.1, 'exit strip stress [MPa] under 100 MPa front tension');
}

// ── back tension
{
  const s = strip(100 * MPa, 0);
  const entry = [];
  let loadOff = 0;
  let loads = 0;
  let after = 0;
  let slow = 0;
  let ph;
  do {
    for (let k = 0; k < 50; k++) s.advance();
    ph = s.phase();
    if (s.backNow > 0) {
      loads++;
      if (Math.abs(s.endLoad(1) + s.backNow * s.endSection(1)) > 1e-3 * Math.abs(s.endLoad(1))) loadOff++;
    }
    const tail = s.tailX();
    if (s.backNow === 100 * MPa && !s.pusherActive && tail < -s.contactLength - 3e-3) entry.push(sectionStress(s, tail + 1.2e-3, tail + 3.2e-3));
    if (ph === 'done' || (tail > 0 && Number.isFinite(tail))) {
      after++;
      let v = 0;
      let c = 0;
      for (let p = 0; p < s.n; p++) if (s.active[p]) (v += s.vx[p]), c++;
      if (c && v / c < 0.8 * s.params.rolling.rollSpeed) slow++;
    }
  } while (ph !== 'done' && ph !== 'stalled' && s.step < 60000);
  ok(loads > 50 && loadOff === 0, 'back grip load = σb × the tail column section, every look with the tension on', `${loads} looks`);
  near(mean(entry) / MPa, 100, 0.1, 'entry strip stress [MPa] under 100 MPa back tension');
  ok(ph === 'done' && after > 0 && slow === 0, 'the strip leaves at the roll speed once the tail is through (no back tension left)', `${slow} of ${after} looks slow`);
}
done();
