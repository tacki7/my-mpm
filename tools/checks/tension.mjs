// Strip tensions: what the exit strip carries equals the front tension asked for
// (the end load is a stress on the current, rolled cross-section), the entry strip
// carries the back tension, and the back tension lets go once the tail reaches the
// rolls instead of dragging the rolled sheet back through them.
// @check
import { ok, near, done } from './lib.mjs';
import { Sim } from '../../src/mpm/solver.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const MPa = 1e6;

function coarse() {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  P.damage.model = 'none';
  return P;
}

/** volume-averaged σxx of the points with x ∈ [x0, x1] (the mean axial stress of that stretch of strip) */
function sectionStress(sim, x0, x1) {
  let f = 0;
  let v = 0;
  for (let p = 0; p < sim.n; p++) {
    if (!sim.active[p] || sim.px[p] < x0 || sim.px[p] > x1) continue;
    const V = sim.vol0[p] * (sim.f00[p] * sim.f11[p] - sim.f01[p] * sim.f10[p]);
    f += (sim.sxx[p] - sim.pres[p]) * V;
    v += V;
  }
  return f / v;
}

// ── front tension: the exit strip carries σf, not σf·h0/h1 ─────────────────────
{
  const P = coarse();
  P.rolling.frontTension = 100 * MPa;
  const sim = new Sim(P);
  // well past the probe: the tension is on and ramped up (about 1.4 ms, i.e. 1.4 mm of travel here)
  while (sim.step < 60000 && !(sim.headX() > sim.xExitProbe + 3e-3)) sim.advance();
  const x0 = sim.xExitProbe + 0.3e-3;
  let s = 0;
  const N = 40;
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < 50; i++) sim.advance();
    s += sectionStress(sim, x0, x0 + 0.6e-3);
  }
  near(s / N / MPa, 100, 0.1, 'exit strip stress [MPa] under 100 MPa front tension');
}

// ── back tension: carried by the entry strip, released once the tail reaches the bite
{
  const P = coarse();
  P.rolling.backTension = 100 * MPa;
  const V = P.rolling.rollSpeed;
  const sim = new Sim(P);
  const entry = [];
  let slowTail = 0;
  let afterExit = 0;
  while (sim.step < 60000) {
    for (let i = 0; i < 50; i++) sim.advance();
    const tail = sim.tailX();
    // the strip just ahead of the tail, while the tail is still well before the bite (after the ramp)
    // (and while the pusher carries no load: until the rolls grip, it holds the tail against the back tension)
    const d = sim.diagnostics();
    const free = d.pusherForce < 0.02 * P.rolling.backTension * P.rolling.h0;
    if (sim.t > 3e-3 && free && tail < -sim.contactLength - 1.5e-3) entry.push(sectionStress(sim, tail + 0.5e-3, tail + 1.1e-3));
    // once the tail has left the rolls nothing pulls it back: it keeps the exit speed
    if (tail > 0 && tail < 1e3) {
      afterExit++;
      let v = 0;
      let c = 0;
      for (let p = 0; p < sim.n && sim.tag[p] === 1; p++) if (sim.active[p]) (v += sim.vx[p]), c++;
      if (v / c < 0.8 * V) slowTail++;
    }
    if (d.phase === 'done') break;
  }
  const d = sim.diagnostics();
  ok(entry.length >= 5, 'entry strip sampled while the rolls pull against the back tension', `${entry.length} samples`);
  near(entry.reduce((a, b) => a + b, 0) / Math.max(1, entry.length) / MPa, 100, 0.1, 'entry strip stress [MPa] under 100 MPa back tension');
  ok(afterExit > 0 && slowTail === 0, 'the tail keeps its speed after leaving the rolls (no back tension left)', `${slowTail} of ${afterExit} samples below 0.8 V`);
  ok(d.phase === 'done' && Number.isFinite(d.tailX) && d.tailX < 1e3, 'the rolled sheet leaves on the exit side (not dragged back off the grid)', `phase ${d.phase}, tail ${d.tailX}`);
}
done();
