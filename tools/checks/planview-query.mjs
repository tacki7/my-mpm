// The plan view's URL keys (W, wcells, notch, and the edge scatter's escatter, ewidth, elen, eseed) as
// the page reads them (src/app/planQuery.ts): each in its range or ignored, parsed like the section
// model's keys, checked together — a shared link must not start more points than MAX_POINTS (as
// applyQuery does for the section model), a notch deeper than a quarter of the width is ignored and a
// scattered band wider than the half width is cut back to it — and written back to the same settings.
// @check
import { ok, near, done } from './lib.mjs';
import { planPoints, planSettingsOf, planSettingsQuery } from '../../src/app/planQuery.ts';
import { MAX_POINTS } from '../../src/app/query.ts';
import { PLAN_DEFAULTS } from '../../src/mpm/planview/condition.ts';
import { PlanSim } from '../../src/mpm/planview/sim.ts';
import { planCondition } from '../../src/mpm/planview/condition.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const L = 16e-3;
const ppc = defaultParams().numerics.ppc;
const of = (qs, len = L) => planSettingsOf(new URLSearchParams(qs), len, ppc);
const same = (a, b) =>
  a.width === b.width && a.cells === b.cells && a.notch === b.notch &&
  a.edgeAmount === b.edgeAmount && a.edgeWidth === b.edgeWidth && a.edgeLength === b.edgeLength && a.edgeSeed === b.edgeSeed;

ok(same(of(''), PLAN_DEFAULTS), 'no keys: the defaults (W 20 mm, 10 cells, no notch)');
const s = of('W=16&wcells=8&notch=0.5');
ok(s.width === 16e-3 && s.cells === 8 && Math.abs(s.notch - 0.5e-3) < 1e-15, 'W, wcells and notch in range are taken', JSON.stringify(s));
ok(same(of('W=1&wcells=3&notch=-1'), PLAN_DEFAULTS) && same(of('W=201&wcells=101&notch=6'), PLAN_DEFAULTS), 'out of range: ignored');
ok(same(of('W=0x10&wcells=abc&notch='), PLAN_DEFAULTS), 'parsed like the other keys (parseFloat: 0x10 is 0, not 16)');
ok(of('wcells=9.6').cells === 10, 'cells are rounded');

// points together: W 2 mm with 100 cells is 640 000 points on a 16 mm strip
const big = { width: 2e-3, cells: 100, notch: 0 };
ok(planPoints(big, L, ppc) > MAX_POINTS, `W 2 mm × 100 cells × 16 mm is more than ${MAX_POINTS} points`, `${planPoints(big, L, ppc).toFixed(0)}`);
ok(same(of('W=2&wcells=100'), PLAN_DEFAULTS), 'too many points: width and cells back to the defaults');
const short = of('W=2&wcells=100', 4e-3);
ok(short.width === 2e-3 && short.cells === 100, 'the same keys on a 4 mm strip (160 000 points) are kept', JSON.stringify(short));
// the estimate is the lattice the model builds
const sim = new PlanSim(planCondition({ ...defaultParams(), rolling: { ...defaultParams().rolling, sheetLength: L } }, PLAN_DEFAULTS));
near(sim.n, planPoints(PLAN_DEFAULTS, L, ppc), 0.02, 'the point estimate = the points the model makes (W 20 mm, 10 cells, 16 mm)');

// the notch against the width: at most a quarter of it
ok(of('W=4&notch=3').notch === 0 && of('W=2&notch=5').notch === 0, 'a notch deeper than a quarter of the width is ignored (W 4 notch 3, W 2 notch 5)');
ok(Math.abs(of('W=4&notch=1').notch - 1e-3) < 1e-15, 'a notch of a quarter of the width is kept (W 4 notch 1)');

// the edge scatter's four keys
const e = of('escatter=20&ewidth=2&elen=0.5&eseed=7');
ok(e.edgeAmount === 0.2 && Math.abs(e.edgeWidth - 2e-3) < 1e-15 && Math.abs(e.edgeLength - 0.5e-3) < 1e-15 && e.edgeSeed === 7,
  'escatter, ewidth, elen and eseed in range are taken', JSON.stringify(e));
ok(same(of('escatter=51&ewidth=0.05&elen=-1&eseed=0'), PLAN_DEFAULTS), 'the edge keys out of range: ignored (escatter 51 %, band 0.05 mm, length −1 mm, seed 0)');
ok(of('eseed=7.6').edgeSeed === 8, 'the seed is rounded');
ok(of('elen=0').edgeLength === 0, 'a correlation length of 0 (one value per point) is kept, not read as missing');
// the band against the width: at most the half width, cut back rather than dropped — a link that
// asks for a band wider than the strip still means "the whole half width is scattered"
ok(Math.abs(of('W=2&ewidth=5').edgeWidth - 1e-3) < 1e-15, 'a band wider than the half width is cut back to it (W 2 mm, ewidth 5 mm → 1 mm)', `${of('W=2&ewidth=5').edgeWidth * 1e3} mm`);

// without scatter the band, length and seed change nothing, so a shared link does not carry them
ok(planSettingsQuery(of('ewidth=2&elen=0.5&eseed=7')).length === 0, 'amount 0: the band, the length and the seed stay out of the URL', JSON.stringify(planSettingsQuery(of('ewidth=2&elen=0.5&eseed=7'))));
ok(planSettingsQuery(of('escatter=20&ewidth=2')).length === 2, 'with scatter they are written', JSON.stringify(planSettingsQuery(of('escatter=20&ewidth=2'))));

// written back: the same settings
for (const qs of ['', 'W=16&wcells=8&notch=0.5', 'W=37.5&wcells=13', 'notch=2.25', 'escatter=20&ewidth=2&elen=0.5&eseed=7', 'escatter=5.5&elen=0']) {
  const a = of(qs);
  const b = of(new URLSearchParams(planSettingsQuery(a)).toString());
  ok(same(a, b), `round trip: ?${qs || '(defaults)'} → the keys → the same settings`, new URLSearchParams(planSettingsQuery(a)).toString() || '(no keys)');
}

// the section model's defects stay out of the plan view (their y is a thickness position)
const withVoid = { ...defaultParams(), defects: [{ kind: 'void', x: 4e-3, y: 0, ax: 0.2e-3, ay: 0.2e-3 }] };
ok(planCondition(withVoid, PLAN_DEFAULTS).defects.length === 0, "the section model's defects are not carried into the plan view");
ok(planCondition(withVoid, { ...PLAN_DEFAULTS, notch: 0.5e-3 }).defects.length === 1, 'the notch is the only defect');
done();
