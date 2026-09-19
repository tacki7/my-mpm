// The shared conditions URL starts the same run: applyQuery(preset, conditionsQuery(…))
// gives back the conditions exactly (every leaf, bit for bit), for a preset left alone and
// for conditions changed everywhere; and a `cond` that is not ours changes nothing it
// should not (unknown keys, wrong types, prototype keys, broken base64, no bite).
// @check
import { ok, done } from './lib.mjs';
import { applyQuery, conditionsQuery } from '../../src/app/query.ts';
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
const noBite = applyQuery(base, new URLSearchParams({ cond: enc({ rolling: { h0: 0.05, reduction: 0.7, rollRadius: 0.005 } }) }));
ok(same(noBite.rolling, cloneParams(base).rolling), 'h0, r and R that cannot bite are ignored together, as with the readable keys');
done();
