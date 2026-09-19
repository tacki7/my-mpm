// The stress explorer in a headless Chrome: a real click on a material point
// shows that point, and the σeq and η shown are the simulation's own values
// (read from the worker, where the Sim lives); in front tension the first point
// to fail is followed with its loading path up to D = 1. Not a `@check` (it needs
// the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/explorer.mjs <url> [shot.png]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, between, done } from '../checks/lib.mjs';

const [target, shot] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/explorer.mjs <url> [shot.png]');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};

const c = await connect(process.env.CDP_PORT);
// The simulation runs in a dedicated worker: attach to it to read the Sim directly.
let worker = null;
c.onEvent((d) => {
  if (d.method === 'Target.attachedToTarget' && d.params.targetInfo.type === 'worker') worker = d.params.sessionId;
});
await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const inWorker = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true }, worker);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const click = async ({ x, y }) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
};
const row = (key) => c.evaluate(`(() => { const r = document.querySelector('#explorer-state tr[data-key="${key}"]'); return r && { value: +r.dataset.value, text: r.children[1].textContent }; })()`);

try {
  await c.setViewport(1600, 1000);

  // ── a click shows that point, with the simulation's values ──────────────────
  worker = null;
  await c.navigate(page('?autorun=1&cells=6&L=8&stopafter=9000'));
  await c.waitFor('__mpm.done', 180000);
  for (let i = 0; i < 50 && worker === null; i++) await c.sleep(100); // the attach event arrives on its own
  ok(worker !== null, 'attached to the simulation worker');
  // a point just under the top surface, half-way through the bite, still intact
  const k = await inWorker(`(() => {
    const s = self.__sim, Lc = s.contactLength;
    for (let p = 0; p < s.n; p++)
      if (s.active[p] && !s.failed[p] && s.lj[p] === s.NJ - 2 && s.px[p] > -0.55 * Lc && s.px[p] < -0.45 * Lc) return p;
    return -1;
  })()`);
  ok(k >= 0, 'a point in the bite is found', `particle ${k}`);
  const at = await c.evaluate(`__mpm.screenOf(${k})`);
  await click(at);
  let shown = true;
  await c.waitFor(`__mpm.explorer.id === ${k} && document.querySelector('#explorer-state').dataset.id === '${k}'`, 5000).catch(() => (shown = false));
  ok(shown, 'clicking the point shows it in the explorer', `explorer ${JSON.stringify(await c.evaluate('__mpm.explorer'))}`);
  const sim = await inWorker(`(() => { const s = self.__sim; return { seq: s.seq[${k}], eta: s.eta[${k}], ep: s.ep[${k}] }; })()`);
  const seq = await row('seq');
  const eta = await row('eta');
  ok(seq?.value === sim.seq && seq?.text === (sim.seq * 1e-6).toFixed(0), 'σeq shown = Sim.seq of that point', `${seq?.text} MPa, Sim ${(sim.seq * 1e-6).toFixed(3)} MPa`);
  ok(eta?.value === sim.eta && eta?.text === sim.eta.toFixed(3), 'η shown = Sim.eta of that point', `${eta?.text}, Sim ${sim.eta}`);
  // the Lode parameter from the Sim's own stresses (plane-strain J2 flow would give ≈ 0; the solver's
  // σzz does not satisfy that everywhere yet, so this checks the display, not the solver)
  const lode = await row('lode');
  const st = await inWorker(`(() => { const s = self.__sim, p = ${k}, pr = s.pres[p]; return [s.sxx[p] - pr, s.syy[p] - pr, s.sxy[p], s.szz[p] - pr, s.szz[p] / s.seq[p]]; })()`);
  const c0 = 0.5 * (st[0] + st[1]);
  const r0 = Math.sqrt(0.25 * (st[0] - st[1]) ** 2 + st[2] ** 2);
  const [a1, a2, a3] = [c0 + r0, c0 - r0, st[3]].sort((a, b) => b - a);
  const L = (2 * a2 - a1 - a3) / (a1 - a3);
  between(Math.abs(lode.value - L), 0, 1e-9, 'Lode parameter shown = the one of the Sim stresses', `${lode.text} (deviatoric σzz/σeq ${st[4].toFixed(3)}; plane-strain J2 flow gives Lode 0)`);
  const pathLen = await c.evaluate(`(__mpm.tracks.find((t) => t.role === 'selected')?.path.length ?? 0) / 3`);
  ok(pathLen >= 2, 'the selected point has a loading path', `${pathLen} points, εp ${sim.ep.toFixed(4)}`);

  // ── front tension: the first point to fail reaches D = 1 on its path ────────
  // The preset as tuned (580 MPa, 35 %, μ 0.15; docs/presets.md): with 6 cells the strip past
  // the exit cracks at about step 17 800 (2026-09-19), outside the gripped head.
  worker = null;
  await c.navigate(page('?preset=front-tension&autorun=1&cells=6'));
  let cracked = true;
  await c.waitFor('__mpm.cracks.length > 0', 240000).catch(() => (cracked = false));
  await c.evaluate("document.getElementById('pause').click()");
  await c.waitFor('!__mpm.running', 10000);
  ok(cracked, 'front tension: a crack appears', `${await c.evaluate('__mpm.cracks.length')} cracks at step ${await c.evaluate('__mpm.diag.step')}`);
  if (cracked) {
    await c.waitFor(`__mpm.explorer.role === 'first-crack'`, 5000).catch(() => {});
    ok((await c.evaluate('__mpm.explorer.role')) === 'first-crack', 'the explorer turns to the first crack by itself');
    const t = await c.evaluate(`__mpm.tracks.find((t) => t.role === 'first-crack')`);
    const n = t.path.length / 3;
    const [etaF, epF, dF] = t.path.slice(-3);
    between(dF, 1, 1.05, 'its path ends at failure with D ≈ 1', `${n} points, η ${etaF.toFixed(3)}, εp ${epF.toFixed(4)}`);
    const crack0 = await c.evaluate('__mpm.cracks[0]');
    ok(etaF === crack0.eta, 'the path ends at the stress state of the failure (η of the crack record)', `η ${etaF}, crack ${crack0.eta}`);
    const id = await inWorker(`(() => { const s = self.__sim; return { failed: s.failed[${t.id}], crack: s.crackId[${t.id}], d: s.governingDamage(${t.id}) }; })()`);
    ok(id.failed === 1 && id.crack === 0, 'it is a failed point of crack 1 in the Sim', JSON.stringify(id));
    // where the path ends against the plotted locus (Cockcroft-Latham, plane strain)
    const C = await c.evaluate('__mpm.params.damage.clCrit');
    const ef = C / (etaF + 1 / Math.sqrt(3));
    console.log(`       end of path: εp ${epF.toFixed(4)} against εf(η) ${ef.toFixed(4)} (ratio ${(epF / ef).toFixed(3)}); the ratio is 1 only for constant η`);
    await c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    if (shot) console.log(`shot  ${await c.screenshot(shot)}`);
    if (shot) {
      const r = await c.evaluate(`(() => { const b = document.getElementById('locus').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, scale: 2 }; })()`);
      console.log(`shot  ${await c.screenshot(shot.replace(/\.png$/, '-locus.png'), r)}`);
    }
  }
  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
