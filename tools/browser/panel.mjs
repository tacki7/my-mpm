// The conditions panel in a headless Chrome: a material constant and D4 edited in
// the panel reach the run's params after "条件を反映", the material is then marked
// カスタム, a void added in the defect list removes the particles there, and an
// out-of-range entry is flagged with its range. Not a `@check` (it needs the dev
// server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/panel.mjs <url> [shot.png]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
// Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shot] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/panel.mjs <url> [shot.png]');
  process.exit(64);
}
const u = new URL(target);
u.search = '?cells=6&L=8&stopafter=6000';

const c = await connect(process.env.CDP_PORT);
const type = (selector, value) =>
  c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const click = (selector) => c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

try {
  await c.setViewport(1600, 1000);
  await c.navigate(u.href);
  await c.waitFor('window.__mpm?.ready && __mpm.frames > 0', 30000);
  const n0 = await c.evaluate('__mpm.geometry.n');

  // material constants: SPCC is Swift; K 560 → 600 MPa
  await click('.material-editor summary');
  ok(await c.evaluate("document.querySelector('.custom-badge').hidden"), 'the catalogue material is not marked カスタム');
  await type('input[name="mat-swK"]', 600);
  ok(!(await c.evaluate("document.querySelector('.custom-badge').hidden")), 'an edited constant marks it カスタム');
  await type('#panel input[name="D4"]', 0.01);

  // a void 1.5 mm behind the head, on the mid-plane
  await click('.add-defect');
  await type('.defect input[name="defect-x"]', 1.5);
  await type('.defect input[name="defect-y"]', 0);
  await type('.defect input[name="defect-ax"]', 0.4);
  await type('.defect input[name="defect-ay"]', 0.15);
  const shown = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}).closest('.field'); return getComputedStyle(e).display !== 'none'; })()`);
  ok(!(await shown('.defect input[name="defect-ductility"]')), 'a void has no ductility row');
  ok((await shown('input[name="mat-swK"]')) && !(await shown('input[name="mat-jcA"]')), 'only the constants of the hardening law in use are shown');

  // an out-of-range entry is flagged, and put right again
  await type('#panel input[name="h0"]', 999);
  const bad = await c.evaluate(`(() => { const r = document.querySelector('#panel input[name="h0"]').closest('.field'); return { bad: r.classList.contains('bad'), why: r.querySelector('.why').textContent }; })()`);
  ok(bad.bad && /0\.05〜50/.test(bad.why), 'an out-of-range thickness is flagged with its range', bad.why);
  await type('#panel input[name="h0"]', 1);
  ok(!(await c.evaluate(`document.querySelector('#panel input[name="h0"]').closest('.field').classList.contains('bad')`)), 'and cleared when put right');

  // 条件を反映してやり直す
  await click('#reset');
  await c.waitFor(`__mpm.ready && __mpm.frames > 0 && __mpm.geometry.n < ${n0}`, 30000).catch(() => {});
  const p = await c.evaluate('__mpm.params');
  near(p.material.swK, 600e6, 1e-12, 'the Swift K reaches the run');
  near(p.damage.D4, 0.01, 1e-12, 'D4 reaches the run');
  const d = p.defects[0];
  ok(p.defects.length === 1 && d.kind === 'void', 'one void in the run', JSON.stringify(p.defects));
  near(d?.x, 1.5e-3, 1e-9, 'its distance from the head');
  near(d?.ay, 0.15e-3, 1e-9, 'its half thickness');
  const n1 = await c.evaluate('__mpm.geometry.n');
  // the void's ellipse holds about π ax ay / dp² points (dp = h/2 = h0/12 at 6 cells)
  const expect = (Math.PI * 0.4 * 0.15) / (1 / 12) ** 2;
  ok(n0 - n1 > 0.7 * expect && n0 - n1 < 1.3 * expect, 'the void removes the points inside it', `${n0} → ${n1} points (${n0 - n1}, ellipse ≈ ${expect.toFixed(0)})`);
  ok(!(await c.evaluate("document.querySelector('.custom-badge').hidden")), 'after the restart the material is still shown as カスタム');

  // run into the bite and look at the hole
  await c.evaluate('__mpm.run()');
  await c.waitFor('__mpm.done', 180000);
  if (shot) {
    await c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    console.log(`shot  ${await c.screenshot(shot)}`);
  }
  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
