// Compare the ways the roll contact marks grid nodes (`numerics.contact`) on the
// standard pass. Not part of the gate; the numbers go to docs/validation.md.
//
//   node tools/contact-compare.mjs [--contact stencil,surface] [--cells 6,10,14] [--volumetric rate,total]
//                                  [--jbar on,off] [--vrc 1] [--L 8] [--window 250] [--mu 0.08]
//
// For each run, over the steady phase: roll force and torque, exit thickness,
// forward slip, neutral point, the integral of the node-impulse pressure against
// the force; the deepest particle edge inside a roll (in particle spacings dp);
// the normal stress −n·σ·n of the outermost particle layers (1 = outermost) over
// the middle half of the bite against the roll pressure there; the triaxiality η
// of the outermost layer in the bite. At the end: εp through the thickness of
// the rolled sheet (head and tail fifths left out). One JSON line per run.
import { Sim } from '../src/mpm/solver.ts';
import { defaultParams } from '../src/mpm/params.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const contacts = opt('contact', 'stencil,surface').split(',');
const cellsList = opt('cells', '6').split(',').map(Number);
const jbars = opt('jbar', 'on').split(',');
const vols = opt('volumetric', 'rate').split(',');
const vrc = opt('vrc', null); // numerics.volRelaxContact
const L = +opt('L', 8) * 1e-3;
const win = +opt('window', 250);
const mu = +opt('mu', 0.08);
const LAYERS = 4;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

function run(contact, cells, jbar, vol) {
  const P = defaultParams();
  P.numerics.volumetric = vol;
  if (vrc != null) P.numerics.volRelaxContact = +vrc;
  P.numerics.cellsThrough = cells;
  P.numerics.contact = contact;
  P.numerics.jbar = jbar;
  P.rolling.sheetLength = L;
  P.rolling.mu = mu;
  const sim = new Sim(P);
  const { NI, NJ, lattice, rolls, dp, nBins, binX0, binW } = sim;
  const Lc = sim.contactLength;
  const midBin = (b) => {
    const x = binX0 + (b + 0.5) * binW;
    return x > -0.75 * Lc && x < -0.25 * Lc;
  };
  // per layer and bin: Σ −n·σ·n and the count, over the samples of one window
  const sn = Array.from({ length: LAYERS }, () => new Float64Array(nBins));
  const sc = Array.from({ length: LAYERS }, () => new Float64Array(nBins));
  // per window, kept when the window was steady
  let penWin = 0;
  let etaWin = [];
  let penMax = 0;
  const etaS = [];
  const sampleSurface = () => {
    for (let i = 0; i < NI; i++) {
      for (let k = 0; k < 2; k++) {
        const roll = rolls[k];
        for (let l = 0; l < LAYERS; l++) {
          const j = k === 0 ? NJ - 1 - l : l;
          const q = lattice[i * NJ + j];
          if (q < 0 || !sim.active[q]) continue;
          const rx = sim.px[q] - roll.cx;
          const ry = sim.py[q] - roll.cy;
          const d = Math.hypot(rx, ry);
          if (l === 0) {
            // along the roll normal: half the deformed y edge projected on n (|F e_y| grows with shear)
            const rp = 0.5 * dp * Math.abs((rx * sim.f01[q] + ry * sim.f11[q]) / d);
            const pen = (roll.R + rp - d) / dp;
            if (pen > penWin) penWin = pen;
            if (sim.px[q] > -Lc && sim.px[q] < 0) etaWin.push(sim.eta[q]);
          }
          const b = Math.floor((sim.px[q] - binX0) / binW);
          if (b < 0 || b >= nBins) continue;
          const nx = rx / d;
          const ny = ry / d;
          const pr = sim.pres[q];
          const snx = (sim.sxx[q] - pr) * nx + sim.sxy[q] * ny;
          const sny = sim.sxy[q] * nx + (sim.syy[q] - pr) * ny;
          sn[l][b] -= nx * snx + ny * sny;
          sc[l][b]++;
        }
      }
    }
  };
  const rows = [];
  const t0 = performance.now();
  let d;
  while (sim.step < 400000) {
    for (let k = 0; k < win; k++) {
      sim.advance();
      if (k % 10 === 0) sampleSurface();
    }
    d = sim.diagnostics();
    const prof = sim.pressureProfile();
    if (d.phase === 'steady') {
      let F = 0;
      let pMid = 0;
      let nMid = 0;
      const layer = new Array(LAYERS).fill(0);
      const layerN = new Array(LAYERS).fill(0);
      for (let b = 0; b < nBins; b++) {
        F += prof.p[b] * binW;
        if (!midBin(b)) continue;
        pMid += prof.p[b];
        nMid++;
        for (let l = 0; l < LAYERS; l++) {
          if (sc[l][b] > 0) {
            layer[l] += sn[l][b] / sc[l][b];
            layerN[l]++;
          }
        }
      }
      rows.push({ d, Fp: F, layers: layer.map((s, l) => s / layerN[l] / (pMid / nMid)) });
      if (penWin > penMax) penMax = penWin;
      for (const e of etaWin) etaS.push(e);
    }
    penWin = 0;
    etaWin = [];
    for (let l = 0; l < LAYERS; l++) {
      sn[l].fill(0);
      sc[l].fill(0);
    }
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  const secs = (performance.now() - t0) / 1000;
  // εp through the thickness of the rolled sheet, head and tail fifths left out
  const ep = new Float64Array(NJ);
  const en = new Float64Array(NJ);
  for (let i = Math.floor(NI / 5); i < NI - Math.floor(NI / 5); i++) {
    for (let j = 0; j < NJ; j++) {
      const q = lattice[i * NJ + j];
      if (q < 0 || !sim.active[q]) continue;
      ep[j] += sim.ep[q];
      en[j]++;
    }
  }
  const epAt = (j) => (ep[j] / en[j] + ep[NJ - 1 - j] / en[NJ - 1 - j]) / 2;
  // the same rows by geometry: how much each row of points got thinner, as an equivalent strain
  // (2/√3) ln(dp / its spacing to the neighbouring rows) — plane sections thin alike when the flow is homogeneous
  const gap = new Float64Array(NJ);
  const gn = new Float64Array(NJ);
  for (let i = Math.floor(NI / 5); i < NI - Math.floor(NI / 5); i++) {
    for (let j = 0; j < NJ; j++) {
      const lo = lattice[i * NJ + Math.max(0, j - 1)];
      const hi = lattice[i * NJ + Math.min(NJ - 1, j + 1)];
      if (lo < 0 || hi < 0 || !sim.active[lo] || !sim.active[hi]) continue;
      gap[j] += (sim.py[hi] - sim.py[lo]) / ((Math.min(NJ - 1, j + 1) - Math.max(0, j - 1)) * dp);
      gn[j]++;
    }
  }
  const thinAt = (j) => ((2 / Math.sqrt(3)) * (-Math.log(gap[j] / gn[j]) - Math.log(gap[NJ - 1 - j] / gn[NJ - 1 - j]))) / 2;
  const F = mean(rows.map((r) => r.d.rollForce));
  return {
    contact,
    volumetric: jbar ? vol : '—',
    vrc: P.numerics.volRelaxContact,
    cells,
    jbar,
    samples: rows.length,
    phase: d.phase,
    forceKNmm: +(F * 1e-6).toFixed(4),
    torqueKNmm: +(mean(rows.map((r) => r.d.rollTorque)) * 1e-3).toFixed(4),
    exitMm: +(mean(rows.map((r) => r.d.exitThickness)) * 1e3).toFixed(4),
    slipPct: +(mean(rows.map((r) => r.d.forwardSlip)) * 100).toFixed(2),
    neutralMm: +(mean(rows.map((r) => r.d.neutralX).filter((x) => x != null)) * 1e3).toFixed(3),
    intPOverF: +(mean(rows.map((r) => r.Fp)) / F).toFixed(3),
    penMaxDp: +penMax.toFixed(3),
    layerSnOverP: Array.from({ length: LAYERS }, (_, l) => +mean(rows.map((r) => r.layers[l])).toFixed(3)),
    etaSurfBite: { mean: +mean(etaS).toFixed(3), max: +etaS.reduce((m, v) => (v > m ? v : m), -Infinity).toFixed(3) },
    ep: { surface: +epAt(0).toFixed(4), quarter: +epAt(Math.round((NJ - 1) / 4)).toFixed(4), centre: +epAt(Math.floor(NJ / 2) - 1).toFixed(4) },
    thinning: { surface: +thinAt(0).toFixed(4), quarter: +thinAt(Math.round((NJ - 1) / 4)).toFixed(4), centre: +thinAt(Math.floor(NJ / 2) - 1).toFixed(4) },
    msPerStep: +((secs * 1000) / sim.step).toFixed(3),
    secs: +secs.toFixed(1),
  };
}

for (const cells of cellsList) {
  for (const jb of jbars) {
    // without the volume averaging the scheme does not matter
    for (const vol of jb === 'off' ? [vols[0]] : vols) {
      for (const contact of contacts) console.log(JSON.stringify(run(contact, cells, jb !== 'off', vol)));
    }
  }
}
