// The 3D model's grid arrays as one object, so that a step can scatter into one grid and gather from another
// (team.ts: each worker of a team scatters its own points into its own copy, and the owner of a column of nodes sums
// the copies into the main grid), and the memory layouts a team shares: the sync block the coordinator writes for
// the workers and the partial sums each worker writes back.

export interface Grid3 {
  m: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  pen: Float64Array;
  push: Uint8Array;
  con: Uint8Array;
  slipX: Float64Array;
  slipY: Float64Array;
  slipZ: Float64Array;
  folN: Float64Array;
  folD: Float64Array;
  Th: Float64Array;
  Je: Float64Array;
  B: Float64Array;
  Mv: Float64Array;
}

const F64: (keyof Grid3)[] = ['m', 'vx', 'vy', 'vz', 'pen', 'slipX', 'slipY', 'slipZ', 'folN', 'folD', 'Th', 'Je', 'B', 'Mv'];
const U8: (keyof Grid3)[] = ['push', 'con'];

/** the buffers behind a grid (a SharedArrayBuffer each when shared), keyed as the grid */
export type Grid3Buffers = Record<keyof Grid3, ArrayBufferLike>;

export function makeGrid3(NN: number, shared: boolean): Grid3 {
  const buf = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  const g = {} as Grid3;
  for (const k of F64) (g as unknown as Record<string, Float64Array>)[k] = new Float64Array(buf(8 * NN));
  for (const k of U8) (g as unknown as Record<string, Uint8Array>)[k] = new Uint8Array(buf(NN));
  g.pen.fill(Infinity);
  return g;
}

export function grid3Buffers(g: Grid3): Grid3Buffers {
  const out = {} as Grid3Buffers;
  for (const k of [...F64, ...U8]) out[k] = g[k].buffer;
  return out;
}

export function grid3From(b: Grid3Buffers): Grid3 {
  const g = {} as Grid3;
  for (const k of F64) (g as unknown as Record<string, Float64Array>)[k] = new Float64Array(b[k]);
  for (const k of U8) (g as unknown as Record<string, Uint8Array>)[k] = new Uint8Array(b[k]);
  return g;
}

/** a typed array on a fresh buffer, shared or not */
export function f64(n: number, shared: boolean): Float64Array {
  return new Float64Array(shared ? new SharedArrayBuffer(8 * n) : new ArrayBuffer(8 * n));
}
export function u8(n: number, shared: boolean): Uint8Array {
  return new Uint8Array(shared ? new SharedArrayBuffer(n) : new ArrayBuffer(n));
}

/** the stages of a step, run by every worker over its own points and columns, a barrier after each */
export const PH_P2G = 0;
export const PH_GRID = 1;
export const PH_FOLA = 2;
export const PH_FOLB = 3;
export const PH_G2PV = 4;
export const PH_VMEAN = 5;
export const PH_G2PU = 6;
export const PHASES = 7;

/** the sync block: what the coordinator's step sets that the stages read (SI), then the column bounds of the workers */
export const SY_CY = 0;
export const SY_R = 1;
export const SY_OMEGA = 2;
export const SY_VR = 3;
export const SY_VCY = 4;
export const SY_PUSHING = 5;
export const SY_BACK_NOW = 6;
export const SY_BACK_SCALE = 7;
export const SY_FRONT_NOW = 8;
export const SY_FRONT_SCALE = 9;
export const SY_T = 10;
export const SY_STEP = 11;
export const SY_IXLO = 12;
export const SY_IXHI = 13;
export const SY_IXPREVLO = 14;
export const SY_IXPREVHI = 15;
/** bounds[w] .. bounds[w + 1]: the columns (of a point's base cell, and of the nodes) worker w owns */
export const SY_BOUNDS = 16;
export const SY_COUNT = 16 + 65;

/** the partial sums of one worker's stages, merged by the coordinator after the step */
export const PT_IXLO = 0;
export const PT_IXHI = 1;
export const PT_FY = 2;
export const PT_TQ = 3;
export const PT_WORK = 4;
export const PT_NFAIL = 5;
export const PT_FIRST = 6;
export const PT_COUNT = 8;
