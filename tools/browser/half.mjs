// The half-thickness model on the page, in a headless Chrome: 「板厚方向」 set to 対称 in the conditions panel and
// applied reaches the run (rolling.halfThickness, half the points, the top roll and its mirror image in the geometry),
// the pass runs to the end with the readings of node's TandemSim for the same half pass (the force and the exit
// thickness of the whole sheet), both halves are drawn (as much ink below the seam as above it), a real click on the
// mirror image picks the same point as one on the point, the conditions URL carries sym=1 and opens the same run,
// and the downloaded force history is the history's. Not a `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/half.mjs <url> <download-dir> [shot.png]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced); the downloads land in <download-dir>
// (a new, empty directory). Prints one PASS / FAIL line per item and exits 1 if any failed. About 40 s.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';
import { ok, near, between, done } from '../checks/lib.mjs';
import { TandemSim } from '../../src/mpm/tandem.ts';
import { defaultParams } from '../../src/mpm/params.ts';

const [target, dir, shot] = process.argv.slice(2);
if (!target || !dir || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/half.mjs <url> <download-dir> [shot.png]');
  process.exit(64);
}
mkdirSync(dir, { recursive: true });
const page = (q) => {
  const v = new URL(target);
  v.search = q;
  return v.href;
};
const c = await connect(process.env.CDP_PORT);
const click = (selector) => c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const press = (label) => c.evaluate(`[...document.querySelectorAll('#export button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
const choose = (selector, value) =>
  c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const clickAt = async ({ x, y }) => {
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
const saved = async (name, timeout = 20000) => {
  const f = join(dir, name);
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeout) {
    if (existsSync(f)) {
      const n = statSync(f).size;
      if (n > 0 && n === last) return f;
      last = n;
    }
    await c.sleep(100);
  }
  return null;
};
const settle = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
// the same half pass in node, read as the page's worker reads it (TandemSim with one stand)
const reference = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 6;
  P.rolling.sheetLength = 8e-3;
  P.rolling.halfThickness = true;
  const t = new TandemSim(P, 1);
  while (!t.done && t.sim.step < 400000) t.advance();
  return t.results[0];
};

try {
  await c.setViewport(1600, 1000);
  await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

  // ── the select, applied ────────────────────────────────────────────────────
  await c.navigate(page('?cells=6&L=8'));
  await c.waitFor('window.__mpm?.ready && __mpm.frames > 0', 30000);
  const nFull = await c.evaluate('__mpm.geometry.n');
  ok((await c.evaluate('__mpm.params.rolling.halfThickness')) === undefined && (await c.evaluate('__mpm.geometry.halfThickness')) === false, 'the whole thickness by default: no halfThickness key, the geometry says so');
  const row = await c.evaluate(`(() => { const s = document.querySelector('#panel select[name="sym"]'); const l = s.closest('label'); return { options: [...s.options].map((o) => o.textContent), label: l.querySelector('.field-label')?.textContent ?? l.textContent, shown: getComputedStyle(l).display !== 'none', value: s.value }; })()`);
  ok(row.shown && row.label.includes('板厚方向') && row.options[0] === '全厚（ロール 2 本）' && row.options[1] === '対称（上半分・ロール 1 本）' && row.value === 'full', 'the 板厚方向 select with its two options is in the panel, at 全厚', JSON.stringify(row));
  await choose('#panel select[name="sym"]', 'half');
  await click('#reset');
  let applied = true;
  await c.waitFor('__mpm.ready && __mpm.frames > 0 && __mpm.params.rolling.halfThickness === true', 30000).catch(() => (applied = false));
  ok(applied, 'applied with やり直す: rolling.halfThickness is true', JSON.stringify(await c.evaluate('__mpm.params.rolling.halfThickness')));
  const g = await c.evaluate('__mpm.geometry');
  ok(g.halfThickness === true && g.n === nFull / 2, 'the run is the half model with half the points', `${g.n} of ${nFull}`);
  ok(g.rolls.length === 2 && g.rolls[0].cy > 0 && g.rolls[1].cy === -g.rolls[0].cy && g.rolls[1].omega === -g.rolls[0].omega, 'the geometry carries the top roll and its mirror image for the picture', JSON.stringify(g.rolls));

  // ── to the end: the readings are the whole sheet's ─────────────────────────
  await c.evaluate('__mpm.run()');
  let finished = true;
  await c.waitFor('__mpm.done', 180000).catch(() => (finished = false));
  const diag = await c.evaluate('__mpm.diag');
  ok(finished && diag.phase === 'done', 'the pass runs to the end', diag?.phase);
  const ref = reference();
  const res = await c.evaluate('__mpm.steady');
  ok(res && res.readings >= 1 && res.force !== null, 'the steady means are kept', JSON.stringify(res && { readings: res.readings }));
  near(res.force, ref.steadyForce, 1e-5, "the steady force on the page is node's for the same half pass (the whole sheet's) [N/m]");
  near(res.torque, ref.steadyTorque, 1e-5, "the steady torque is node's [N·m/m]");
  near(res.exitThickness, ref.exitThickness, 1e-5, "the steady exit thickness is node's (2 × the top half) [m]");
  near(res.forwardSlip, ref.forwardSlip, 1e-4, "the forward slip is node's");
  between(res.exitThickness * 1e3, 0.745, 0.765, 'the exit thickness is the whole sheet’s, h0 (1 − r) + springback [mm]');
  const slab = await c.evaluate('__mpm.slab');
  between(slab.ratio, 0.8, 1.3, 'the MPM / slab ratio is of order one (the force is the sheet’s, not the half’s)');

  // ── the picture: both halves, mirrored about the seam ──────────────────────
  await c.waitFor('!__mpm.running', 10000); // the last frames have landed
  await settle();
  const seam = await c.evaluate('__mpm.screenOfPoint(0, 0)');
  const px = await c.evaluate(`(() => {
    const cv = document.getElementById('bite');
    const ctx = cv.getContext('2d');
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    // a column of pixels a little before the exit (x = −0.2 mm), from 1 mm above the seam to 1 mm below it
    const top = __mpm.screenOfPoint(-0.2e-3, 1e-3), bot = __mpm.screenOfPoint(-0.2e-3, -1e-3);
    const x = Math.round((top.x - r.left) * dpr);
    const y0 = Math.round((top.y - r.top) * dpr), y1 = Math.round((bot.y - r.top) * dpr);
    const col = ctx.getImageData(x, y0, 1, y1 - y0).data;
    const ink = [];
    for (let y = 0; y < y1 - y0; y++) { const R = col[4 * y], G = col[4 * y + 1], B = col[4 * y + 2], A = col[4 * y + 3]; ink.push(A > 0 && R + G + B < 600 ? 1 : 0); }
    return { ink, seam: Math.round((${seam.y} - r.top) * dpr) - y0 };
  })()`);
  const above = px.ink.slice(0, px.seam).reduce((a, v) => a + v, 0);
  const below = px.ink.slice(px.seam + 1).reduce((a, v) => a + v, 0);
  ok(above > 5 && below > 5 && Math.abs(above - below) <= 0.1 * (above + below), 'the sheet is inked as much below the seam as above it (the mirror image is drawn)', `${above} rows above, ${below} below the seam`);
  const ends = { first: px.ink.indexOf(1), last: px.ink.lastIndexOf(1) };
  ok(Math.abs(ends.first + ends.last - 2 * px.seam) <= 3, 'and the ink is centred on the seam', `rows ${ends.first}..${ends.last}, seam ${px.seam}`);

  // ── picking: a real click on the mirror image selects the same point ───────
  // a point above the seam that is on the canvas (the sheet has moved on; most of it is off to the right)
  const found = await c.evaluate(`(() => {
    const r = document.getElementById('bite').getBoundingClientRect();
    for (let p = ${g.n} - 1; p >= 0; p--) {
      const s = __mpm.screenOf(p);
      if (s && s.x > r.left + 20 && s.x < r.right - 20 && s.y < ${seam.y} - 4 && s.y > r.top + 20) return { p, s };
    }
    return null;
  })()`);
  ok(found !== null, 'a point above the seam is found on the canvas', JSON.stringify(found));
  const k = found.p;
  const at = found.s;
  await clickAt(at);
  let picked = true;
  await c.waitFor(`__mpm.explorer.id === ${k}`, 5000).catch(() => (picked = false));
  ok(picked, 'a click on the point shows it in the explorer', JSON.stringify(await c.evaluate('__mpm.explorer')));
  await clickAt({ x: at.x, y: 2 * seam.y - at.y });
  // the same id stays: wait a moment for the click to land, then read
  await c.sleep(200);
  const e2 = await c.evaluate('__mpm.explorer');
  const nearest = await c.evaluate(`(() => { const m = { x: ${at.x}, y: ${2 * seam.y - at.y} }; const out = []; for (let p = 0; p < ${g.n}; p++) { const s = __mpm.screenOf(p); if (s) out.push([p, +Math.hypot(s.x - m.x, 2 * ${seam.y} - s.y - m.y).toFixed(1)]); } return out.sort((a, b) => a[1] - b[1]).slice(0, 3); })()`);
  ok(e2.id === k, 'a click on its mirror image (as far below the seam) shows the same point', `${JSON.stringify(e2)}, nearest by the mirror ${JSON.stringify(nearest)}`);
  // a neighbouring row picks another point: the mirror pick is not a stuck selection
  const at2 = await c.evaluate(`(() => { const s = __mpm.screenOf(${k}); for (let p = 0; p < ${g.n}; p++) { if (p === ${k}) continue; const t = __mpm.screenOf(p); if (t && Math.abs(t.x - s.x) < 1 && t.y > s.y + 8 && t.y < ${seam.y} - 2) return { p, s: t }; } return null; })()`);
  let other = at2 !== null;
  if (at2) {
    await clickAt({ x: at2.s.x, y: 2 * seam.y - at2.s.y });
    await c.waitFor(`__mpm.explorer.id === ${at2.p}`, 5000).catch(() => (other = false));
  }
  ok(other, 'the mirror image of a point under it picks that point', JSON.stringify({ at2, explorer: await c.evaluate('__mpm.explorer') }));

  if (shot) {
    await settle();
    console.log(`shot  ${await c.screenshot(shot)}`);
  }

  // ── the conditions URL and the CSV ─────────────────────────────────────────
  await press('条件の URL をコピー');
  await c.waitFor("document.getElementById('conditions-url').value.startsWith('http')", 5000);
  const url = await c.evaluate("document.getElementById('conditions-url').value");
  ok(new URL(url).searchParams.get('sym') === '1' && !new URL(url).searchParams.has('cond'), 'the conditions URL carries sym=1 (no cond)', url);
  const h = await c.evaluate('__mpm.history');
  await press('荷重の推移（CSV）');
  const fForce = await saved(`rolling-force-step${diag.step}.csv`);
  ok(fForce !== null, 'the force history is downloaded', `rolling-force-step${diag.step}.csv`);
  if (fForce) {
    const lines = readFileSync(fForce, 'utf8').trim().split('\n');
    const rows = lines.slice(1).map((l) => l.split(',').map(Number));
    ok(rows.length === h.t.length && rows.at(-1)[1] === h.F.at(-1), 'its rows are __mpm.history (the whole sheet’s force, kN/mm)', `${rows.length} rows, last ${rows.at(-1)?.[1]}`);
    const peak = Math.max(...rows.map((r) => r[1]));
    const inBite = rows.filter((r) => r[1] > 0.5 * peak);
    between(inBite.reduce((a, r) => a + r[1], 0) / inBite.length, 2.8, 4.0, 'the force while the sheet is in the bite is the whole sheet’s [kN/mm]');
  }
  // the URL opens the same run
  await c.navigate(url);
  await c.waitFor('window.__mpm?.ready && __mpm.frames > 0', 30000);
  ok((await c.evaluate('__mpm.params.rolling.halfThickness')) === true && (await c.evaluate('__mpm.geometry.n')) === g.n, 'the URL opens the half model again with the same points');
  ok((await c.evaluate(`document.querySelector('#panel select[name="sym"]').value`)) === 'half', 'and the panel shows 対称');
  // back to the whole model through the select
  await choose('#panel select[name="sym"]', 'full');
  await click('#reset');
  await c.waitFor('__mpm.ready && __mpm.frames > 0 && __mpm.params.rolling.halfThickness === undefined', 30000).catch(() => {});
  ok((await c.evaluate('__mpm.params.rolling.halfThickness')) === undefined && (await c.evaluate('__mpm.geometry.n')) === nFull, '全厚 again: the key is gone and the points are all there');
  await c.navigate('about:blank');
} catch (e) {
  ok(false, `exception: ${e?.stack ?? e}`);
  await c.navigate('about:blank').catch(() => {});
}
c.close();
done();
