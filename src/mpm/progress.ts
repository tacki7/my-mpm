// How far a stand is through its pass, for the page's estimate of the time left: the way the strip's tail has
// come, measured by the time it takes (the tail moves at the entry speed up to the bite and speeds up in it). The
// same for the section model, the plan view and the 3D model (x along the rolling direction, the exit at 0).

const INF = Number.POSITIVE_INFINITY;

/**
 * Where the tail is when the stand ends [m]. A stand that rolls its strip out ends with the tail 2 h0 past the exit
 * (the models' 'done'). A tandem's stand that hands on as soon as it is steady (`steadyLength`: the strip length
 * that reading needs, null for a stand that rolls out) ends with the tail still that much short of the bite; a
 * strip shorter than the reading needs is rolled out after all.
 */
export function standEndTail(h0: number, contactLength: number, length: number, steadyLength: number | null): number {
  if (steadyLength == null || length < steadyLength - 1e-9) return 2 * h0;
  return -contactLength - (length - steadyLength);
}

/**
 * Where the tail is when a tandem's stand hands on its middle stretch (handoff 'crop') [m]: the stretch's tail end at
 * the exit probe, `behind` (the strip behind the stretch, entry length) spread from there back over the bite (a
 * contact length) and the way out to the probe at the exit speed; the tail is in the bite if that is all of it.
 */
export function cropEndTail(contactLength: number, xExitProbe: number, reduction: number, behind: number): number {
  return -contactLength - Math.max(0, behind - contactLength - xExitProbe * (1 - reduction));
}

/**
 * The tail's way to x in the time it takes, as a length at the entry speed [m]. Up to the bite the tail moves at the
 * entry speed; through the bite (−Lc..0) the strip speeds up to the exit speed, entry / (1 − r), taken as a time per
 * length that falls linearly along the arc; past the exit it moves at the exit speed.
 */
function entryLength(x: number, contactLength: number, reduction: number): number {
  if (x <= -contactLength) return x;
  const s = Math.min(x, 0) + contactLength;
  const bite = s - (reduction * s * s) / (2 * contactLength);
  return -contactLength + bite + Math.max(x, 0) * (1 - reduction);
}

/**
 * 0..1: the tail's way from where it began (tail0) to where the stand ends (standEndTail), by the time it takes
 * (entryLength); 1 once the tail is off the grid
 */
export function standProgress(tail: number, tail0: number, tailEnd: number, contactLength: number, reduction: number): number {
  if (tail === INF || !(tailEnd > tail0)) return 1;
  const at = (x: number) => entryLength(x, contactLength, reduction);
  return Math.min(1, Math.max(0, (at(tail) - at(tail0)) / (at(tailEnd) - at(tail0))));
}
