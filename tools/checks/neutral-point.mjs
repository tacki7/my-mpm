// The neutral point and the contact bins (about 15 s):
// - the bins reach about 6 cells before the entry and after the exit. The first bin's column
//   was floor((max(2h0, 4h) + L)/h), which came out as 179 for 179.999… (10 cells, L 16 mm)
//   and moved the window one column back, so it ended 4.5 cells past the exit
// - the neutral point is the zero of the friction inside the bite (−Lc < x < 0), or null with
//   the reason. On a thick plate (h0 4 mm, R 25 mm, 8 %, μ 0.1, 6 cells) the zero was taken at the
//   edge of the window, past the exit (2 of 5 steady samples). The reasons are checked on made-up
//   bins: a real arc hardly ever sticks whole (p → 0 at the ends, where the nodes slide), and the
//   'sticking' this plate showed came from sliding nodes carrying 0.9875 μ before T31
// - tools/run.mjs gives null for the neutral point when it had no sample (it gave 0: "at the exit")
// @check
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ok, between, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const cond = (cells, h0, R, r, mu, L) => {
  const P = defaultParams();
  Object.assign(P.rolling, { h0: h0 * 1e-3, rollRadius: R * 1e-3, reduction: r, mu, sheetLength: L * 1e-3 });
  P.numerics.cellsThrough = cells;
  P.damage.model = 'none';
  return P;
};

// ── the bins' window ─────────────────────────────────────────────────────────
for (const [cells, h0, R, r, mu, L] of [[6, 1, 100, 0.25, 0.08, 8], [10, 1, 100, 0.25, 0.08, 16], [6, 4, 25, 0.08, 0.1, 24], [14, 1, 100, 0.25, 0.08, 16]]) {
  const sim = new Sim(cond(cells, h0, R, r, mu, L));
  const { h, binX0, binW, nBins, contactLength: Lc } = sim;
  const before = (-Lc - binX0) / h;
  const after = (binX0 + nBins * binW) / h;
  ok(before >= 5.4 && after >= 5.4, `${cells} cells, L ${L} mm: the bins reach 6 cells before the entry and after the exit`, `${before.toFixed(2)} h before, ${after.toFixed(2)} h after`);
}

// ── the neutral point on a thick plate ───────────────────────────────────────
{
  const sim = new Sim(cond(6, 4, 25, 0.08, 0.1, 24));
  const Lc = sim.contactLength;
  const seen = [];
  while (sim.step < 200000) {
    for (let k = 0; k < 500; k++) sim.advance();
    const d = sim.diagnostics();
    if (d.phase === 'steady' || d.phase === 'tail-out') seen.push({ x: d.neutralX, state: d.neutralState, phase: d.phase });
    if (d.phase === 'done' || d.phase === 'stalled') break;
  }
  const outside = seen.filter((s) => s.x != null && !(s.x > -Lc && s.x < 0));
  ok(seen.length >= 5 && outside.length === 0, 'thick plate: a neutral point is never outside the bite', outside.map((s) => `${s.phase} ${(s.x / Lc).toFixed(3)} Lc`).join(', '));
  const states = ['found', 'sticking', 'backward', 'forward', 'none']; // none: the tail has left the rolls
  ok(seen.every((s) => states.includes(s.state) && (s.state === 'found') === (s.x != null)), 'each sample says found (with a point) or why there is none', [...new Set(seen.map((s) => s.state))].join(', '));
}

// ── the reasons, on made-up bins (friction τ and normal force fn per bin) ─────
{
  const sim = new Sim(cond(6, 1, 100, 0.25, 0.08, 8));
  const { binX0, binW, nBins, contactLength: Lc } = sim;
  const mu = 0.08;
  const bins = (tauOf) => {
    const tau = new Float64Array(nBins);
    const fn = new Float64Array(nBins);
    for (let b = 0; b < nBins; b++) {
      const x = binX0 + (b + 0.5) * binW;
      if (x > -Lc && x < 0) fn[b] = 1;
      tau[b] = tauOf(x) * fn[b];
    }
    return [tau, fn];
  };
  // the solver keeps it private: called here only
  const np = (tauOf, extra) => {
    const [tau, fn] = bins(tauOf);
    if (extra) extra(tau, fn);
    return sim.neutralPoint(tau, fn);
  };
  const cases = [
    ['a zero inside the bite: found', np((x) => (x < -0.3 * Lc ? mu : -mu)), 'found'],
    ['one way all along, sliding: backward', np(() => mu), 'backward'],
    ['held back all along, sliding: forward', np(() => -mu), 'forward'],
    ['one way all along, under μ p everywhere: sticking', np(() => 0.5 * mu), 'sticking'],
    ['no contact: none', np(() => 0, (tau, fn) => fn.fill(0)), 'none'],
    // the old bug: friction keeps its sign a little past the exit (the springback contact) and turns there
    ['a zero past the exit only: not found (backward)', np(() => mu, (tau, fn) => {
      for (let b = 0; b < nBins; b++) {
        const x = binX0 + (b + 0.5) * binW;
        if (x > 0) [tau[b], fn[b]] = [x > 2 * binW ? -mu : mu, 1];
      }
    }), 'backward'],
  ];
  for (const [what, [x, state], want] of cases) ok(state === want && (state === 'found') === (x != null && x > -Lc && x < 0), what, `${state}, x ${x == null ? 'null' : (x / Lc).toFixed(3) + ' Lc'}`);
}

// ── run.mjs: no sample is null, not 0 ────────────────────────────────────────
{
  const run = fileURLToPath(new URL('../run.mjs', import.meta.url));
  const out = JSON.parse(execFileSync('node', [run, '--cells', '4', '--L', '4', '--every', '500', '--max', '1000', '--json'], { encoding: 'utf8' }));
  ok(out.phase !== 'steady' && out.neutralX_mm === null, 'run.mjs stopped before the steady phase: neutralX_mm is null', `phase ${out.phase}, neutralX_mm ${out.neutralX_mm}`);
}
done();
