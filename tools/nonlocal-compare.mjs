// Mesh dependence of cracking with and without the nonlocal damage average
// (not part of the gate; the numbers go to docs/validation.md).
//
//   node tools/nonlocal-compare.mjs [--cells 6,10,14] [--ell 0,0.1] [--tf 600] [--L 8] [--max 400000]
//
// Front tension (preset front-tension with the given tension, MPa), sheet length L (mm),
// each grid × each nonlocal length ℓ (mm; 0 = local). Per run: when the first crack
// appears, how many points have failed at the end and the area they cover, and the
// width of the first crack along the rolling direction in the undeformed sheet.
import { Sim } from '../src/mpm/solver.ts';
import { presetById } from '../src/mpm/presets.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const cellsList = opt('cells', '6,10,14').split(',').map(Number);
const ells = opt('ell', '0,0.1').split(',').map(Number);
const tf = +opt('tf', 600);
const L = +opt('L', 8);
const maxSteps = +opt('max', 400000);

console.log(`front tension ${tf} MPa, sheet ${L} mm`);
console.log('cells  ℓ [mm]  passes  first crack [ms]  failed  failed area [mm²]  crack 1 width [mm]  cracks  ms/step');
for (const cells of cellsList) {
  for (const ell of ells) {
    const P = presetById('front-tension').build();
    P.rolling.frontTension = tf * 1e6;
    P.rolling.sheetLength = L * 1e-3;
    P.numerics.cellsThrough = cells;
    P.damage = { ...P.damage, nonlocalLength: ell * 1e-3 };
    const sim = new Sim(P);
    const t0 = performance.now();
    while (sim.step < maxSteps && sim.phase() !== 'done') for (let k = 0; k < 500; k++) sim.advance();
    const secs = (performance.now() - t0) / 1000;
    let failed = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < sim.n; p++) {
      if (!sim.failed[p]) continue;
      failed++;
      if (sim.crackId[p] === 0) {
        lo = Math.min(lo, sim.li[p]);
        hi = Math.max(hi, sim.li[p]);
      }
    }
    const c0 = sim.cracks[0];
    const row = [
      String(cells).padStart(5),
      ell.toFixed(2).padStart(6),
      String(ell > 0 ? sim.nonlocalPasses(ell * 1e-3) : 0).padStart(7),
      (c0 ? (c0.t * 1e3).toFixed(3) : '—').padStart(17),
      String(failed).padStart(7),
      (failed * sim.dp * sim.dp * 1e6).toFixed(4).padStart(18),
      (c0 ? ((hi - lo + 1) * sim.dp * 1e3).toFixed(3) : '—').padStart(19),
      String(sim.cracks.length).padStart(7),
      ((secs * 1000) / sim.step).toFixed(2).padStart(8),
    ];
    console.log(row.join(' '));
  }
}
