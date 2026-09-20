// The MPM's steady rolling against the slab method (src/mpm/slab.ts) for the same
// condition. Not a gate check: on an idle Apple M2 a 10-cell run takes about 90 s and 20
// cells about 12 min (with other jobs running, 233 s and 32 min were measured).
//
//   node tools/slab-compare.mjs [--cells 10] [--L 16] [--mu 0.08] [--ms 10000] [--r 0.25]
//                               [--R 100] [--h0 1] [--tb 0] [--tf 0] [--every 2000] [--contact surface|stencil]
//                               [--slab-only] [--profile [--merge 3]] [--bf [--bins 10]] [--json]
//
// Lengths in mm, tensions in MPa. The steady values are the plain mean of the
// `--every`-step averages whose phase is 'steady' (head past the exit probe, tail not
// yet in the bite), the same as tools/run.mjs. --profile also prints the contact
// pressure averaged over the steady phase next to the slab pressure, and ∫p dx over
// the zones of the slab solution. --bf adds Bland & Ford's closed form of the same bite
// (slab.ts, blandFord()) next to karman(): the forward slip, the neutral point and the pressure
// at --bins equally spaced points along the contact.
//
// Uses only the public Sim API (advance, diagnostics, pressureProfile), so it runs on
// any version of the solver; the MPM neutral point is shown when the diagnostics
// carry one (`neutralX`), the profile is skipped when the solver has none.
import { Sim } from '../src/mpm/solver.ts';
import { defaultParams } from '../src/mpm/params.ts';
import { blandFord, karman } from '../src/mpm/slab.ts';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const P = defaultParams();
const r = P.rolling;
r.h0 = +opt('h0', r.h0 * 1e3) * 1e-3;
r.reduction = +opt('r', r.reduction);
r.rollRadius = +opt('R', r.rollRadius * 1e3) * 1e-3;
r.sheetLength = +opt('L', r.sheetLength * 1e3) * 1e-3;
r.mu = +opt('mu', r.mu);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
P.numerics.cellsThrough = +opt('cells', P.numerics.cellsThrough);
P.numerics.massScale = +opt('ms', P.numerics.massScale);
P.numerics.contact = opt('contact', P.numerics.contact); // 'stencil': the contact of before (a band 1.5 cells deep); the same as before only with numerics.volRelaxContact 5 as well
P.damage.model = 'none';
const every = +opt('every', 2000);
const json = flag('json');
const say = (s) => { if (!json) console.log(s); };

const slab = karman(r, P.material);
const out = {
  condition: { cells: P.numerics.cellsThrough, L_mm: r.sheetLength * 1e3, mu: r.mu, massScale: P.numerics.massScale, reduction: r.reduction },
  slab: {
    force_kN_per_mm: slab.force * 1e-6,
    torque_N: slab.torque,
    forwardSlip: slab.forwardSlip,
    xNeutral_mm: slab.xNeutral * 1e3,
    crossed: slab.crossed,
    pMean_MPa: slab.pMean * 1e-6,
    twoKMean_MPa: slab.twoKMean * 1e-6,
    sticking: slab.sticking,
    tensionAtYield: slab.tensionAtYield,
  },
};
if (slab.sticking) say('warning: μp > k somewhere in the bite, the slab method does not hold (sticking friction)');
if (slab.tensionAtYield) say('warning: a tension reaches 2k, the strip would yield outside the bite');
say(`slab: F ${out.slab.force_kN_per_mm.toFixed(4)} kN/mm  T ${slab.torque.toFixed(1)} N  slip ${(slab.forwardSlip * 100).toFixed(2)} %  xn ${out.slab.xNeutral_mm.toFixed(3)} mm  p̄ ${out.slab.pMean_MPa.toFixed(1)} MPa  2k̄ ${out.slab.twoKMean_MPa.toFixed(1)} MPa${slab.crossed ? '' : '  (no neutral point)'}`);

if (flag('bf')) {
  const bf = blandFord(r, P.material);
  const bins = +opt('bins', 10);
  const at = (a, x) => {
    const i = Math.min(a.x.length - 2, Math.max(0, Math.floor(((x - a.x[0]) / (0 - a.x[0])) * (a.x.length - 1))));
    const f = (x - a.x[i]) / (a.x[i + 1] - a.x[i]);
    return a.p[i] + f * (a.p[i + 1] - a.p[i]);
  };
  out.blandFord = {
    forwardSlip: bf.forwardSlip,
    xNeutral_mm: bf.xNeutral * 1e3,
    crossed: bf.crossed,
    force_kN_per_mm: bf.force * 1e-6,
    pMean_MPa: bf.pMean * 1e-6,
    twoK_MPa: bf.twoK * 1e-6,
    twoKEntry_MPa: bf.twoKEntry * 1e-6,
    twoKExit_MPa: bf.twoKExit * 1e-6,
    HNeutral: bf.HNeutral,
    tensionAt: bf.tensionAt,
    slipRatio: slab.forwardSlip / bf.forwardSlip,
    xNeutralRatio: slab.xNeutral / bf.xNeutral,
    forceRatio: slab.force / bf.force,
  };
  const b = out.blandFord;
  say(`bf:   F ${b.force_kN_per_mm.toFixed(4)} kN/mm (∫p dx only)  slip ${(bf.forwardSlip * 100).toFixed(2)} %  xn ${b.xNeutral_mm.toFixed(3)} mm  2k ${b.twoK_MPa.toFixed(1)} MPa (2k2 ${b.twoKEntry_MPa.toFixed(1)}, 2k1 ${b.twoKExit_MPa.toFixed(1)})${bf.crossed ? '' : '  (no neutral point)'}`);
  say(`karman / bf: slip ${b.slipRatio.toFixed(4)}, xn ${b.xNeutralRatio.toFixed(4)}, ∫p dx ${b.forceRatio.toFixed(4)}`);
  const L = slab.contactLength;
  out.bfProfile = [];
  say(`x/L      x [mm]   p karman [MPa]   p bf [MPa]   karman / bf`);
  for (let i = 0; i <= bins; i++) {
    const x = -L + (i / bins) * L;
    const pk = at(slab, x);
    const pb = at(bf, x);
    out.bfProfile.push({ x_mm: x * 1e3, karman_MPa: pk * 1e-6, bf_MPa: pb * 1e-6, ratio: pk / pb });
    say(`${(-x / L).toFixed(2).padStart(4)}  ${(x * 1e3).toFixed(3).padStart(8)}  ${(pk * 1e-6).toFixed(1).padStart(14)}  ${(pb * 1e-6).toFixed(1).padStart(11)}  ${(pk / pb).toFixed(4).padStart(12)}`);
  }
}

if (!flag('slab-only')) {
  const t0 = performance.now();
  const sim = new Sim(P);
  say(`mpm: particles ${sim.n}, h ${(sim.h * 1e3).toFixed(4)} mm, dt ${sim.dt.toExponential(3)} s`);
  const steady = [];
  let prof = null;
  let nProf = 0;
  let d;
  while (sim.step < 400000) {
    for (let k = 0; k < every; k++) sim.advance();
    d = sim.diagnostics();
    const pr = typeof sim.pressureProfile === 'function' ? sim.pressureProfile() : null;
    if (d.phase === 'steady') {
      steady.push(d);
      if (pr) {
        if (!prof) prof = { x: pr.x, p: new Float64Array(pr.p.length) };
        for (let b = 0; b < pr.p.length; b++) prof.p[b] += pr.p[b];
        nProf++;
      }
    }
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  const secs = (performance.now() - t0) / 1000;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const F = steady.map((h) => h.rollForce);
  const slips = steady.filter((h) => h.forwardSlip != null).map((h) => h.forwardSlip);
  const xns = steady.filter((h) => h.neutralX != null).map((h) => h.neutralX);
  out.mpm = {
    particles: sim.n,
    steps: sim.step,
    secs,
    phase: d.phase,
    steadySamples: steady.length,
    steadySteps: steady.length * every,
    force_kN_per_mm: mean(F) * 1e-6,
    forceSd_kN_per_mm: sd(F) * 1e-6,
    torque_N: mean(steady.map((h) => h.rollTorque)),
    exitThickness_mm: mean(steady.filter((h) => h.exitThickness).map((h) => h.exitThickness)) * 1e3,
    forwardSlip: mean(slips),
    forwardSlipSd: sd(slips),
    forwardSlipMin: Math.min(...slips),
    forwardSlipMax: Math.max(...slips),
    xNeutral_mm: xns.length ? mean(xns) * 1e3 : null,
    xNeutralSd_mm: xns.length ? sd(xns) * 1e3 : null,
  };
  // Mass scaling makes the rolls accelerate a heavier strip: the extra forward friction
  // ṁ (v1 − v0), ṁ = ms ρ h0 v0, costs each roll about ṁ (v1 − v0) R / 2 of torque.
  const v1 = r.rollSpeed * (1 + out.mpm.forwardSlip);
  const v0 = (v1 * out.mpm.exitThickness_mm * 1e-3) / r.h0;
  out.mpm.inertiaTorque_N = (P.numerics.massScale * P.material.rho * r.h0 * v0 * (v1 - v0) * r.rollRadius) / 2;
  out.ratio = {
    force: out.mpm.force_kN_per_mm / out.slab.force_kN_per_mm,
    torque: out.mpm.torque_N / out.slab.torque_N,
    torqueLessInertia: (out.mpm.torque_N - out.mpm.inertiaTorque_N) / out.slab.torque_N,
  };
  const m = out.mpm;
  say(`mpm:  F ${m.force_kN_per_mm.toFixed(4)} ± ${m.forceSd_kN_per_mm.toFixed(4)} kN/mm  T ${m.torque_N.toFixed(1)} N  slip ${(m.forwardSlip * 100).toFixed(2)} ± ${(m.forwardSlipSd * 100).toFixed(2)} % (${(m.forwardSlipMin * 100).toFixed(2)}〜${(m.forwardSlipMax * 100).toFixed(2)})  h1 ${m.exitThickness_mm.toFixed(4)} mm${m.xNeutral_mm != null ? `  xn ${m.xNeutral_mm.toFixed(3)} ± ${m.xNeutralSd_mm.toFixed(3)} mm` : ''}  — ${m.steadySamples} steady samples × ${every} steps, ${m.steps} steps, ${secs.toFixed(1)} s, phase ${m.phase}`);
  say(`mpm / slab: force ${out.ratio.force.toFixed(3)}, torque ${out.ratio.torque.toFixed(3)} (${out.ratio.torqueLessInertia.toFixed(3)} without the inertia of the mass scaling, ${m.inertiaTorque_N.toFixed(0)} N)`);
  if (flag('profile') && prof) {
    // Print means over `--merge` bins: in solvers whose bins have the grid nodes on
    // their edges, single bins alternate between empty and double.
    const k = +opt('merge', 3);
    const xs = slab.x;
    const slabAt = (x) => {
      if (x < xs[0] || x > 0) return 0;
      const i = Math.min(xs.length - 2, Math.floor(((x - xs[0]) / (0 - xs[0])) * (xs.length - 1)));
      const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return slab.p[i] + f * (slab.p[i + 1] - slab.p[i]);
    };
    const w = prof.x[1] - prof.x[0];
    out.profile = [];
    say(`x [mm] (${(k * w * 1e3).toFixed(3)} mm windows)   p mpm [MPa]   p slab [MPa]`);
    for (let b = 0; b + k <= prof.x.length; b += k) {
      let pm = 0;
      let ps = 0;
      for (let j = b; j < b + k; j++) {
        pm += prof.p[j] / nProf / k;
        // slab mean over the same window (sub-sampled)
        for (let q = 0; q < 8; q++) ps += slabAt(prof.x[j] + ((q + 0.5) / 8 - 0.5) * w) / (8 * k);
      }
      const xc = (prof.x[b] + prof.x[b + k - 1]) / 2;
      out.profile.push({ x_mm: xc * 1e3, mpm_MPa: pm * 1e-6, slab_MPa: ps * 1e-6 });
      say(`${(xc * 1e3).toFixed(3).padStart(7)}  ${(pm * 1e-6).toFixed(1).padStart(10)}  ${(ps * 1e-6).toFixed(1).padStart(12)}`);
    }
    // ∫p dx over the zones of the slab solution. Each bin is spread uniformly over its
    // width, so a zone boundary is resolved to about half a cell.
    const L = slab.contactLength;
    const zones = [
      ['before entry', -Infinity, -L],
      ['entry → neutral', -L, slab.xNeutral],
      ['neutral → exit', slab.xNeutral, 0],
      ['past exit', 0, Infinity],
    ];
    const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
    out.zones = zones.map(([name, a, b]) => {
      let fm = 0;
      for (let j = 0; j < prof.x.length; j++) fm += (prof.p[j] / nProf) * overlap(prof.x[j] - w / 2, prof.x[j] + w / 2, a, b);
      let fs = 0;
      const lo = Math.max(a, -L);
      const hi = Math.min(b, 0);
      const N = 4000;
      if (hi > lo) for (let i = 0; i < N; i++) fs += slabAt(lo + ((i + 0.5) / N) * (hi - lo)) * ((hi - lo) / N);
      return { zone: name, mpm_kN_per_mm: fm * 1e-6, slab_kN_per_mm: fs * 1e-6 };
    });
    say('∫p dx by zone [kN/mm]   mpm      slab');
    for (const z of out.zones) say(`${z.zone.padEnd(22)} ${z.mpm_kN_per_mm.toFixed(3).padStart(7)}  ${z.slab_kN_per_mm.toFixed(3).padStart(7)}`);
  }
}
if (json) console.log(JSON.stringify(out));
