// The shared conditions URL starts the same run: applyQuery(preset, conditionsQuery(…))
// gives back the conditions exactly (every leaf, bit for bit), for a preset left alone and
// for conditions changed everywhere; and a `cond` that is not ours changes nothing it
// should not (unknown keys, wrong types, prototype keys, broken base64, no bite).
// @check
import { ok, near, done } from './lib.mjs';
import { MAX_POINTS, applyQuery, conditionsQuery, points } from '../../src/app/query.ts';
import { PRESETS } from '../../src/mpm/presets.ts';
import { cloneParams, STEEL_4340 } from '../../src/mpm/params.ts';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const roundTrip = (id, p) => {
  const preset = PRESETS.find((x) => x.id === id).build();
  const q = conditionsQuery(id, preset, p);
  return { q, back: applyQuery(preset, new URLSearchParams(q.toString())) };
};

// every preset, unchanged: only the preset in the URL
for (const pr of PRESETS) {
  const p = pr.build();
  const { q, back } = roundTrip(pr.id, p);
  ok(same(back, p) && [...q.keys()].join() === 'preset', `${pr.id} unchanged: preset only, same conditions`, q.toString());
}

// changed everywhere, with values that do not survive mm / % / MPa text exactly
const p = PRESETS.find((x) => x.id === 'standard').build();
p.rolling.h0 = 1.23456789e-3;
p.rolling.reduction = 0.3171;
p.rolling.rollRadius = 87.3e-3;
p.rolling.sheetLength = 9.87654321e-3;
p.rolling.mu = 0.1234567;
p.rolling.frontTension = 123.456e6;
p.rolling.rollSpeed = 1.7;
p.rolling.tensionRamp = 1.5e-3;
p.material = { ...STEEL_4340, jcA: 801.5e6, jcN: 0.2712 };
p.damage.D2 = 1.111;
p.damage.D4 = 0.0031;
p.damage.clCrit = 0.4321;
p.damage.nonlocalLength = 0.12e-3;
p.damage.failure = 'erode';
p.damage.model = 'cockcroft-latham';
p.damage.yield = 'gtn';
p.damage.gtn.q1 = 1.43;
p.damage.gtn.nucleation = 'always';
p.numerics.cellsThrough = 7;
p.numerics.jbar = false;
p.numerics.cfl = 0.33;
p.defects = [
  { kind: 'void', x: 2.5e-3, y: 0.1e-3, ax: 0.3e-3, ay: 0.08e-3 },
  { kind: 'weak', x: 4e-3, y: -0.2e-3, ax: 0.9e-3, ay: 0.25e-3, ductility: 0.35 },
];
const { q, back } = roundTrip('standard', p);
ok(same(back, p), 'conditions changed everywhere come back exactly', same(back, p) ? `${q.toString().length} characters` : JSON.stringify(back));
ok(q.has('h0') && q.has('mu') && q.has('mat') && q.has('cond'), 'the common ones stay readable, the rest goes in cond', [...q.keys()].join(' '));

// a cond that is not ours
const base = PRESETS[0].build();
const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bad = applyQuery(base, new URLSearchParams({
  cond: enc({ rolling: { mu: 'x', nope: 5, h0: Infinity }, numerics: { jbar: 1 }, damage: { gtn: 'flat' }, defects: [{ kind: 'void', x: 1, y: 0, ax: -1, ay: 1 }, { kind: 'hole' }] }),
}));
ok(same(bad, base), 'wrong types, unknown keys and bad defects are ignored');
applyQuery(base, new URLSearchParams({ cond: btoa('{"__proto__":{"polluted":true},"rolling":{"__proto__":{"polluted":true}}}') }));
ok({}.polluted === undefined, 'prototype keys do not reach Object.prototype');
ok(same(applyQuery(base, new URLSearchParams({ cond: '%%%not base64' })), base), 'a broken cond is ignored');
// values outside their ranges (a crafted link must not freeze whoever opens it)
const huge = applyQuery(base, new URLSearchParams({
  cond: enc({
    numerics: { cellsThrough: 1e6, massScale: 1e-9, ppc: 3.5, cfl: 5 },
    rolling: { sheetLength: 10, rollSpeed: 1e5, mu: 3, tensionRamp: -1 },
    material: { E: 1, nu: 0.7, hardening: 'glass', swN: 9 },
    damage: { model: 'foo', gtn: { fc: 7 } },
    defects: [{ kind: 'void', x: 1, y: 0, ax: 0.01, ay: 0.001 }],
  }),
}));
ok(same(huge, base), 'out-of-range values, unknown choices and defects outside the sheet are ignored', same(huge, base) ? '' : JSON.stringify(huge));
const tooMany = applyQuery(base, new URLSearchParams({ cells: '80', L: '500', h0: '0.05' }));
ok(same(tooMany.rolling, base.rolling) && same(tooMany.numerics, base.numerics), `a run with more than ${MAX_POINTS} points from the URL falls back to the preset's size`);
const fine = applyQuery(base, new URLSearchParams({ cells: '80' }));
ok(fine.numerics.cellsThrough === 80, 'the largest the URL keys allow at the default length still runs', `${points(fine)} points`);
// a tandem: each stand has 1/(1 − r)² times the points of the one before, and the cap counts them all
{
  const one = applyQuery(base, new URLSearchParams({ cells: '12' }));
  const three = applyQuery(base, new URLSearchParams({ cells: '12', stands: '3' }));
  const q = 1 / (1 - base.rolling.reduction) ** 2;
  near(points(three), points(one) * (1 + q + q * q), 1e-12, 'the points of 3 stands: 1 + 1/(1 − r)² + 1/(1 − r)⁴ times one stand\'s');
  const wide = applyQuery(base, new URLSearchParams({ stands: '5', cells: '40' }));
  ok(wide.rolling.stands === 5 && wide.numerics.cellsThrough === base.numerics.cellsThrough && points(wide) <= MAX_POINTS,
    `5 stands at 40 cells (${(points({ ...wide, numerics: { ...wide.numerics, cellsThrough: 40 } }) / 1e6).toFixed(1)} M points): the stands stay, the grid goes back to the preset's`,
    `${wide.rolling.stands} stands, ${wide.numerics.cellsThrough} cells, ${points(wide).toFixed(0)} points`);
  const steep = applyQuery(base, new URLSearchParams({ stands: '5', r: '60', cells: '40' }));
  ok((steep.rolling.stands ?? 1) === 1 && steep.rolling.reduction === 0.6 && steep.numerics.cellsThrough === base.numerics.cellsThrough && points(steep) <= MAX_POINTS,
    '5 stands at r 60 % are too many points even on the preset\'s grid: back to one stand, the reduction kept',
    `${steep.rolling.stands} stand, r ${steep.rolling.reduction}, ${points(steep).toFixed(0)} points`);
}
// one stand is no stands at all: ?stands=1 (or a tandem set back to one) writes neither stands nor a cond
{
  const one = applyQuery(base, new URLSearchParams({ stands: '1' }));
  const q = conditionsQuery('standard', base, one);
  ok(!('stands' in one.rolling) && !q.has('stands') && !q.has('cond'), '?stands=1 is one stand as the preset has it: no stands key, and its URL has neither stands nor cond', q.toString());
}
const noBite = applyQuery(base, new URLSearchParams({ cond: enc({ rolling: { h0: 0.05, reduction: 0.7, rollRadius: 0.005 } }) }));
ok(same(noBite.rolling, cloneParams(base).rolling), 'h0, r and R that cannot bite are ignored together, as with the readable keys');
done();
