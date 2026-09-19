// Where the middle of the thickness goes into hydrostatic tension: a map of the triaxiality η at the mid-plane in
// the roll bite over Δ = mean thickness / contact length and the reduction (docs/validation.md「中心割れの地図」).
//
//   node tools/burst-map.mjs --mat s4340 --cells 8 --r 0.05 --delta 0.5,1,2,3,4,6 [--R 15] [--mu 0.2] [--json]
//
// One pass per point, with no damage (η does not depend on it: the damage here does not soften the material). The
// roll radius stays (15 mm, the central-burst preset's) and the sheet takes the thickness that gives Δ at that
// reduction, h0 = Δ² R r / (1 − r/2)², its length max(3.2 h0, 8 Lc) so that the steady phase is long enough.
// While the phase is steady, every 50 steps, the mid-plane's two lattice rows inside the bite (−Lc < x < 0) give their
// η weighted by each point's plastic strain since the look before (docs/presets.md「中心割れ」: 8 cells +0.06, 12 cells
// +0.15 at the preset's point, Δ 3.6 and 5 %); the top and bottom rows give the surface's. With it: the steady roll
// force (diagnostics every 250 steps) over the slab method's (karman), and whether the rolls drew the sheet in.
// The window is the steady phase only: docs/presets.md's table (T04) weighted the whole pass, bite and tail-out
// included, which at 8 cells reads the preset's mid-plane lower (+0.06 against +0.099; at 12 cells both +0.15).
// The bite angle α = Δ r / (1 − r/2) does not depend on R, so a large Δ at a large reduction does not roll at μ 0.2.
// --as-preset keeps the preset's damage and weak band (ductility 1/20): the same η, as the damage does not soften.
import { Sim } from '../src/mpm/solver.ts';
import { karman } from '../src/mpm/slab.ts';
import { biteGeometry } from '../src/mpm/params.ts';
import { MidPlaneEta, LOOK } from '../src/mpm/midplane.ts';
import { runParams } from './run-params.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const json = args.includes('--json');
const mat = opt('mat', 's4340');
const cells = +opt('cells', 8);
const R = +opt('R', 15) * 1e-3;
const mu = +opt('mu', 0.2);
const reductions = String(opt('r', '0.05')).split(',').map(Number);
const deltas = String(opt('delta', '0.5,1,2,3,4,6')).split(',').map(Number);
const READ = 250;

function point(delta, r) {
  const h0 = (delta * delta * R * r) / (1 - r / 2) ** 2;
  const Lc = Math.sqrt(R * r * h0);
  const L = Math.max(3.2 * h0, 8 * Lc);
  // --as-preset: the preset's damage and weak band at 1/20 (as docs/presets.md measured its table), to compare
  const asPreset = args.includes('--as-preset');
  const P = runParams(['--preset', 'central-burst', '--mat', mat, ...(asPreset ? [] : ['--damage', 'none']), '--cells', String(cells)]);
  P.rolling.h0 = h0;
  P.rolling.reduction = r;
  P.rolling.rollRadius = R;
  P.rolling.mu = mu;
  P.rolling.sheetLength = L;
  if (asPreset) P.defects = P.defects.map((d) => ({ ...d, ductility: 0.05 }));
  else P.defects = [];
  const bite = Math.sqrt((r * h0) / R); // bite angle [rad]
  const t0 = performance.now();
  const sim = new Sim(P);
  const mp = new MidPlaneEta(sim); // the measure the page shows too (src/mpm/midplane.ts)
  const forces = [];
  let phase = sim.phase();
  while (phase !== 'done' && phase !== 'stalled' && sim.step < 2e6) {
    for (let k = 0; k < LOOK; k++) sim.advance();
    phase = sim.phase();
    if (sim.step % READ === 0) {
      const d = sim.diagnostics();
      if (d.phase === 'steady') forces.push(d.rollForce);
    }
    mp.look(sim);
  }
  const slab = karman(P.rolling, P.material);
  const force = forces.length ? forces.reduce((x, v) => x + v, 0) / forces.length : null;
  return {
    delta,
    r,
    mat,
    cells,
    h0_mm: h0 * 1e3,
    R_mm: R * 1e3,
    L_mm: L * 1e3,
    Lc_mm: biteGeometry(P.rolling).contactLength * 1e3,
    biteAngle: bite,
    mu,
    phase,
    steadyLooks: mp.steadyLooks,
    etaMid: mp.middle,
    etaSurface: mp.surface,
    force_kN_per_mm: force != null ? force * 1e-6 : null,
    slab_kN_per_mm: slab.outside ? null : slab.force * 1e-6,
    slabOutside: slab.tensionAtYield || slab.sticking || !slab.crossed,
    ratio: force != null ? force / slab.force : null,
    particles: sim.n,
    steps: sim.step,
    secs: (performance.now() - t0) / 1000,
  };
}

const out = [];
for (const r of reductions) {
  for (const delta of deltas) {
    const o = point(delta, r);
    out.push(o);
    if (!json) {
      const f = (v, d) => (v == null ? '—' : v.toFixed(d));
      console.log(
        `${mat} ${cells} cells r ${(r * 100).toFixed(0)} % Δ ${delta}: h0 ${o.h0_mm.toFixed(2)} mm, L ${o.L_mm.toFixed(1)} mm, α ${o.biteAngle.toFixed(3)}, ${o.phase}, ` +
          `η mid ${f(o.etaMid, 3)} surface ${f(o.etaSurface, 3)}, F ${f(o.force_kN_per_mm, 3)} kN/mm / slab ${f(o.slab_kN_per_mm, 3)} = ${f(o.ratio, 2)}, ` +
          `${o.steadyLooks} looks, ${o.particles} points, ${o.secs.toFixed(0)} s`,
      );
    }
  }
}
if (json) console.log(JSON.stringify(out));
