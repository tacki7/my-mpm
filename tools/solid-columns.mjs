// Where the elongation difference an entry crown rolls goes: one stand of the 3D model, and by lattice column
// across the width (from the mid-width out) — just before the bite, at its exit and at the exit probe, averaged
// over the steady looks: the speed, σxx, ln Fxx (the fibre's elongation), ln Fyy, ln Fzz (lateral flow), the
// plastic strain; the tail's and the head's shape (x by column, relative to the mid-width); and the flatness
// read at the probe. JSON on stdout. `node tools/solid-columns.mjs --W 60 --crown 40 [--L 45] [--looks 10]`
// (the length steady without --L; --looks stops that many steady looks in, the strip still in the rolls).
// Shows the steady length's tail of half the width (tandem3.ts TAIL_PER_WIDTH): with --L 12.7 at W 60 the edge
// comes in 8 % faster than the middle and the flatness reads about nothing (docs/validation.md).
import { defaultParams } from '../src/mpm/params.ts';
import { elasticConstants } from '../src/mpm/material.ts';
import { solidParams } from '../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../src/mpm/solid/tandem3.ts';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const base = defaultParams();
if (args.includes('--L')) base.rolling.sheetLength = +opt('L', 12) * 1e-3;
else base.rolling.lengthMode = 'steady';
base.numerics.cellsThrough = +opt('cells', 4);
const W = +opt('W', 120) * 1e-3;
const P = solidParams(base, { width: W, crownIn: +opt('crown', 40) * 1e-6 });
const tandem = new Tandem3(P, 1, 'done', {});
const sim = tandem.sim;
const { NI, NJ, NK } = sim;
console.error(`points ${sim.n} (${NI} × ${NJ} × ${NK}) h ${(sim.h * 1e3).toFixed(4)} mm Lc ${(sim.contactLength * 1e3).toFixed(3)} mm probe ${(sim.xExitProbe * 1e3).toFixed(3)} mm L ${(sim.params.rolling.sheetLength * 1e3).toFixed(2)} mm`);

const KEYS = ['lnFxx', 'lnFyy', 'lnFzz', 'ep', 'sxx', 'vx', 'z', 'n'];
const fresh = () => Object.fromEntries(KEYS.map((k) => [k, new Float64Array(NK)]));
/** add the points of columns whose x is within band of x0 (all columns if x0 is null, head/tail cut by margin) */
function gather(acc, x0, band, margin = 0) {
  const { active, px, pz, vx, sxx, pres, F, ep } = sim;
  for (let i = 0; i < NI; i++) {
    const p0 = sim.lattice(i, 0, 0);
    if (!active[p0]) continue;
    if (x0 === null ? !(i >= margin && i < NI - margin) : Math.abs(px[p0] - x0) > band) continue;
    for (let k = 0; k < NK; k++)
      for (let j = 0; j < NJ; j++) {
        const q = sim.lattice(i, j, k);
        if (!active[q]) continue;
        const o = 9 * q;
        acc.lnFxx[k] += Math.log(F[o]);
        acc.lnFyy[k] += Math.log(F[o + 4]);
        acc.lnFzz[k] += Math.log(F[o + 8]);
        acc.ep[k] += ep[q];
        acc.sxx[k] += sxx[q] - pres[q];
        acc.vx[k] += vx[q];
        acc.z[k] += pz[q];
        acc.n[k]++;
      }
  }
}
const mean = (acc) => Object.fromEntries(KEYS.filter((k) => k !== 'n').map((k) => [k, Array.from(acc[k], (v, i) => (acc.n[i] ? v / acc.n[i] : NaN))]));

const probe = fresh();
const bite = fresh();
const entry = fresh();
let tailShape = null;
let looks = 0;
const maxLooks = +opt('looks', 1e9);
while (!tandem.done && looks < maxLooks) {
  const look = tandem.advance();
  if (look && look.phase === 'steady') {
    gather(probe, sim.xExitProbe, sim.h / 2);
    gather(bite, 0, sim.h / 2);
    gather(entry, -sim.contactLength - 2 * sim.h, sim.h / 2);
    tailShape ??= shape();
    looks++;
  }
}
/** x of the tail's and the head's lattice columns by k (relative to the column's mid-width point) [mm] */
function shape() {
  const { active, px } = sim;
  const row = (i) => { const p0 = sim.lattice(i, 0, 0); return Array.from({ length: NK }, (_, k) => { const p = sim.lattice(i, 0, k); return active[p] && active[p0] ? (px[p] - px[p0]) * 1e3 : null; }); };
  return { tail: row(0), head: row(NI - 1), mid: row(Math.floor(NI / 2)) };
}
const free = fresh();
gather(free, null, 0, Math.ceil((0.5 * sim.contactLength) / (sim.params.rolling.sheetLength / NI)));
const hIn = Array.from({ length: NK }, (_, k) => 2 * sim.entryHalfThickness((k + 0.5) * sim.dz));
const st = tandem.results.at(-1)?.steady ?? null;
// the flatness as steady.ts reads it, from the probe's own means (the stand's steady result when it ended)
const el = elasticConstants(P.material);
const E = (9 * el.K * el.G) / (3 * el.K + el.G);
const probeMean = mean(probe);
const e = probeMean.vx.map((v, k) => Math.log(v / sim.vIn) - probeMean.sxx[k] / E);
const good = e.filter(Number.isFinite);
const eMean = good.reduce((a, b) => a + b, 0) / good.length;
const out = {
  W_mm: W * 1e3,
  looks,
  steps: sim.step,
  hIn_mm: hIn.map((v) => v * 1e3),
  L_mm: sim.params.rolling.sheetLength * 1e3,
  vIn: sim.vIn,
  E_GPa: E * 1e-9,
  flatness_I: e.map((v) => (v - eMean) * 1e5),
  steady: st && { exitZ_mm: st.exitZ.map((v) => v * 1e3), thicknessByZ_mm: st.halfThickness.map((v) => 2 * v * 1e3), flatness_I: st.flatness, exitSpeedByZ: st.exitSpeedByZ, exitStressByZ_MPa: st.exitStressByZ.map((v) => v * 1e-6), crownOut_um: st.crownOut * 1e6 },
  probe: probeMean,
  bite: mean(bite),
  entry: mean(entry),
  tailShape,
  endShape: shape(),
  free: mean(free),
};
console.log(JSON.stringify(out));
