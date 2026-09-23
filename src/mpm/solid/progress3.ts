// How far a 3D tandem is through its pass (progress.ts, for the 3D model's Tandem3): the 3D tab's worker and the
// sweep's workers (「条件の比較」) both read it for the time left.
import { cropEndTail, standEndTail, standProgress } from '../progress.ts';
import type { Sim3 } from './sim3.ts';
import { steadyLength3, type Tandem3 } from './tandem3.ts';

/** a stand's tail where it began and where the stand ends, by the stand's Sim3 (worked out once) */
const tailSpan = new WeakMap<Sim3, [number, number]>();

/** 0..1: the running stand of the tandem */
export function standProgress3(T: Tandem3): number {
  const s = T.sim;
  let span = tailSpan.get(s);
  if (!span) {
    const tail0 = s.tailX();
    const length = s.headX() - tail0;
    // a stand with another after it hands on once it is steady: the first stand's strip may be longer than that
    // reading needs, the later ones are made that long
    const handsOn = T.handoff === 'steady' && T.stand < T.stands - 1;
    const need = !handsOn ? null : T.stand === 0 ? steadyLength3(s.params) : length;
    // a stand that hands on its middle stretch (handoff 'crop') ends when the stretch's tail end is out
    const r = s.params.rolling;
    span = [tail0, T.crop ? cropEndTail(s.contactLength, s.xExitProbe, r.reduction, T.crop[0] * s.dp) : standEndTail(r.h0, s.contactLength, length, need)];
    tailSpan.set(s, span);
  }
  return standProgress(s.tailX(), span[0], span[1], s.contactLength, s.params.rolling.reduction);
}

/**
 * 0..1: the whole tandem, each stand weighted by its cost against the one before (`growth`, eta.ts standGrowth: a
 * later stand's strip is thinner, on a finer grid)
 */
export function tandemProgress3(T: Tandem3, growth: number): number {
  if (T.done) return 1;
  let total = 0;
  let done = 0;
  for (let k = 0; k < T.stands; k++) {
    const w = growth ** k;
    total += w;
    if (k < T.stand) done += w;
    else if (k === T.stand) done += w * standProgress3(T);
  }
  return done / total;
}
