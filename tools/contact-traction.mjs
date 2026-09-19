// Contact tractions along the bite, measured over the steady phase (not part of
// the gate; the numbers go to docs/validation.md).
//
//   node tools/contact-traction.mjs [--cells 6] [--L 8] [--mu 0.05,0.08,0.15] [--window 1000] [--surface]
//
// For each μ: the roll force, the integral of the pressure profile against it
// (force balance), the saw-tooth measure of the profile (mean |Δp| between
// neighbouring bins inside the bite / mean p there), the neutral point, and the
// neutral point Ford's relation f = xn² / (R h1) gives from the measured forward
// slip. The profile is read every --window steps (the page reads it every frame,
// about 20–100 steps). --surface also builds the profile from the stress of the
// outermost particle layer, p = −n·σ·n and τ = −t·σ·n (n: roll centre → point,
// t: tangent along +x), the alternative the node impulses were compared with.
import { Sim } from '../src/mpm/solver.ts';
import { defaultParams } from '../src/mpm/params.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const cells = +opt('cells', 6);
const L = +opt('L', 8) * 1e-3;
const mus = opt('mu', '0.08').split(',').map(Number);
const win = +opt('window', 1000);
const surface = args.includes('--surface');
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

function stats(sim, p) {
  const Lc = sim.contactLength;
  let F = 0;
  let sum = 0;
  let n = 0;
  let jump = 0;
  let nj = 0;
  const inBite = (b) => {
    const x = sim.binX0 + (b + 0.5) * sim.binW;
    return x > -Lc && x < 0;
  };
  for (let b = 0; b < sim.nBins; b++) {
    F += p[b] * sim.binW;
    if (!inBite(b)) continue;
    sum += p[b];
    n++;
    if (b + 1 < sim.nBins && inBite(b + 1)) {
      jump += Math.abs(p[b + 1] - p[b]);
      nj++;
    }
  }
  return { F, saw: jump / nj / (sum / n) };
}

// the outermost particle layer of each surface, binned like the node impulses
function surfaceSampler(sim) {
  const { NI, NJ, lattice, nBins } = sim;
  const sp = new Float64Array(nBins);
  const st = new Float64Array(nBins);
  const sc = new Float64Array(nBins);
  return {
    sample() {
      for (let i = 0; i < NI; i++) {
        for (const [k, j] of [[0, NJ - 1], [1, 0]]) {
          const q = lattice[i * NJ + j];
          if (q < 0 || !sim.active[q]) continue;
          const b = Math.floor((sim.px[q] - sim.binX0) / sim.binW);
          if (b < 0 || b >= nBins) continue;
          const roll = sim.rolls[k];
          const rx = sim.px[q] - roll.cx;
          const ry = sim.py[q] - roll.cy;
          const d = Math.hypot(rx, ry);
          const nx = rx / d;
          const ny = ry / d;
          const tx = Math.abs(ny);
          const ty = ny < 0 ? nx : -nx;
          const pr = sim.pres[q];
          const snx = (sim.sxx[q] - pr) * nx + sim.sxy[q] * ny;
          const sny = sim.sxy[q] * nx + (sim.syy[q] - pr) * ny;
          sp[b] -= nx * snx + ny * sny;
          st[b] -= tx * snx + ty * sny;
          sc[b]++;
        }
      }
    },
    read() {
      const p = new Float64Array(nBins);
      const tau = new Float64Array(nBins);
      for (let b = 0; b < nBins; b++) if (sc[b] > 0) [p[b], tau[b]] = [sp[b] / sc[b], st[b] / sc[b]];
      sp.fill(0);
      st.fill(0);
      sc.fill(0);
      return { p, tau };
    },
  };
}

console.log(`cells ${cells}, L ${L * 1e3} mm, window ${win} steps`);
for (const mu of mus) {
  const P = defaultParams();
  P.numerics.cellsThrough = cells;
  P.rolling.sheetLength = L;
  P.rolling.mu = mu;
  const sim = new Sim(P);
  const surf = surface ? surfaceSampler(sim) : null;
  const rows = [];
  let d;
  while (sim.step < 400000) {
    for (let k = 0; k < win; k++) {
      sim.advance();
      surf?.sample();
    }
    d = sim.diagnostics();
    const prof = sim.pressureProfile();
    const sp = surf?.read();
    if (d.phase === 'steady') rows.push({ d, node: stats(sim, prof.p), surf: sp && stats(sim, sp.p) });
    if (d.phase === 'done') break;
  }
  const F = mean(rows.map((r) => r.d.rollForce));
  const fs = mean(rows.map((r) => r.d.forwardSlip));
  const h1 = mean(rows.map((r) => r.d.exitThickness));
  const xs = rows.map((r) => r.d.neutralX).filter((x) => x != null);
  const xn = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - xn) ** 2)));
  const Fp = mean(rows.map((r) => r.node.F));
  const R = P.rolling.rollRadius;
  let line =
    `μ ${mu.toFixed(2)}  samples ${rows.length}  F ${(F * 1e-6).toFixed(3)} kN/mm  ∫p dx ${(Fp * 1e-6).toFixed(3)} (${((Fp / F - 1) * 100).toFixed(1)} %)` +
    `  saw-tooth ${mean(rows.map((r) => r.node.saw)).toFixed(3)}  xn ${(xn * 1e3).toFixed(3)} ± ${(sd * 1e3).toFixed(3)} mm (${xs.length}/${rows.length})` +
    `  forward slip ${(fs * 100).toFixed(2)} % → Ford xn ${(-Math.sqrt(Math.max(0, fs) * R * h1) * 1e3).toFixed(3)} mm  (entry ${(-sim.contactLength * 1e3).toFixed(2)} mm)`;
  if (surface) {
    const Fs = mean(rows.map((r) => r.surf.F));
    line += `\n        surface layer: ∫p dx ${(Fs * 1e-6).toFixed(3)} (${((Fs / F - 1) * 100).toFixed(1)} %)  saw-tooth ${mean(rows.map((r) => r.surf.saw)).toFixed(3)}`;
  }
  console.log(line);
}
