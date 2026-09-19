// Benchmarks of the volumetric (anti-locking) scheme. Not a `@check` — it runs
// for a few minutes. Prints one JSON object.
//
//   node tools/bench-volumetric.mjs [--src <dir containing mpm/>] [--only std,centre,elastic,ms] [--cells 12,16,24] [--nojbar]
//
// std      standard pass, 6 cells, 8 mm: steady roll force, J range, points with
//          eta > 1 inside the bite (spurious hydrostatic tension = locking), failed points
// centre   thick plate, Delta = mean thickness / contact length = 3.58 (h0 10 mm,
//          R 15 mm, r 5 %, mu 0.3 so it rolls without skidding, no tension, no damage):
//          sigma_m / 2k at the plate centre in the middle of the bite, for each grid.
//          Hill's slip-line field for mutual indentation of a thick slab gives
//          sigma_m/2k = -0.50 (H/L 1), +0.08 (2), +0.39 (3.5), +0.51 (5) at the centre.
// elastic  the same plate ahead of the bite, where nothing has yielded: plane strain
//          needs sigma_zz = nu (sigma_xx + sigma_yy)
// ms       centre result with mass scaling 1e3 against 1e4 (12 cells): a scheme whose
//          answer depends on the time step is diffusing something
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const src = resolve(opt('src', new URL('../src', import.meta.url).pathname));
const only = opt('only', 'std,centre,elastic,ms').split(',');
const cellsList = opt('cells', '12,16,24').split(',').map(Number);
const noJbar = args.includes('--nojbar');

const { Sim } = await import(pathToFileURL(`${src}/mpm/solver.ts`).href);
const { defaultParams, STEEL_4340 } = await import(pathToFileURL(`${src}/mpm/params.ts`).href);
const { flowStress, elasticConstants } = await import(pathToFileURL(`${src}/mpm/material.ts`).href);

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const out = { src };
let nan = 0;
let jmin = Infinity;
let jmax = -Infinity;

function scanJ(sim) {
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    const J = sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p];
    if (!Number.isFinite(J + sim.sxx[p] + sim.pres[p] + sim.px[p])) nan++;
    else {
      jmin = Math.min(jmin, J);
      jmax = Math.max(jmax, J);
    }
  }
}

// ── std ──────────────────────────────────────────────────────────────────────
if (only.includes('std')) {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  if (noJbar) P.numerics.jbar = false;
  const sim = new Sim(P);
  const F = [];
  let spurious = 0;
  const t0 = performance.now();
  while (sim.step < 60000) {
    for (let k = 0; k < 1000; k++) sim.advance();
    const d = sim.diagnostics();
    if (d.phase === 'steady') {
      F.push(d.rollForce);
      for (let p = 0; p < sim.n; p++) if (sim.active[p] && sim.px[p] > -sim.contactLength && sim.px[p] < 0 && sim.eta[p] > 1) spurious++;
      scanJ(sim);
    }
    if (d.phase === 'done') break;
  }
  const d = sim.diagnostics();
  out.std = {
    forceKNmm: mean(F) * 1e-6,
    etaAbove1InBite: spurious,
    failed: d.nFailed,
    maxDamage: d.maxDamage,
    exitMm: d.exitThickness ? d.exitThickness * 1e3 : null,
    msPerStep: (performance.now() - t0) / sim.step,
  };
}

// ── thick plate ─────────────────────────────────────────────────────────────
function thick(cells, massScale) {
  const P = defaultParams();
  P.rolling.h0 = 10e-3;
  P.rolling.reduction = 0.05;
  P.rolling.rollRadius = 15e-3;
  P.rolling.sheetLength = 32e-3;
  P.rolling.mu = 0.3;
  P.material = { ...STEEL_4340 };
  P.damage.model = 'none';
  P.numerics.cellsThrough = cells;
  P.numerics.massScale = massScale;
  if (noJbar) P.numerics.jbar = false;
  return P;
}

function runThick(cells, massScale, wantElastic) {
  const P = thick(cells, massScale);
  const sim = new Sim(P);
  const mat = P.material;
  const nu = mat.nu;
  const k0 = (2 / Math.sqrt(3)) * flowStress(mat, 0, 1, mat.tRoom).sy;
  const Lc = sim.contactLength;
  const h0 = P.rolling.h0;
  const epPrev = new Float64Array(sim.n);
  const centre = []; // sigma_m / 2k of centre points in mid-bite, weighted by the plastic increment
  const centreW = [];
  const centreAll = [];
  const el = { zz: [], nuSum: [], err: [] };
  const t0 = performance.now();
  let samples = 0;
  while (sim.step < 400000) {
    for (let k = 0; k < 20; k++) sim.advance();
    const head = sim.headX();
    const tail = sim.tailX();
    // the plate spans the bite with room on both sides
    const spanning = head > 2 * Lc && head < 1e3 && tail < -Lc - h0;
    if (spanning) {
      samples++;
      for (let p = 0; p < sim.n; p++) {
        if (!sim.active[p]) continue;
        const x = sim.px[p];
        const y = sim.py[p];
        const pr = sim.pres[p];
        if (x > -0.6 * Lc && x < -0.4 * Lc && Math.abs(y) < 0.6 * sim.h) {
          const k2 = (2 / Math.sqrt(3)) * flowStress(mat, sim.ep[p], 1, mat.tRoom).sy;
          const sm = -pr / k2;
          centreAll.push(sm);
          const dep = sim.ep[p] - epPrev[p];
          if (dep > 0) {
            centre.push(sm * dep);
            centreW.push(dep);
          }
        }
        if (wantElastic && sim.ep[p] === 0 && x > -Lc - 2 * h0 && x < -Lc - 0.5 * h0) {
          const sxx = sim.sxx[p] - pr;
          const syy = sim.syy[p] - pr;
          const szz = sim.szz[p] - pr;
          el.zz.push(szz);
          el.nuSum.push(nu * (sxx + syy));
          el.err.push(Math.abs(szz - nu * (sxx + syy)) / k0);
        }
      }
      scanJ(sim);
    }
    for (let p = 0; p < sim.n; p++) epPrev[p] = sim.ep[p];
    if (head >= 1e3 || (tail > -Lc && samples > 0)) break;
  }
  const w = centreW.reduce((s, v) => s + v, 0);
  const r = {
    cells,
    massScale,
    samples,
    centreSm2kYielding: w > 0 ? centre.reduce((s, v) => s + v, 0) / w : null,
    centreSm2kAll: mean(centreAll),
    seconds: (performance.now() - t0) / 1000,
    steps: sim.step,
  };
  if (wantElastic) {
    r.elastic = {
      points: el.err.length,
      meanSzzMPa: mean(el.zz) * 1e-6,
      meanNuSumMPa: mean(el.nuSum) * 1e-6,
      meanErrOver2k: mean(el.err),
    };
  }
  return r;
}

if (only.includes('centre') || only.includes('elastic')) {
  out.centre = cellsList.map((c, i) => runThick(c, 1e4, only.includes('elastic') && i === 0));
}
if (only.includes('ms')) {
  out.ms = [runThick(12, 1e3, false)];
}
out.stability = { nanPointSamples: nan, jMin: jmin, jMax: jmax };
out.elasticK = elasticConstants(STEEL_4340);
console.log(JSON.stringify(out, null, 1));
