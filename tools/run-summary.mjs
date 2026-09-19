// The summary tools/run.mjs prints for one pass (and tools/tandem.mjs for each stand): the means over
// the steady diagnostics reads, the end state, porosity and heating.
export function summarize(sim, P, hist, d, secs) {
  const steady = hist.filter((h) => h.phase === 'steady');
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return {
    particles: sim.n,
    steps: sim.step,
    secs,
    msPerStep: (secs * 1000) / sim.step,
    phase: d.phase,
    steadyForce_kN_per_mm: mean(steady.map((h) => h.rollForce)) * 1e-6,
    steadyTorque_N: mean(steady.map((h) => h.rollTorque)),
    exitThickness_mm: mean(steady.filter((h) => h.exitThickness).map((h) => h.exitThickness)) * 1e3,
    forwardSlip: mean(steady.filter((h) => h.forwardSlip != null).map((h) => h.forwardSlip)),
    // null when no steady sample had one (the mean of nothing is not 0: that would read "at the exit")
    neutralX_mm: ((xs) => (xs.length ? mean(xs) * 1e3 : null))(steady.filter((h) => h.neutralX != null).map((h) => h.neutralX)),
    neutralStates: Object.fromEntries(['found', 'sticking', 'backward', 'forward'].map((k) => [k, steady.filter((h) => h.neutralState === k).length])),
    inertiaRatio: d.inertiaRatio,
    kineticRatio: mean(steady.filter((h) => h.kineticRatio != null).map((h) => h.kineticRatio)),
    maxDamage: d.maxDamage,
    failed: d.nFailed,
    ...porosity(sim),
    ...heating(sim, P),
    cracks: sim.cracks,
  };
}

// the largest porosity and where that point sat in the undeformed sheet (GTN)
function porosity(sim) {
  let k = -1;
  for (let p = 0; p < sim.n; p++) if (sim.active[p] && (k < 0 || sim.por[p] > sim.por[k])) k = p;
  if (k < 0 || !(sim.por[k] > 0)) return {};
  return {
    maxPorosity: sim.por[k],
    maxPorosityAt_mm: { fromHead: (sim.xHead0 - sim.x0[k]) * 1e3, fromMidPlane: sim.y0[k] * 1e3 },
  };
}

// temperature rise of the rolled sheet: mean over its middle (the ends are not steady) and the largest (--chi)
function heating(sim, P) {
  if (!(P.material.chi > 0)) return {};
  const L = sim.params.rolling.sheetLength;
  let sum = 0;
  let n = 0;
  let max = 0;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p]) continue;
    const dT = sim.temp[p] - P.material.tRoom;
    if (dT > max) max = dT;
    const s = sim.xHead0 - sim.x0[p];
    if (s < 0.15 * L || s > 0.85 * L) continue;
    sum += dT;
    n++;
  }
  return { dTmean_K: sum / Math.max(1, n), dTmax_K: max };
}
