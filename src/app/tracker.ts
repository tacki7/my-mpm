// Worker side of the stress explorer: the loading path of every material point,
// sampled by plastic strain (so the point that fails first, or the most damaged
// one, has its whole history when it is picked), and the state of the points
// being followed. Reads the simulation only.
import { homologousTemperature } from '../mpm/material.ts';
import type { Sim } from '../mpm/solver.ts';
import type { PointState, Track } from './protocol.ts';

const DEP = 0.004; // a new path point per this much plastic strain
const DETA = 0.1; // ... or per this change of triaxiality while flowing
const CAP = 600; // path points per material point (a pass stays far below)

export class Tracker {
  private readonly sim: Sim;
  private readonly paths: (number[] | undefined)[];
  private readonly lastEp: Float64Array;
  private readonly lastEta: Float64Array;
  private readonly closed: Uint8Array; // the failure point is recorded
  private readonly initiators = new Map<number, number>(); // point that started a crack → its η at failure
  private firstCrack = -1;

  constructor(sim: Sim) {
    this.sim = sim;
    this.paths = new Array(sim.n);
    this.lastEp = new Float64Array(sim.n);
    this.lastEta = new Float64Array(sim.n);
    this.closed = new Uint8Array(sim.n);
  }

  /** Add path points where the plastic strain or the triaxiality moved on; call every few steps. */
  record(): void {
    const s = this.sim;
    const { active, failed, ep, eta } = s;
    const { lastEp, lastEta, closed, paths } = this;
    // the points that started cracks keep their stress state at failure in the crack record
    for (let i = this.initiators.size; i < s.cracks.length; i++) {
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
    const s = this.sim;
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
    const path = (this.paths[p] ?? []).slice();
    if (state.ep > 0 && !this.closed[p]) path.push(state.eta, state.ep, state.damage);
    return { role, id: p, state, path };
  }

  private state(p: number): PointState {
    const s = this.sim;
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
    const s = this.sim;
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
