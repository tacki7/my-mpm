// Saving the results in a headless Chrome: the CSV files are really downloaded and
// read back (the force history equals __mpm.history), the PNG is a PNG, a tandem's PNG
// has the stands' numbers readable on the pictures (4.5:1 in the saved file), and the
// conditions URL starts exactly the same conditions (JSON of __mpm.params). Not a
// `@check` (it needs the dev server and Chrome).
//
//   CDP_PORT=<cdp> node tools/browser/export.mjs <url> <download-dir>
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced); the files
// land in <download-dir> (a new, empty directory). Exits 1 if any item failed.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';
import { ok, done } from '../checks/lib.mjs';
import { FILL_TEXT_HOOK, TEXT_CONTRAST } from './canvas-text.mjs';

const [target, dir] = process.argv.slice(2);
if (!target || !dir || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/export.mjs <url> <download-dir>');
  process.exit(64);
}
mkdirSync(dir, { recursive: true });
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const c = await connect(process.env.CDP_PORT);
// a download is complete when the file is there and has stopped growing
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
const press = (label) => c.evaluate(`[...document.querySelectorAll('#export button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

try {
  await c.setViewport(1600, 1000);
  await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  // every fillText with its box (the numbers drawn into a tandem's PNG): canvas-text.mjs
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FILL_TEXT_HOOK });

  // ── the files ───────────────────────────────────────────────────────────────
  await c.navigate(page('?autorun=1&cells=6&L=8&stopafter=9000'));
  await c.waitFor('__mpm.done', 180000);
  const h = await c.evaluate('__mpm.history');
  await press('荷重の推移（CSV）');
  const fForce = await saved('rolling-force-step9000.csv');
  ok(fForce !== null, 'the force history is downloaded');
  if (fForce) {
    const lines = readFileSync(fForce, 'utf8').trim().split('\n');
    const rows = lines.slice(1).map((l) => l.split(',').map(Number));
    ok(lines[0] === 't_ms,force_kN_per_mm,torque_kN_m_per_m', 'its header', lines[0]);
    ok(rows.length === h.t.length, 'one row per sample', `${rows.length} rows, history ${h.t.length}`);
    const firstSame = rows.slice(0, 5).every((r, i) => r[0] === h.t[i] && r[1] === h.F[i] && r[2] === h.T[i]);
    ok(firstSame && rows.at(-1)[1] === h.F.at(-1), 'the rows equal __mpm.history (first five and the last, exactly)', lines.slice(1, 3).join(' | '));
  }
  await press('圧力分布（CSV）');
  const fProf = await saved('contact-pressure-step9000.csv');
  const prof = fProf ? readFileSync(fProf, 'utf8').trim().split('\n') : [];
  ok(prof[0] === 'x_mm,pressure_MPa,friction_MPa' && prof.length > 10, 'the pressure profile is downloaded', `${prof.length - 1} rows`);
  await press('亀裂の一覧（CSV）');
  const fCr = await saved('cracks-step9000.csv');
  const cr = fCr ? readFileSync(fCr, 'utf8').trim().split('\n') : [];
  ok(cr[0]?.startsWith('crack,t_ms,step,') && cr.length - 1 === (await c.evaluate('__mpm.cracks.length')), 'the crack list is downloaded, one row per crack', `${cr.length - 1} rows`);
  await press('ロールバイト（PNG）');
  const fPng = await saved('roll-bite-step9000.png');
  const png = fPng ? readFileSync(fPng) : Buffer.alloc(0);
  ok(png.subarray(1, 4).toString() === 'PNG' && png.length > 10000, 'the roll bite is saved as a PNG', `${png.length} bytes`);

  // ── a tandem's PNG: the stands side by side, each number on the sheet's colour as on the page (read back from
  //    the saved file: in each number's box, the ink against the ground)
  await c.navigate(page('?stands=2&cells=4&L=4&autorun=1'));
  await c.waitFor('__mpm.done', 180000);
  const pngsBefore = new Set(readdirSync(dir).filter((f) => f.endsWith('.png')));
  await c.evaluate('window.__texts.length = 0; true');
  await press('ロールバイト（PNG）');
  let tanName = null;
  for (let t0 = Date.now(); !tanName && Date.now() - t0 < 20000; await c.sleep(100)) tanName = readdirSync(dir).find((f) => f.endsWith('.png') && !pngsBefore.has(f)) ?? null;
  const fTan = tanName ? await saved(tanName) : null;
  const numbers = fTan
    ? await c.evaluate(`(async () => {
        ${TEXT_CONTRAST}
        const im = new Image();
        im.src = 'data:image/png;base64,${readFileSync(fTan).toString('base64')}';
        await im.decode();
        const cv = document.createElement('canvas');
        cv.width = im.width;
        cv.height = im.height;
        const g = cv.getContext('2d');
        g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        return window.__texts
          .filter((t) => t.width === cv.width && t.height === cv.height && /^#\\d+$/.test(t.text))
          .map((t) => ({ text: t.text, ...window.__textContrast(d, cv.width, cv.height, t.box, t.fill) }));
      })()`)
    : [];
  ok(numbers.length === 2 && numbers.every((n) => n.r >= 4.5 && n.seen >= 3), "a tandem's PNG has each stand's number readable on the picture (4.5:1)", numbers.map((n) => `${n.text} ${n.r.toFixed(2)}`).join(', ') || tanName || 'no PNG');

  // ── the conditions URL ──────────────────────────────────────────────────────
  await c.navigate(page('?preset=void&cells=6&L=8'));
  await c.waitFor('__mpm.ready && __mpm.frames > 0', 30000);
  const edit = (name, v) => c.evaluate(`(() => { const e = document.querySelector('#panel [name="${name}"]'); e.value = '${v}'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await edit('mu', 0.137);
  await edit('D2', 1.234);
  await edit('damage', 'cockcroft-latham');
  await c.evaluate("document.getElementById('reset').click()");
  await c.waitFor('__mpm.ready && __mpm.frames > 0 && __mpm.params.rolling.mu === 0.137', 30000);
  const before = await c.evaluate('JSON.stringify(__mpm.params)');
  await press('条件の URL をコピー');
  await c.waitFor("document.getElementById('conditions-url').value.startsWith('http')", 5000);
  const url = await c.evaluate("document.getElementById('conditions-url').value");
  await c.navigate(url);
  await c.waitFor('__mpm.ready && __mpm.frames > 0', 30000);
  const after = await c.evaluate('JSON.stringify(__mpm.params)');
  ok(after === before, 'the conditions URL starts exactly the same conditions (JSON of __mpm.params)', url.replace(/^https?:\/\/[^/]+/, ''));
  ok(before.includes('"defects":[{') && before.includes('"mu":0.137'), 'including the preset’s defects and the panel edits');

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c.close();
}
done();
