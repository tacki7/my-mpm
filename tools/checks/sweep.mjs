// A sweep of conditions (src/mpm/solid/sweep.ts and sweepRun.ts, the 「条件の比較」 tab and tools/sweep.mjs):
// - sweepValues: the varied quantities linear from the first value to the last (both ends in), the others the
//   base's; the count held to 2 … MAX_CASES
// - sweepCase: the values go into the params (h0, the roll's radius from the diameter, μ, the width), the length is
//   'steady', a bending roll's barrel is lengthened to 1.5 of a wider strip; the base is not changed
// - runCase: one condition (W 2 mm, 4 cells, two passes, handoff 'steady') is a plain Tandem3 run: every pass
//   rolled, the same stands' results bit for bit
// - summarize: the numbers the page draws are the stands' (force, width, crown by pass; after the last pass the
//   crown, the spread against the entry width, the mid-width thickness, the flatness mid less edge, the largest
//   damage), the exit profile is mirrored, symmetric and 0 at the edges. About 3 min.
// @check 600s
import { ok, near, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { MAX_CASES, baseValues, summarize, sweepCase, sweepValues } from '../../src/mpm/solid/sweep.ts';
import { runCase } from '../../src/mpm/solid/sweepRun.ts';

const P0 = defaultParams();
P0.numerics.cellsThrough = 4;
const base = solidParams(P0, { width: 2e-3 });

// ── the values
{
  const v = sweepValues(base, { vary: { h0: [0.8e-3, 1.2e-3], mu: [0.05, 0.1] }, count: 5, stands: 4, handoff: 'steady' });
  ok(v.length === 5, 'five conditions');
  near(v[0].h0, 0.8e-3, 1e-12, 'the first condition has the first value');
  near(v[4].h0, 1.2e-3, 1e-12, 'the last the last');
  near(v[2].h0, 1.0e-3, 1e-12, 'linear between (the middle one)');
  near(v[1].mu, 0.0625, 1e-12, '… for every varied quantity at once');
  const b = baseValues(base);
  ok(v.every((c) => c.width === b.width && c.rollDiameter === b.rollDiameter), 'the others are the base\'s', JSON.stringify(b));
  ok(sweepValues(base, { vary: {}, count: 1, stands: 1, handoff: 'steady' }).length === 2 && sweepValues(base, { vary: {}, count: 99, stands: 1, handoff: 'steady' }).length === MAX_CASES, `the count is held to 2 … ${MAX_CASES}`);
}

// ── one condition's params
{
  const bent = solidParams(P0, { width: 2e-3, rollBend: { barrel: 6e-3 } });
  const before = JSON.stringify(bent);
  const P = sweepCase(bent, { h0: 1.1e-3, width: 5e-3, rollDiameter: 150e-3, mu: 0.12 });
  ok(P.rolling.h0 === 1.1e-3 && P.rolling.rollRadius === 75e-3 && P.rolling.mu === 0.12 && P.solid.width === 5e-3, 'the values go into the params (the radius is half the diameter)');
  ok(P.rolling.lengthMode === 'steady', 'the length is \'steady\'');
  ok(Math.abs(P.solid.rollBend.barrel - 7.5e-3) < 1e-15, 'a barrel shorter than 1.5 of the width is lengthened to it', `${P.solid.rollBend.barrel * 1e3} mm`);
  ok(JSON.stringify(bent) === before, 'the base is not changed');
}

// ── one condition rolled: a plain Tandem3
const values = { ...baseValues(base) };
const P = sweepCase(base, values);
let calls = 0;
const res = runCase(P, values, 2, 'steady', () => calls++, 1000);
const T = new Tandem3(P, 2, 'steady');
while (!T.done) T.advance();
ok(res.stopped === null && res.stands.length === 2 && res.stands[0].phase === 'steady' && res.stands[1].phase === 'done', 'both passes rolled', res.stands.map((r) => r.phase).join(', '));
ok(JSON.stringify(res.stands) === JSON.stringify(T.results), 'the stands\' results are a plain Tandem3\'s, bit for bit');
ok(calls > 0, 'the progress callback was called', `${calls} times`);

// ── the summary
const s = summarize(res);
const st = res.stands.map((r) => r.steady);
ok(s.force.every((f, k) => f === st[k].force) && s.width.every((w, k) => w === 2 * st[k].halfWidth) && s.crown.every((c, k) => c === st[k].crownOut), 'force, width and crown by pass are the stands\' steady means');
near(s.spread, (2 * st[1].halfWidth) / values.width - 1, 1e-12, 'the spread is the last pass\'s width against the entry width');
ok(s.crownOut === st[1].crownOut && s.thicknessOut === 2 * st[1].halfThickness[0] && s.maxDamage === Math.max(...res.stands.map((r) => r.maxDamage)), 'crown, thickness and damage after the last pass');
ok(s.force[1] > s.force[0] && s.spread > 0, 'the second pass rolls harder, the strip widens', `${(s.force[0] * 1e-3).toFixed(2)} → ${(s.force[1] * 1e-3).toFixed(2)} kN, ${(s.spread * 100).toFixed(2)} %`);
const n = s.profile.length;
ok(n === 2 * st[1].halfThickness.length && s.profile.every((v, i) => v === s.profile[n - 1 - i]) && s.profileZ.every((z, i) => z === -s.profileZ[n - 1 - i]), 'the profile is mirrored about the mid-width');
ok(s.profile[0] === 0 && s.profile[n - 1] === 0, '… and 0 at the edges');
done();
