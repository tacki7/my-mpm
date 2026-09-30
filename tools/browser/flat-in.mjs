// 平坦度の波 on the 3D picture and the tandem's entry flatness (SolidSettings.flatIn), in a headless Chrome:
// - the panel's 「タンデムの入側の平坦度（3 次元）」 rows and their locks, the 「平坦度の波」 view button (on by default)
// - a 4 mm strip rolled to the end stays flat (B/h = 6): the picture has no wave; 「参考: 不感帯を無視」 in 平坦度の形 puts
//   a wavy edge on the picture's exit side (`__mpm.solid.view.wave`, `screenOfPoint` moves at the edge past the exit,
//   not in the middle, not before the bite), the button takes it off and puts it back, 「高さの倍率」 scales it
// - two stands (W 2 mm, crown 40 µm, handoff steady, the band ignored) from the URL, rolled to the end: the second
//   stand's strip comes in wavy from the first's flatness and is solved through the whole thickness (the stand
//   table's row, the results' row, the legend's note), against `node tools/solid.mjs --stands 2 --flat-in --flat-latent`
//   (the wave's height to 1e-3, the second stand's force to 1 %), the URL carries the settings
// Not a `@check`. About 8 minutes on one thread.
//
//   CDP_PORT=<cdp> node tools/browser/flat-in.mjs <url> [out-prefix]
//
// Writes <out-prefix>-wave.png and -tandem.png when a prefix is given; look at them.
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/flat-in.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const centre = async (selector) => {
    const r = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${selector}`);
    return r;
  };
  const mouse = (type, x, y, more = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...more });
  const click = async (selector) => {
    const r = await centre(selector);
    await mouse('mousePressed', r.x, r.y);
    await mouse('mouseReleased', r.x, r.y);
  };
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const visible = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getBoundingClientRect().height > 0; })()`);
  const shot = async (name) => {
    if (!shots) return;
    await painted();
    await c.screenshot(`${shots}-${name}.png`);
    console.log(`shot  ${shots}-${name}.png`);
  };
  // a point's place on the canvas (client coordinates less the canvas's: the page scrolls when a control is clicked)
  const point = (x, y, z) => c.evaluate(`(() => { const p = __mpm.solid.screenOfPoint(${x}, ${y}, ${z}); const r = document.getElementById('solid-canvas').getBoundingClientRect(); return { x: p.x - r.x, y: p.y - r.y }; })()`);

  // ── the panel and the view button
  const W = 4;
  await c.navigate(page(`?dim=3&W3=${W}&threads3=1`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  ok((await visible('[name="solid-flat-in"]')) && (await visible('[name="solid-flat-latent"]')) && (await visible('[name="solid-flatPitch"]')), 'the panel has the entry flatness rows');
  ok(await c.evaluate(`document.querySelector('[name="solid-flat-latent"]').disabled && document.querySelector('[name="solid-flatPitch"]').disabled && !document.querySelector('[name="solid-flat-in"]').checked`), 'the pitch and the band are locked until the strip is carried wavy');
  await click('[name="solid-flat-in"]');
  ok(await c.evaluate(`!document.querySelector('[name="solid-flat-latent"]').disabled && !document.querySelector('[name="solid-flatPitch"]').disabled && document.querySelector('[name="solid-flatPitch"]').value === '1'`), 'the check unlocks them, the pitch 1 × the width');
  await click('[name="solid-flat-in"]');
  ok(await c.evaluate(`document.getElementById('solid-wave').getAttribute('aria-pressed') === 'true'`), 'the 平坦度の波 view button is on by default');
  ok((await c.evaluate('__mpm.solid.view.wave')) === null, 'no wave before a run');

  // ── a flat 4 mm strip: no wave; the band ignored puts a wavy edge on the picture
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  ok((await c.evaluate('__mpm.solid.flat.shape.kind')) === 'flat' && (await c.evaluate('__mpm.solid.view.wave')) === null, 'the 4 mm strip is flat: the picture has no wave');
  const hw = await c.evaluate('__mpm.solid.diag.steady.halfWidth');
  // a quarter pitch past a whole one (the pitch is the width): the crest, not a node of the sine
  const xOut = 2.5 * hw;
  const before = { edge: await point(xOut, 0, hw), mid: await point(xOut, 0, 0), entry: await point(-xOut, 0, hw) };
  await click('#solid-flat-latent');
  await painted();
  const wave = await c.evaluate('JSON.parse(JSON.stringify(__mpm.solid.view.wave))');
  ok(wave && wave.kind === 'edge' && wave.steepness > 0.03, 'the band ignored: a wavy edge on the picture', wave && `${wave.kind} λ ${(wave.steepness * 100).toFixed(2)} %, pitch ${(wave.pitch * 1e3).toFixed(1)} mm, ×${wave.scale}`);
  near(wave.pitch, 2 * hw, 1e-9, 'its pitch is the width out (the 平坦度の形 pitch of 1)');
  const after = { edge: await point(xOut, 0, hw), mid: await point(xOut, 0, 0), entry: await point(-xOut, 0, hw) };
  const moved = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  ok(moved(before.edge, after.edge) > 2, 'a point at the edge past the exit moves with the wave', `${moved(before.edge, after.edge).toFixed(1)} px`);
  ok(moved(before.mid, after.mid) < 1e-6, 'a point in the middle does not (a wavy edge is flat there)');
  ok(moved(before.entry, after.entry) < 1e-6, 'a point before the bite does not');
  await c.evaluate(`document.getElementById('solid-canvas').scrollIntoView({ block: 'start' })`);
  await shot('wave');
  await click('#solid-wave');
  await painted();
  ok((await c.evaluate('__mpm.solid.view.wave')) === null && (await c.evaluate(`document.getElementById('solid-wave').getAttribute('aria-pressed')`)) === 'false', 'the button takes the wave off');
  const off = await point(xOut, 0, hw);
  ok(moved(off, before.edge) < 1e-6, 'and the edge point is back where it was');
  await click('#solid-wave');
  await painted();
  ok((await c.evaluate('__mpm.solid.view.wave?.kind')) === 'edge', 'and puts it back');
  await c.evaluate(`(() => { const s = document.getElementById('solid-flat-scale'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await painted();
  const w1 = await c.evaluate('__mpm.solid.view.wave.scale');
  const at1 = await point(xOut, 0, hw);
  ok(w1 === 1 && moved(at1, before.edge) < moved(after.edge, before.edge), '高さの倍率 ×1 scales the picture\'s wave down', `${moved(at1, before.edge).toFixed(1)} px against ${moved(after.edge, before.edge).toFixed(1)} px at ×${wave.scale}`);
  ok(/平坦度の波（耳波/.test(await c.evaluate(`document.querySelector('#solid-legend .exag').textContent`)), 'the legend says what is drawn');

  // ── two stands from the URL: the second's strip comes in wavy
  const url = page('?dim=3&W3=2&cells3=4&stands=2&handoff=steady&length=steady&crown3=40&flatin3=1&flatlatent3=1&flatpitch3=1&threads3=1&autorun=1');
  await c.navigate(url);
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  ok(await c.evaluate(`__mpm.solid.settings.flatIn === true && __mpm.solid.settings.flatLatent === true && __mpm.solid.settings.flatPitch === 1 && document.querySelector('[name="solid-flat-in"]').checked`), 'the URL sets the entry flatness');
  await c.waitFor('__mpm.solid.done', 900000);
  await painted();
  const res = await c.evaluate('JSON.parse(JSON.stringify(__mpm.solid.standResults.map((r) => ({ full: r.fullThickness, wave: r.entryWave && { kind: r.entryWave.shape.kind, height: 2 * r.entryWave.amplitude, pitch: r.entryWave.pitch }, force: r.steady?.force, phase: r.phase }))))');
  ok(res.length === 2 && res.every((r) => r.force > 0), 'both stands rolled to the end', res.map((r) => r.phase).join(' / '));
  ok(!res[0].full && res[0].wave === null, 'stand 1: the quarter model, a flat entry');
  ok(res[1].full && res[1].wave && res[1].wave.kind === 'edge', 'stand 2: the whole thickness, a wavy edge in', res[1].wave && `${res[1].wave.kind} ${(res[1].wave.height * 1e6).toFixed(2)} µm, pitch ${(res[1].wave.pitch * 1e3).toFixed(2)} mm`);
  ok(await c.evaluate('__mpm.solid.geometry.fullThickness && __mpm.solid.geometry.entryWave?.shape.kind === "edge"'), 'the shown geometry carries the wave');
  const tool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--stands', '2', '--handoff', 'steady', '--length', 'steady', '--crown', '40', '--flat-in', '--flat-latent', '--json'], { encoding: 'utf8' }));
  ok(tool.stands[1].fullThickness && tool.stands[1].entryWave, 'the tool solves stand 2 the same way');
  near(res[1].wave.height, tool.stands[1].entryWave.height_um * 1e-6, 1e-3, 'page = tool: the wave\'s height');
  near(res[0].force * 1e-3, tool.stands[0].steady.force_kN, 1e-5, 'page = tool: stand 1\'s force');
  near(res[1].force * 1e-3, tool.stands[1].steady.force_kN, 1e-2, 'page = tool: stand 2\'s force (1 %)');
  const row = await c.evaluate(`(() => { const cells = [...document.querySelectorAll('#solid-stand-results th, #solid-stand-results td')]; const i = cells.findIndex((e) => /入側の波/.test(e.textContent)); return cells.slice(i, i + 4).map((e) => e.textContent).join(' | '); })()`);
  ok(/耳波/.test(row) && /µm/.test(row), 'the stand table has the entry wave row', row);
  ok(/入側の波/.test(await c.evaluate(`document.getElementById('solid-results').textContent`)), 'the results have the row');
  ok(/入側の板は前のスタンドの平坦度の波/.test(await c.evaluate(`document.querySelector('#solid-legend .exag').textContent`)), 'the legend notes the wavy entry');
  ok(/flatin3=1/.test(await c.evaluate('__mpm.solid.url')) && /flatlatent3=1/.test(await c.evaluate('__mpm.solid.url')), 'the conditions URL carries the settings');
  await c.evaluate(`document.getElementById('solid-canvas').scrollIntoView({ block: 'start' })`);
  await shot('tandem');
  await c.navigate('about:blank');
} catch (e) {
  ok(false, `the browser check threw: ${e?.stack ?? e}`);
  try { await c?.navigate('about:blank'); } catch {}
}
done();
