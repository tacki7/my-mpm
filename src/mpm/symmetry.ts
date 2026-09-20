// The thickness-symmetry mode solves the upper half of the sheet only, with y = 0 a symmetry plane
// (docs/model.md「板厚方向の対称モード」). Not every condition can be folded onto the half section:
// this says which, so the solver, the tools and the page can all refuse for the same reason.
import type { SimParams } from './params.ts';

/**
 * Why `P` cannot be solved on the upper half alone, as a sentence for the user; null when it can.
 * The momenta and the J-bar sums are folded across the plane; the crack fields (DFG) and the nonlocal
 * average are not, and a pass is only symmetric if its material is.
 */
export function symmetryUnavailable(P: SimParams): string | null {
  const dp = P.rolling.h0 / P.numerics.cellsThrough / P.numerics.ppc;
  const rows = Math.round(P.rolling.h0 / dp);
  if (rows % 2 !== 0) return `cellsThrough × ppc must be even (it is ${rows}): the mid-plane has to fall between two point rows`;
  for (const d of P.defects) if (d.y !== 0) return `a defect sits off the mid-plane (y = ${d.y * 1e3} mm)`;
  if ((P.numerics.crackFields ?? 'none') === 'dfg') return 'the crack faces (dfg) are not folded across the plane yet';
  if (P.damage.nonlocalLength > 0) return 'the nonlocal damage average is not folded across the plane yet';
  return null;
}
