// The outer faces of the quarter strip as vertex grids, for drawing: each lattice point of a face moved from its
// centre to the face (half its deformed size along the face's normal), and the face's border rows moved out to the
// neighbouring faces, so that the faces meet at the strip's edges. The picture mirrors them (y → −y, z → −z);
// with the whole thickness solved (Sim3.fullThickness) there is a bottom face too and no mirror across y.
import type { Sim3 } from './sim3.ts';

export type FaceName = 'top' | 'bottom' | 'edge' | 'cut' | 'head' | 'tail';

export interface Face {
  name: FaceName;
  /** vertex grid rows × cols (row-major); top and bottom: along x × across z, edge and cut: along x × up y, head and tail: up y × across z */
  rows: number;
  cols: number;
  /** x y z per vertex [m]; NaN for a point that has left the grid */
  pos: Float32Array;
  /** the values, one block of rows × cols per value function, in the functions' order */
  vals: Float32Array;
  /** 1: the point has failed */
  failed: Uint8Array;
}

export function faces(sim: Sim3, values: ((p: number) => number)[]): Face[] {
  const { NI, NJ, NK, dp, dz, F, px, py, pz, active, failed } = sim;
  const make = (name: FaceName, rows: number, cols: number, at: (r: number, c: number) => [number, number, number]): Face => {
    const n = rows * cols;
    const pos = new Float32Array(3 * n);
    const vals = new Float32Array(values.length * n);
    const fl = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const [i, j, k] = at(r, c);
        const p = sim.lattice(i, j, k);
        const v = r * cols + c;
        if (!active[p]) {
          pos[3 * v] = pos[3 * v + 1] = pos[3 * v + 2] = NaN;
          continue;
        }
        const o = 9 * p;
        // how far along each lattice direction the vertex sits from the centre: to the strip's surface where the point is on it
        const a = i === NI - 1 && name !== 'tail' ? 0.5 * dp : i === 0 && name !== 'head' ? -0.5 * dp : 0;
        const b = j === NJ - 1 ? 0.5 * dp * sim.ySize[k] : j === 0 ? -0.5 * dp * sim.ySize[k] : 0;
        const g = k === NK - 1 ? 0.5 * dz : k === 0 ? -0.5 * dz : 0;
        pos[3 * v] = px[p] + F[o] * a + F[o + 1] * b + F[o + 2] * g;
        // the symmetry planes stay planes
        pos[3 * v + 1] = j === 0 && !sim.fullThickness ? 0 : py[p] + F[o + 3] * a + F[o + 4] * b + F[o + 5] * g;
        pos[3 * v + 2] = k === 0 ? 0 : pz[p] + F[o + 6] * a + F[o + 7] * b + F[o + 8] * g;
        for (let q = 0; q < values.length; q++) vals[q * n + v] = values[q](p);
        fl[v] = failed[p];
      }
    }
    return { name, rows, cols, pos, vals, failed: fl };
  };
  return [
    make('top', NI, NK, (r, c) => [r, NJ - 1, c]),
    ...(sim.fullThickness ? [make('bottom', NI, NK, (r, c) => [r, 0, c])] : []),
    make('edge', NI, NJ, (r, c) => [r, c, NK - 1]),
    make('cut', NI, NJ, (r, c) => [r, c, 0]),
    make('head', NJ, NK, (r, c) => [NI - 1, r, c]),
    make('tail', NJ, NK, (r, c) => [0, r, c]),
  ];
}
