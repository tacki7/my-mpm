// The stress explorer's tracker across the stands of a tandem (src/app/tracker.ts), stepped as the worker
// steps it: a crack that starts in stand 1 and grows in stands 2 and 3 (4340's damage, a small weak spot at
// the mid-plane, 4 cells, a 4 mm strip; about 10 s). The first crack's point in stand 3 descends from the
// point that started it in stand 1, not from whichever point sits at the record's stand-1 coordinates in a
// later stand (locating the record again there picks a descendant of stand 1's point 131 instead of 123), and
// a finished stand's tracker has let go of its Sim and keeps at most 24 samples a point.
// @check
import { ok, done } from './lib.mjs';
import { DAMAGE_4340, defaultParams } from '../../src/mpm/params.ts';
import { TandemSim } from '../../src/mpm/tandem.ts';
import { Tracker } from '../../src/app/tracker.ts';

const P = defaultParams();
P.numerics.cellsThrough = 4;
P.rolling.sheetLength = 4e-3;
P.damage = { ...DAMAGE_4340, etaCutoff: -2 };
P.defects = [{ kind: 'weak', x: 2e-3, y: 0, ax: 0.15e-3, ay: 0.3e-3, ductility: 0.02 }];

const t = new TandemSim(P, 3);
let tracker = new Tracker(t.sim);
let first = null; // stand 1's first crack point
const maps = []; // each switch's parentOf
let up = null; // the tracker of the stand before the last
let parentOf = null;
t.onStandDone = (e) => {
  tracker.record();
  if (e.stand === 0) first = tracker.tracks(null).find((k) => k.role === 'first-crack') ?? null;
  if (!e.next) return;
  maps.push(e.parentOf);
  up = tracker;
  parentOf = e.parentOf;
  tracker = new Tracker(e.next, { tracker, parentOf });
};
while (!t.done) {
  for (let k = 0; k < 20 && !t.done; k++) t.advance();
  tracker.record();
}

ok(t.results.length === 3 && t.stopped === null && t.results.every((r) => r.cracks === 1) && t.results[2].nFailed > t.results[0].nFailed,
  'the case: one crack record, started in stand 1, grown after', `${t.results.map((r) => `${r.cracks} record, ${r.nFailed} failed`).join('; ')}`);
ok(first !== null, 'stand 1 has a first crack point', first ? `point ${first.id}` : '');
const now = tracker.tracks(null).find((k) => k.role === 'first-crack');
let root = now ? now.id : -1;
for (let j = maps.length - 1; j >= 0 && root >= 0; j--) root = maps[j][root];
ok(!!now && root === first?.id && t.sim.failed[now.id] === 1,
  "stand 3's first crack point descends from stand 1's, and has failed",
  now ? `point ${now.id}, its stand-1 ancestor ${root} (stand 1's ${first?.id})` : 'no first-crack track');
ok(!!now && now.stand[0] === 0, 'its path starts in stand 1', `stands ${[...new Set(now?.stand ?? [])].join(',')}, ${now?.stand.length ?? 0} samples`);

// the finished stands' trackers: no Sim, their paths packed with at most 24 samples a point
ok(up !== null && up.sim === null && up.packed !== null, "stand 2's tracker has let go of its Sim once stand 3's took over");
let most = 0;
if (up?.packed) for (let p = 0; p + 1 < up.packed.start.length; p++) most = Math.max(most, (up.packed.start[p + 1] - up.packed.start[p]) / 3);
ok(most > 0 && most <= 24, 'and keeps at most 24 path samples a point', `${most} at most`);
let full = true;
for (let p = 0; p < t.sim.n && full; p += 7) {
  const f = tracker.fullPath(p);
  const q = parentOf[p];
  const before = q >= 0 && up?.packed ? (up.packed.start[q + 1] - up.packed.start[q]) / 3 : 0;
  full = f.stand.filter((k) => k === 1).length === before && f.path.length === 3 * f.stand.length;
}
ok(full, "a stand-3 point's samples of stand 2 are its parent's kept ones");
done();
