// Worker side of the stress explorer for the three-dimensional model (tracker.ts for the section model): the
// loading path (η, εp, D) of every material point, sampled by plastic strain, and the state of the points shown
// on the fracture locus — the first to fail and the most damaged one still intact (no picked point: the 3D view
// has no picking). Reads the Sim3 only. In a tandem the tracker of each stand after the first has the one before
// as its parent: a point's path starts with its parent point's (Sim3.parentOf, from remap3), each sample knows
// its stand, and a finished stand's tracker lets go of its Sim3 and keeps only its paths, at most KEEP samples a
// point, packed in one array.
import { homologousTemperature } from '../mpm/material.ts';
import type { Sim3 } from '../mpm/solid/sim3.ts';
import type { PointState, Track } from './protocol.ts';

const DEP = 0.004; // a new path point per this much plastic strain
const DETA = 0.1; // ... or per this change of triaxiality while flowing
const CAP = 600; // path points per material point (a pass stays far below)
const KEEP = 24; // path points per material point kept of a finished stand (the first, the last and evenly between)

export class Tracker3 {
  /** the stand's Sim3 while it runs (null once the tracker is retired) */
  private sim: Sim3 | null;
  /** stand of this tracker (0 first) */
  readonly stand: number;
  private readonly parent: { tracker: Tracker3; parentOf: Int32Array } | null;
  private paths: (number[] | undefined)[];
  /** a retired tracker's paths: point p's samples are data[start[p] .. start[p + 1]) */
  packed: { data: Float32Array; start: Int32Array } | null = null;
  private lastEp: Float64Array;
  private lastEta: Float64Array;
  private closed: Uint8Array; // the failure point is recorded
  /** the first crack's point in this stand (−1: none yet); a later stand's is the child of the stand before's */
  private firstCrack = -1;
  /** the η the first crack started at (its point has dropped its stress) */
  private firstEta = NaN;

  /** the tracker of the stand before, when this is a tandem's later stand (sim.parentOf maps the points) */
  constructor(sim: Sim3, parent: Tracker3 | null = null) {
    this.sim = sim;
    this.parent = parent && sim.parentOf ? { tracker: parent, parentOf: sim.parentOf } : null;
    this.stand = this.parent ? parent!.stand + 1 : 0;
    this.paths = new Array(sim.n);
    this.lastEp = new Float64Array(sim.n);
    this.lastEta = new Float64Array(sim.n);
    this.closed = new Uint8Array(sim.n);
    if (this.parent) {
      const up = this.parent.tracker;
      const map = this.parent.parentOf;
      for (let p = 0; p < sim.n; p++) {
        const q = map[p];
        if (q < 0) continue;
        this.lastEp[p] = up.lastEp[q];
        this.lastEta[p] = up.lastEta[q];
        this.closed[p] = up.closed[q];
      }
      this.firstCrack = up.firstCrack >= 0 ? this.childOf(up.firstCrack) : -1;
      this.firstEta = up.firstEta;
      up.retire();
    }
  }

  private get live(): Sim3 {
    if (!this.sim) throw new Error('a retired tracker has no Sim3');
    return this.sim;
  }

  /** The stand is over and the next stand's tracker has taken what it needs: keep only the packed paths. */
  retire(): void {
    if (!this.sim) return;
    const paths = this.paths;
    const n = paths.length;
    const start = new Int32Array(n + 1);
    for (let p = 0; p < n; p++) start[p + 1] = start[p] + 3 * Math.min(KEEP, (paths[p]?.length ?? 0) / 3);
    const data = new Float32Array(start[n]);
    for (let p = 0; p < n; p++) {
      const path = paths[p];
      if (!path) continue;
      const m = path.length / 3;
      const k = (start[p + 1] - start[p]) / 3;
      for (let j = 0; j < k; j++) {
        const from = 3 * (k === m ? j : Math.round((j * (m - 1)) / (k - 1)));
        data[start[p] + 3 * j] = path[from];
        data[start[p] + 3 * j + 1] = path[from + 1];
        data[start[p] + 3 * j + 2] = path[from + 2];
      }
    }
    this.packed = { data, start };
    this.paths = [];
    this.sim = null;
    this.lastEp = this.lastEta = new Float64Array(0);
    this.closed = new Uint8Array(0);
  }

  /** The path of point p with its ancestors' in the stands before: flat (η, εp, D) and the stand of each sample. */
  fullPath(p: number): { path: number[]; stand: number[] } {
    const own = this.packed ? Array.from(this.packed.data.subarray(this.packed.start[p], this.packed.start[p + 1])) : (this.paths[p] ?? []);
    const before = this.parent && p >= 0 && this.parent.parentOf[p] >= 0 ? this.parent.tracker.fullPath(this.parent.parentOf[p]) : { path: [], stand: [] };
    return { path: before.path.concat(own), stand: before.stand.concat(new Array(own.length / 3).fill(this.stand)) };
  }

  /** the first point of this stand whose parent is point q of the stand before (−1: none) */
  childOf(q: number): number {
    if (!this.parent) return q;
    const map = this.parent.parentOf;
    for (let p = 0; p < map.length; p++) if (map[p] === q) return p;
    return -1;
  }

  /** Add path points where the plastic strain or the triaxiality moved on; call every few steps. */
  record(): void {
    const s = this.live;
    const { active, failed, ep, eta } = s;
    const { lastEp, lastEta, closed, paths } = this;
    // the first crack's point (this stand's own index) keeps its stress state at failure in the crack record
    if (this.firstCrack < 0 && s.firstCrack && s.firstCrack.point >= 0) {
      this.firstCrack = s.firstCrack.point;
      this.firstEta = s.firstCrack.eta;
    }
    for (let p = 0; p < s.n; p++) {
      if (!active[p] || closed[p]) continue;
      const e = ep[p];
      if (e <= 0) continue;
      const fail = failed[p] === 1;
      let path = paths[p];
      const de = e - lastEp[p];
      if (path && !fail && !(de >= DEP || (de > 0 && Math.abs(eta[p] - lastEta[p]) >= DETA))) continue;
      if (!path) path = paths[p] = [];
      else if (path.length >= 3 * CAP && !fail) continue;
      // a failed point has already dropped its stress: its η at failure is the crack's, or the last one seen
      const h = fail ? (p === this.firstCrack && Number.isFinite(this.firstEta) ? this.firstEta : path.length ? path[path.length - 3] : eta[p]) : eta[p];
      path.push(h, e, s.governingDamage(p));
      lastEp[p] = e;
      lastEta[p] = h;
      if (fail) closed[p] = 1;
    }
  }

  /** The followed points: the first to fail, and the most damaged one still intact. */
  tracks(): Track[] {
    const out: Track[] = [];
    const s = this.live;
    if (this.firstCrack >= 0) out.push(this.track('first-crack', this.firstCrack));
    let best = -1;
    let bestD = 0;
    for (let p = 0; p < s.n; p++) {
      if (!s.active[p] || s.failed[p]) continue;
      const d = s.governingDamage(p);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best >= 0) out.push(this.track('max-damage', best));
    return out;
  }

  private track(role: Track['role'], p: number): Track {
    const state = this.state(p);
    const { path, stand } = this.fullPath(p);
    if (state.ep > 0 && !this.closed[p]) {
      path.push(state.eta, state.ep, state.damage);
      stand.push(this.stand);
    }
    return { role, id: p, state, path, stand };
  }

  state(p: number): PointState {
    const s = this.live;
    const P = s.params;
    const pr = s.pres[p];
    const C = s.C;
    const o = 9 * p;
    // the strain rate as the constitutive update sees it (deviatoric rate of deformation, mill speed)
    const tr3 = (C[o] + C[o + 4] + C[o + 8]) / 3;
    const exx = C[o] - tr3;
    const eyy = C[o + 4] - tr3;
    const ezz = C[o + 8] - tr3;
    const exy = 0.5 * (C[o + 1] + C[o + 3]);
    const eyz = 0.5 * (C[o + 5] + C[o + 7]);
    const ezx = 0.5 * (C[o + 6] + C[o + 2]);
    const epsDot = Math.sqrt((2 / 3) * (exx * exx + eyy * eyy + ezz * ezz + 2 * (exy * exy + eyz * eyz + ezx * ezx))) * (P.rolling.millSpeed / P.rolling.rollSpeed);
    const m = s.NJ * s.NK;
    const i = Math.floor(p / m);
    const j = Math.floor(p / s.NK) % s.NJ;
    const k = p % s.NK;
    return {
      sxx: s.sxx[p] - pr,
      syy: s.syy[p] - pr,
      sxy: s.sxy[p],
      szz: s.szz[p] - pr,
      syz: s.syz[p],
      szx: s.szx[p],
      pres: pr,
      seq: s.seq[p],
      eta: s.eta[p],
      s1: s.maxPrincipal(p),
      ep: s.ep[p],
      dJC: s.dJC[p],
      dHM: s.dHM[p],
      dCL: s.dCL[p],
      por: 0,
      loc: 1,
      locHit: false,
      damage: s.governingDamage(p),
      failed: s.failed[p] === 1,
      sheetX: (s.NI - 1 - i + 0.5) * s.dp,
      sheetY: (j + 0.5 - s.jOff) * s.dp,
      sheetZ: (k + 0.5) * s.dz,
      x: s.px[p],
      y: s.py[p],
      z: s.pz[p],
      epsDotStar: epsDot / P.material.epsDot0,
      Ts: homologousTemperature(P.material, s.temp[p]),
      duct: 1,
    };
  }
}
