// The masthead's 「レイアウト」 select (src/app/density.ts, src/styles.css「density」): 標準 / コンパクト. コンパクト puts
// data-density="compact" on <html>, the type scale one step down, the panel's hints and the masthead's subtitle
// away, the masthead lower (and --masthead-h follows the real height); the index tabs still stand on the rule; the
// charts redraw at their new height; the choice is kept in the browser across a reload; the model is untouched
// (the run's numbers do not change). Both the 2D and the 3D tab, and a 700 px screen.
//
//   CDP_PORT=<cdp> node tools/browser/density.mjs <url> [out-prefix]
//
// About 40 s. Prints one PASS / FAIL line per item and exits 1 if any failed. Look at the screenshots yourself.
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/density.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;

/** what the page looks like now: the attribute, the masthead's height against its token, the tabs on the rule, the hints, the type */
const STATE = `(() => {
  const root = document.documentElement;
  const mast = document.querySelector('.masthead');
  const tab = document.querySelector('.dim-tabs button[aria-selected="true"]') ?? document.querySelector('.dim-tabs button');
  const hint = document.querySelector('.conditions .hint');
  const sel = document.getElementById('density');
  return {
    density: __mpm.density,
    attr: root.dataset.density ?? null,
    select: sel.value,
    options: [...sel.options].map((o) => o.textContent),
    mastheadH: mast.offsetHeight,
    token: parseFloat(getComputedStyle(root).getPropertyValue('--masthead-h')),
    tabGap: mast.getBoundingClientRect().bottom - tab.getBoundingClientRect().bottom,
    hint: hint ? getComputedStyle(hint).display : null,
    subtitle: getComputedStyle(document.querySelector('.title p')).display,
    fontPx: parseFloat(getComputedStyle(document.body).fontSize),
    chartH: document.querySelector('.charts canvas')?.clientHeight ?? null,
    stored: localStorage.getItem('mpm-density'),
  };
})()`;
const choose = (c, d) => c.evaluate(`(() => { const s = document.getElementById('density'); s.value = '${d}'; s.dispatchEvent(new Event('change', { bubbles: true })); return new Promise((r) => setTimeout(r, 300)); })()`);

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  await c.evaluate('(() => { try { localStorage.removeItem("mpm-density"); } catch {} })()').catch(() => {});

  // ── the section, a run to the end: the default, then compact, the same numbers
  await c.navigate(page('/?autorun=1&cells=6&L=8'));
  await c.waitFor('__mpm.done', 180000);
  const std = await c.evaluate(STATE);
  ok(std.density === 'standard' && std.attr === null && std.select === 'standard', 'the default is 標準, no attribute on <html>', JSON.stringify([std.density, std.attr, std.select]));
  ok(std.options.join(',') === '標準,コンパクト', 'the select lists 標準 and コンパクト', std.options.join(','));
  near(std.token, std.mastheadH, 0.02, `--masthead-h is the masthead's real height (${std.mastheadH} px)`);
  ok(std.tabGap >= 0 && std.tabGap <= 3, 'the index tabs stand on the rule', `${std.tabGap.toFixed(1)} px above the masthead\'s bottom`);
  ok(std.hint === 'block' && std.subtitle === 'block', 'the hints and the subtitle are shown', `${std.hint} / ${std.subtitle}`);
  const force0 = await c.evaluate('__mpm.slab.steadyForce');
  if (shots) await c.screenshot(`${shots}-standard.png`);

  await choose(c, 'compact');
  const cmp = await c.evaluate(STATE);
  ok(cmp.density === 'compact' && cmp.attr === 'compact' && cmp.stored === 'compact', 'コンパクト sets data-density and is kept in the browser', JSON.stringify([cmp.density, cmp.attr, cmp.stored]));
  ok(cmp.mastheadH < std.mastheadH - 20, 'the masthead is lower', `${std.mastheadH} → ${cmp.mastheadH} px`);
  near(cmp.token, cmp.mastheadH, 0.02, `--masthead-h follows (${cmp.mastheadH} px)`);
  ok(cmp.tabGap >= 0 && cmp.tabGap <= 3, 'the index tabs still stand on the rule', `${cmp.tabGap.toFixed(1)} px`);
  ok(cmp.hint === 'none' && cmp.subtitle === 'none', 'the hints and the subtitle are folded away', `${cmp.hint} / ${cmp.subtitle}`);
  ok(cmp.fontPx < std.fontPx, 'the type is one step smaller', `${std.fontPx} → ${cmp.fontPx} px`);
  ok(cmp.chartH !== null && cmp.chartH < std.chartH, 'the charts are lower', `${std.chartH} → ${cmp.chartH} px`);
  const force1 = await c.evaluate('__mpm.slab.steadyForce');
  ok(typeof force0 === 'number' && force1 === force0, 'the model is untouched (the same steady force)', `${force0} / ${force1}`);
  // the field the 2D view draws still draws (no exception in the redraw)
  const ms = await c.evaluate('__mpm.drawMs(3)');
  ok(typeof ms === 'number' && ms >= 0, 'the picture redraws in compact', `${ms.toFixed(2)} ms`);
  if (shots) await c.screenshot(`${shots}-compact.png`);

  // ── a reload keeps the choice, from the first paint
  await c.navigate(page('/?cells=6&L=8'));
  await c.waitFor('__mpm.ready', 60000);
  const kept = await c.evaluate(STATE);
  ok(kept.density === 'compact' && kept.attr === 'compact' && kept.select === 'compact', 'after a reload the choice holds and the select shows it', JSON.stringify([kept.density, kept.attr, kept.select]));

  // ── the 3D tab in compact
  await c.evaluate('__mpm.solid.setDim("3")');
  await c.waitFor('__mpm.solid.active', 20000);
  await c.sleep(400);
  const s3 = await c.evaluate(STATE);
  ok(s3.attr === 'compact' && s3.tabGap >= 0 && s3.tabGap <= 3, '3D tab: compact, the tabs on the rule', `${s3.tabGap.toFixed(1)} px`);
  near(s3.token, s3.mastheadH, 0.02, `3D tab: --masthead-h follows (${s3.mastheadH} px)`);
  if (shots) await c.screenshot(`${shots}-3d.png`);

  // ── 700 px: one column, the select under the clock, the tabs still last on the rule
  await c.setViewport(700, 900);
  await c.evaluate('__mpm.solid.setDim("2")');
  await c.sleep(400);
  const narrow = await c.evaluate(`(() => {
    const sel = document.querySelector('.density').getBoundingClientRect();
    const tab = document.querySelector('.dim-tabs button').getBoundingClientRect();
    const mast = document.querySelector('.masthead').getBoundingClientRect();
    return { selBottom: sel.bottom, tabTop: tab.top, tabGap: mast.bottom - tab.bottom, w: document.documentElement.scrollWidth };
  })()`);
  ok(narrow.selBottom <= narrow.tabTop && narrow.tabGap >= 0 && narrow.tabGap <= 3 && narrow.w <= 700, '700 px: the select above the tabs, the tabs on the rule, no sideways scroll', JSON.stringify(narrow));
  if (shots) await c.screenshot(`${shots}-700.png`);

  // ── back to 標準: the attribute goes, the choice is kept
  await c.setViewport(1600, 1000);
  await choose(c, 'standard');
  const back = await c.evaluate(STATE);
  ok(back.density === 'standard' && back.attr === null && back.stored === 'standard' && back.hint === 'block', '標準 again removes the attribute and shows the hints', JSON.stringify([back.attr, back.stored, back.hint]));
  await c.evaluate('(() => { localStorage.removeItem("mpm-density"); })()');
  await c.navigate('about:blank');
} catch (err) {
  ok(false, 'the density check ran to the end', String(err?.message ?? err));
} finally {
  c?.close?.();
}
done();
