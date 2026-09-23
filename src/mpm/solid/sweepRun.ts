// One condition of a sweep (sweep.ts) rolled to its end: tools/sweep.mjs and the checks (the page's workers roll it
// in slices, src/app/sweep.worker.ts).
import type { Handoff } from '../tandem.ts';
import type { Solid3Params } from './sim3.ts';
import type { SweepCaseResult, SweepValues } from './sweep.ts';
import { MAX_STANDS, Tandem3 } from './tandem3.ts';

/**
 * Roll one condition to its end (the last pass rolled, or the tandem stopped), synchronously. `onStep` is called
 * every `every` steps with the tandem (a worker's progress).
 */
export function runCase(
  P: Solid3Params,
  values: SweepValues,
  stands: number,
  handoff: Handoff,
  onStep?: (T: Tandem3) => void,
  every = 500,
  maxSteps = 2_000_000,
): SweepCaseResult {
  const T = new Tandem3(P, Math.max(1, Math.min(MAX_STANDS, stands)), handoff);
  let steps = 0;
  while (!T.done && steps < maxSteps) {
    T.advance();
    steps++;
    if (onStep && steps % every === 0) onStep(T);
  }
  return { values, stands: T.results.slice(), stopped: T.stopped ?? (T.done ? null : 'steps') };
}
