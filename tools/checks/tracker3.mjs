// The stress explorer's tracker of the 3D model (src/app/tracker3.ts), stepped as the worker steps it. A strip that
// cracks (4340's Johnson-Cook damage with D2 cut to 0.15, W 2 mm, 4 cells, 8 mm; a single stand at 30 % and a
// 2-stand tandem at 25 % whose first stand stays whole and second cracks; about a minute): every point's path grows
// with its plastic strain, the first-crack track is Sim3.firstCrack's point and ends at the crack's η with D = 1,
// the most damaged intact point's state is the Sim3's, in the tandem stand 2's first crack is stand 2's own point
// index (not mapped through parentOf again), its path starts in stand 1 through Sim3.parentOf and goes on in
// stand 2, and a finished stand's tracker has let go of its Sim3 and keeps at most 24 samples a point.
// @check
import { ok, near, done } from './lib.mjs';
import { DAMAGE_4340, defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { Tracker3 } from '../../src/app/tracker3.ts';

function params(r) {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 8e-3;
  P.rolling.reduction = r;
  P.damage = { ...DAMAGE_4340, D2: 0.15, etaCutoff: -2 };
  return solidParams(P, { width: 2e-3, planeStrain: false });
}

// ── one stand
{
  const s = new Sim3(params(0.3));
  const tr = new Tracker3(s);
  let grows = 0; // steady looks where the paths gained samples
  let looks = 0;
  let samples = 0;
  const count = () => {
    let m = 0;
    for (let p = 0; p < s.n; p += 7) m += tr.fullPath(p).path.length;
    return m;
  };
  let ph;
  do {
    for (let k = 0; k < 20; k++) s.advance();
    tr.record();
    const now = count();
    if (s.phase() === 'steady') {
      looks++;
      if (now > samples) grows++;
    }
    samples = Math.max(samples, now);
    ph = s.phase();
  } while (ph !== 'done' && ph !== 'stalled' && s.step < 40000);
  const tracks = tr.tracks();
  const fc = tracks.find((k) => k.role === 'first-crack');
  const md = tracks.find((k) => k.role === 'max-damage');
  let nFailed = 0;
  for (let p = 0; p < s.n; p++) if (s.failed[p]) nFailed++;
  ok(ph === 'done' && s.firstCrack !== null && nFailed > 10, 'the case: the pass ends with cracks', `${ph}, ${nFailed} failed points`);
  ok(!!fc && fc.id === s.firstCrack?.point && fc.state.failed, "the first-crack track is Sim3.firstCrack's point, failed", `point ${fc?.id}, crack's ${s.firstCrack?.point}`);
  const last = fc ? fc.path.slice(-3) : [];
  ok(fc && Math.abs(last[0] - s.firstCrack.eta) < 1e-12 && Math.abs(last[2] - 1) < 0.05 && fc.path.length >= 30, "its path ends at the crack's η with D = 1", `η ${last[0]?.toFixed(3)} (crack ${s.firstCrack?.eta.toFixed(3)}), D ${last[2]?.toFixed(3)}, ${fc?.path.length / 3} samples`);
  ok(fc && fc.path.every((v, i) => i % 3 !== 1 || i < 3 || v >= fc.path[i - 3] - 1e-12), 'εp along the path never decreases');
  ok(looks > 3 && grows >= 0.5 * looks, 'the paths grow while the strip rolls', `${grows} of ${looks} steady looks`);
  ok(!!md && !s.failed[md.id] && md.state.damage === s.governingDamage(md.id) && md.state.damage > 0.5, 'the max-damage track is an intact point with its Sim3 damage', `point ${md?.id}, D ${md?.state.damage.toFixed(3)}`);
  if (md) {
    const st = md.state;
    near(st.sxx + st.syy + st.szz, -3 * st.pres, 1e-9, 'its stress is the total (deviator less the pressure: trace −3p)');
    ok(st.s1 >= st.sxx && st.s1 >= st.syy && st.s1 >= st.szz, 'σ1 is at least every normal component', `σ1 ${(st.s1 / 1e6).toFixed(1)} MPa`);
    ok(st.syz !== undefined && st.szx !== undefined && st.sheetZ !== undefined && st.z !== undefined, 'the state carries the 3D components and the width position');
    ok(Math.abs(st.eta - s.eta[md.id]) < 1e-12 && Math.abs(st.ep - s.ep[md.id]) < 1e-12 && st.seq === s.seq[md.id], "η, εp and σeq are the Sim3's");
  }
}

// ── two stands, handed on at 'steady': the crack starts in stand 2
{
  const t = new Tandem3(params(0.25), 2, 'steady');
  let tracker = new Tracker3(t.sim);
  let first = null; // stand 1's first crack point (none expected)
  let up = null;
  let parentOf = null;
  t.onStandDone = (e) => {
    tracker.record();
    if (e.stand === 0) first = tracker.tracks().find((k) => k.role === 'first-crack') ?? null;
    if (!e.next) return;
    up = tracker;
    parentOf = e.next.parentOf;
    tracker = new Tracker3(e.next, tracker);
  };
  while (!t.done) {
    for (let k = 0; k < 20 && !t.done; k++) t.advance();
    tracker.record();
  }
  ok(t.results.length === 2 && t.stopped === null && t.results[0].nFailed === 0 && t.results[1].nFailed > 0 && first === null, 'the case: stand 1 stays whole, stand 2 cracks', `${t.results.map((r) => `${r.nFailed} failed, ${r.phase}`).join('; ')}`);
  const now = tracker.tracks().find((k) => k.role === 'first-crack');
  const s2 = t.sim;
  ok(!!now && now.id === s2.firstCrack?.point && s2.failed[now.id] === 1 && parentOf !== null && parentOf[now.id] >= 0,
    "stand 2's first crack track is Sim3.firstCrack's point of stand 2 (its own index), failed, with a parent in stand 1",
    now ? `point ${now.id}, crack's ${s2.firstCrack?.point}, parent ${parentOf?.[now.id]}` : 'no first-crack track');
  ok(!!now && now.stand[0] === 0 && now.stand.includes(1) && now.path.length === 3 * now.stand.length && Math.abs(now.path[now.path.length - 3] - s2.firstCrack.eta) < 1e-12,
    "its path starts in stand 1, goes on in stand 2 and ends at the crack's η", `stands ${[...new Set(now?.stand ?? [])].join(',')}, ${now?.stand.length ?? 0} samples`);
  ok(up !== null && up.packed !== null && tracker.stand === 1, "stand 1's tracker has let go of its Sim3 once stand 2's took over");
  let most = 0;
  if (up?.packed) for (let p = 0; p + 1 < up.packed.start.length; p++) most = Math.max(most, (up.packed.start[p + 1] - up.packed.start[p]) / 3);
  ok(most > 0 && most <= 24, 'and keeps at most 24 path samples a point', `${most} at most`);
  let full = true;
  for (let p = 0; p < t.sim.n && full; p += 7) {
    const f = tracker.fullPath(p);
    const q = parentOf[p];
    const before = q >= 0 && up?.packed ? (up.packed.start[q + 1] - up.packed.start[q]) / 3 : 0;
    full = f.stand.filter((k) => k === 0).length === before && f.path.length === 3 * f.stand.length;
  }
  ok(full, "a stand-2 point's samples of stand 1 are its parent's kept ones");
}
done();
