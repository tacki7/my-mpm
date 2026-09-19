// The central-burst hint on the page, in a headless Chrome (src/app/burstHint.ts): the condition's Δ against the
// map of docs/validation.md「中心割れの地図」 says "compression", "near the turn" or "tension", for 4340 and SPCC
// (the band of the grids measured, 8 to 20 cells: 2.1–2.9 and 2.2–3.7),
// and changes with h0 in the URL; the mid-plane η it shows once the pass is steady is the map's measure
// (src/mpm/midplane.ts) run in node on the same condition; a tandem uses the stand on show's entry thickness.
// Not a `@check` (it needs the dev server and Chrome). About 30 s.
//
//   CDP_PORT=<cdp> node tools/browser/burst-hint.mjs <url> [shot.png]
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';
import { applyQuery } from '../../src/app/query.ts';
import { presetById } from '../../src/mpm/presets.ts';
import { Sim } from '../../src/mpm/solver.ts';
import { LOOK, MidPlaneEta } from '../../src/mpm/midplane.ts';

const [target, shot] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/burst-hint.mjs <url> [shot.png]');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const hint = (c) =>
  c.evaluate(`(() => { const e = document.getElementById('burst-hint'); return { kind: e.dataset.kind, delta: +e.dataset.delta, eta: e.dataset.eta === '' ? null : +e.dataset.eta, text: e.textContent }; })()`);

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);

  // ── the three kinds, before any run (the hint is the condition's)
  const cases = [
    ['cells=6&L=8', 'compressive', '板厚中心は圧縮', 'the standard thin sheet (Δ 0.18): compression'],
    ['preset=central-burst&h0=2', 'compressive', '板厚中心は圧縮', 'the central-burst preset at h0 2 mm (Δ 1.6, 4340 below 2.1): compression'],
    // the band's low ends: 2.1 for 4340 and 3.7 (the high end) for SPCC, over the grids of 8 to 20 cells (T65).
    // These two Δ sit between the old band (8 to 16 cells: 2.2–2.9 and 2.6–4.0) and this one, so a band from
    // another set of grids reads them differently
    ['preset=central-burst&h0=3.6', 'near', '境目の近く', "at h0 3.6 mm (Δ 2.14, inside 4340's 2.1 but not 2.2): near the turn"],
    ['preset=central-burst&h0=4.93', 'near', '境目の近く', "at h0 4.93 mm (Δ 2.5, within 4340's 2.1–2.9): near the turn"],
    ['preset=central-burst', 'tensile', '中心割れが出やすい', 'the central-burst preset (Δ 3.58, 4340): tension'],
    ['preset=central-burst&mat=spcc', 'near', '境目の近く', "the same shape in SPCC (Δ 3.58, within SPCC's 2.2–3.7): near the turn"],
    ['preset=central-burst&mat=spcc&h0=12', 'tensile', '中心割れが出やすい', "SPCC at h0 12 mm (Δ 3.92, past SPCC's 3.7 but not 4.0): tension"],
    ['preset=central-burst&mat=spcc&h0=16', 'tensile', '中心割れが出やすい', 'SPCC at h0 16 mm (Δ 4.53): tension'],
  ];
  for (const [q, kind, words, what] of cases) {
    await c.navigate(page(q));
    await c.waitFor('window.__mpm?.ready && __mpm.frames >= 1', 30000);
    const h = await hint(c);
    ok(h.kind === kind && h.text.includes(words) && h.text.includes(`Δ = ${h.delta.toFixed(2)}`), what, `${h.kind}, Δ ${h.delta.toFixed(3)}: ${h.text.slice(0, 50)}`);
  }

  // ── the mid-plane η once steady = the map's measure in node, same condition (8 cells)
  const q = 'preset=central-burst&cells=8';
  await c.navigate(page(`${q}&autorun=1`));
  await c.waitFor('__mpm.done', 120000);
  const h = await hint(c);
  const P = applyQuery(presetById('central-burst').build(), new URLSearchParams(q));
  const sim = new Sim(P);
  const mp = new MidPlaneEta(sim);
  while (sim.phase() !== 'done' && sim.step < 2e6) {
    sim.advance();
    if (sim.step % LOOK === 0) mp.look(sim);
  }
  ok(h.eta != null && h.text.includes('実測'), 'after the steady phase the hint shows the measured mid-plane η', h.text.slice(0, 80));
  near(h.eta, mp.middle, 1e-4, `the page's mid-plane η = the map's measure in node (${mp.middle?.toFixed(3)}, ${mp.steadyLooks} looks)`);
  if (shot) {
    await c.screenshot(shot);
    console.log(`shot  ${shot}`);
  }

  // ── a tandem: the stand on show's entry thickness
  await c.navigate(page('stands=2&cells=4&L=4&autorun=1'));
  await c.waitFor('__mpm.done', 120000);
  const t = await hint(c);
  const r2 = await c.evaluate('__mpm.standResults[1]');
  const p = await c.evaluate('__mpm.params');
  const want = (1 - p.rolling.reduction / 2) * Math.sqrt(r2.h0 / (p.rolling.reduction * p.rolling.rollRadius));
  ok(Math.abs(t.delta - want) / want < 0.01 && r2.h0 < p.rolling.h0, "a tandem's hint reads stand 2's entry thickness", `Δ ${t.delta.toFixed(4)} (stand 2's h0 ${(r2.h0 * 1e3).toFixed(3)} mm: ${want.toFixed(4)})`);
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
}
done();
