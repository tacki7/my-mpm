// Worker side of the stress explorer: the loading path of every material point,
// sampled by plastic strain (so the point that fails first, or the most damaged
// one, has its whole history when it is picked), and the state of the points
// being followed. Reads the simulation only. In a tandem the tracker of each stand after the first has the
// one before as its parent: a point's path starts with its parent point's (parentOf, from the transfer), and
// each sample knows its stand. The first crack's point and the η the crack started at go on to the parent
// point's children. Once the next stand has taken what it needs, a finished stand's tracker lets go of its
// Sim and keeps only its paths, at most KEEP samples a point, packed in one array (the later stands have
// 1/(1 − r)² times the points of the one before, and a pass of five would otherwise hold every stand).
import { localization } from '../mpm/bifurcation.ts';
import { homologousTemperature } from '../mpm/material.ts';
import type { Sim } from '../mpm/solver.ts';
import type { PointState, Track } from './protocol.ts';

const DEP = 0.004; // a new path point per this much plastic strain
const DETA = 0.1; // ... or per this change of triaxiality while flowing
const CAP = 600; // path points per material point (a pass stays far below)
const KEEP = 24; // path points per material point kept of a finished stand (the first, the last and evenly between)

/** the tracker of the stand before and the transfer's map, new point → the point it was copied from */
export interface TrackerParent {
  tracker: Tracker;
  parentOf: Int32Array;
}

export class Tracker {
  /** the stand's Sim while it runs (null once the tracker is retired) */
  private sim: Sim | null;
  /** stand of this tracker (0 first) */
  readonly stand: number;
  private readonly parent: TrackerParent | null;
  private paths: (number[] | undefined)[];
  /** a retired tracker's paths: point p's samples are data[start[p] .. start[p + 1]) */
  private packed: { data: Float32Array; start: Int32Array } | null = null;
  private lastEp: Float64Array;
  private lastEta: Float64Array;
  private closed: Uint8Array; // the failure point is recorded
  private readonly initiators = new Map<number, number>(); // point that started a crack → its η at failure
  /** crack records whose starting point has been looked for (a stand after the first takes the stand before's as done) */
  private located = 0;
  private firstCrack = -1;

  constructor(sim: Sim, parent: TrackerParent | null = null) {
    this.sim = sim;
    this.parent = parent;
    this.stand = parent ? parent.tracker.stand + 1 : 0;
    this.paths = new Array(sim.n);
    this.lastEp = new Float64Array(sim.n);
    this.lastEta = new Float64Array(sim.n);
    this.closed = new Uint8Array(sim.n);
    if (parent) {
      const up = parent.tracker;
      // a point carries on from its parent: the same sampling reference, a failure already recorded stays closed,
      // and a crack's starting point hands its η on
      for (let p = 0; p < sim.n; p++) {
        const q = parent.parentOf[p];
        if (q < 0) continue;
        this.lastEp[p] = up.lastEp[q];
        this.lastEta[p] = up.lastEta[q];
        this.closed[p] = up.closed[q];
        const eta = up.initiators.get(q);
        if (eta !== undefined) this.initiators.set(p, eta);
      }
      // the records carried over were located in the stand they started in (their sheetX / sheetY are that
      // stand's): the first crack stays that point's child, not whichever point of this stand sits there
      this.located = sim.cracks.length;
      this.firstCrack = up.firstCrack >= 0 ? this.childOf(up.firstCrack) : -1;
      up.retire();
    }
  }

  /** the tracker's Sim while its stand runs */
  private get live(): Sim {
    if (!this.sim) throw new Error('a retired tracker has no Sim');
    return this.sim;
  }

  /**
   * The stand is over and the next stand's tracker has taken what it needs: keep only the paths, for fullPath, at
   * most KEEP samples a point (the first, the last and evenly between), packed in one array; let go of the Sim.
   */
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
    // the points that started cracks keep their stress state at failure in the crack record
    for (; this.located < s.cracks.length; this.located++) {
      const i = this.located;
      const p = this.locate(i);
      if (p >= 0) this.initiators.set(p, s.cracks[i].eta);
      if (i === 0) this.firstCrack = p;
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
      const h = fail ? (this.initiators.get(p) ?? (path.length ? path[path.length - 3] : eta[p])) : eta[p];
      path.push(h, e, s.governingDamage(p));
      lastEp[p] = e;
      lastEta[p] = h;
      if (fail) closed[p] = 1;
    }
  }

  /** The followed points: the selected one, the first to fail, and the most damaged one still intact. */
  tracks(selected: number | null): Track[] {
    const out: Track[] = [];
    const s = this.live;
    if (selected !== null && selected >= 0 && selected < s.n) out.push(this.track('selected', selected));
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

  private state(p: number): PointState {
    const s = this.live;
    const P = s.params;
    const pr = s.pres[p];
    // the strain rate as the constitutive update sees it (deviatoric rate of deformation, mill speed)
    const l00 = s.c00[p];
    const l11 = s.c11[p];
    const dxy = 0.5 * (s.c01[p] + s.c10[p]);
    const tr3 = (l00 + l11) / 3;
    const ex = l00 - tr3;
    const ey = l11 - tr3;
    const epsDot =
      Math.sqrt((2 / 3) * (ex * ex + ey * ey + tr3 * tr3 + 2 * dxy * dxy)) * (P.rolling.millSpeed / P.rolling.rollSpeed);
    return {
      sxx: s.sxx[p] - pr,
      syy: s.syy[p] - pr,
      sxy: s.sxy[p],
      szz: s.szz[p] - pr,
      pres: pr,
      seq: s.seq[p],
      eta: s.eta[p],
      s1: s.s1[p],
      ep: s.ep[p],
      dJC: s.dJC[p],
      dHM: s.dHM[p],
      dCL: s.dCL[p],
      por: s.por[p],
      loc: localization(s.el, s.hardening(p), s.sxx[p], s.syy[p], s.sxy[p], s.szz[p]).ratio,
      locHit: s.locHit[p] === 1,
      damage: s.governingDamage(p),
      failed: s.failed[p] === 1,
      sheetX: s.xHead0 - s.x0[p],
      sheetY: s.y0[p],
      x: s.px[p],
      y: s.py[p],
      epsDotStar: epsDot / P.material.epsDot0,
      Ts: homologousTemperature(P.material, s.temp[p]),
      duct: s.duct[p],
    };
  }

  /** The point that started crack i (the crack keeps where it sat in the undeformed sheet). */
  private locate(i: number): number {
    const s = this.live;
    const c = s.cracks[i];
    const X = s.xHead0 - c.sheetX;
    let best = -1;
    let bestD = Infinity;
    for (let p = 0; p < s.n; p++) {
      if (s.crackId[p] !== i) continue;
      const d = Math.abs(s.x0[p] - X) + Math.abs(s.y0[p] - c.sheetY);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
