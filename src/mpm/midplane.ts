// The triaxiality η at the mid-plane in the roll bite over the steady phase, as docs/validation.md「中心割れの地図」
// measures it (tools/burst-map.mjs and the page read it the same way): every LOOK steps while the phase is steady,
// the two lattice rows at the middle of the thickness, their points inside the bite (−Lc < x < 0), each point's η
// weighted by its plastic strain since the look before; the top and bottom rows give the surface's. Reads the Sim only.
import type { Sim } from './solver.ts';

/** steps between two looks */
export const LOOK = 50;

export class MidPlaneEta {
  private readonly last: Float64Array;
  private readonly mid: number[];
  private readonly surf: number[];
  private readonly acc = { mid: [0, 0], surf: [0, 0] };
  /** looks taken while the phase was steady */
  steadyLooks = 0;

  constructor(sim: Sim) {
    this.last = new Float64Array(sim.n);
    const NJ = sim.NJ;
    this.mid = [NJ / 2 - 1, NJ / 2];
    this.surf = [0, NJ - 1];
  }

  /** one look (every LOOK steps); outside the steady phase it only moves the reference strain on */
  look(sim: Sim): void {
    const { ep, eta, px, active, lj } = sim;
    const last = this.last;
    if (sim.phase() !== 'steady') {
      for (let p = 0; p < sim.n; p++) last[p] = ep[p];
      return;
    }
    this.steadyLooks++;
    const Lc = sim.contactLength;
    for (let p = 0; p < sim.n; p++) {
      const de = ep[p] - last[p];
      last[p] = ep[p];
      if (!active[p] || !(de > 0) || px[p] < -Lc || px[p] > 0) continue;
      const j = lj[p];
      const a = this.mid.includes(j) ? this.acc.mid : this.surf.includes(j) ? this.acc.surf : null;
      if (!a) continue;
      a[0] += de * eta[p];
      a[1] += de;
    }
  }

  /** the mid-plane's weighted mean η so far (null before any) */
  get middle(): number | null {
    return this.acc.mid[1] > 0 ? this.acc.mid[0] / this.acc.mid[1] : null;
  }

  /** the surface rows' weighted mean η so far (null before any) */
  get surface(): number | null {
    return this.acc.surf[1] > 0 ? this.acc.surf[0] / this.acc.surf[1] : null;
  }
}
