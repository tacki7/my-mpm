// The 「2 次元」「3 次元」 tabs and the 3 次元 page, in a headless Chrome: the page opens on 2 次元 as before;
// a real click on 「3 次元」 shows the 3D page (the section, the plan view and their controls are gone, the panel
// has the 3D strip's settings and not the conditions the 3D model lacks); a 4 mm strip is rolled to the end and
// its steady values compared with `node tools/solid.mjs` (relative 1e-5: Chrome's and Node's V8 differ in the
// last bit of a few Math functions); the playback bar (巻き戻す, 再生, the slider, a field tab while paused); every field tab redraws; a real drag turns the drawing, the wheel zooms, a
// double click puts it back; the view buttons; the conditions URL opens the same 3D condition; back on 2 次元 the
// section still runs, and showing 3 次元 pauses it; a tandem of two stands (against the tool; the width, crown and
// flatness graphs draw both stands in their colours with legends; the handoff 'crop' from the panel); the stress state and the fracture locus (a standard strip: the
// most damaged point; a strip that cracks: the first crack's point, the role buttons by real clicks); a narrow
// screen (700 px). Not a `@check`. About 12 minutes.
//
//   CDP_PORT=<cdp> node tools/browser/solid.mjs <url> [out-prefix]
//
// Writes <out-prefix>-solid.png, -locus.png, -top.png, -cut.png, -narrow.png when a prefix is given; look at them.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/solid.mjs <url> [out-prefix]');
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
  const box = (sel) => c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const shot = async (name) => {
    if (!shots) return;
    await painted();
    await c.screenshot(`${shots}-${name}.png`);
    console.log(`shot  ${shots}-${name}.png`);
  };

  // ── the page opens on 2 次元, as it was
  await c.navigate(page('?cells=6&L=8'));
  await c.waitFor('window.__mpm?.ready', 30000);
  ok((await visible('#bite')) && !(await visible('#solid-canvas')) && (await visible('.view-switch')), 'the page opens on 2 次元: the roll bite and the 断面/平面図 switch, no 3D picture');
  ok(await c.evaluate(`document.getElementById('dim-tab-2').getAttribute('aria-selected') === 'true' && !__mpm.solid.active`), 'the 2 次元 tab is the selected one');

  // ── a real click on 3 次元
  await click('#dim-tab-3');
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  ok((await visible('#solid-canvas')) && !(await visible('#bite')) && !(await visible('#plan-canvas')) && !(await visible('.view-switch')), 'a click on 3 次元 shows the 3D picture; the section, the plan view and their switch are gone');
  ok((await visible('[name="solid-width"]')) && (await visible('[name="tb"]')) && (await visible('[name="tf"]')) && !(await visible('[name="L"]')) && (await visible('[name="stands"]')) && (await visible('[name="flatten"]')) && (await visible('[name="control"]')) && (await visible('[name="length"]')) && (await visible('[name="mu"]')), 'the panel has the 3D strip and the shared conditions (the stands, the rolls that follow the pass, the length steady, the tensions), not the section\'s length');
  ok(await c.evaluate(`document.getElementById('dim-tab-3').getAttribute('aria-selected') === 'true' && document.getElementById('dim-panel').getAttribute('aria-labelledby') === 'dim-tab-3'`), 'the 3 次元 tab is selected and names the panel');

  // ── roll a 4 mm strip to the end; the tool, same condition
  const W = 4;
  await c.navigate(page(`?dim=3&W3=${W}`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  const s = await c.evaluate('JSON.parse(JSON.stringify(__mpm.solid.diag.steady))');
  ok(s && s.looks > 0, 'the strip has steady looks', `${s?.looks}`);
  const tool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', String(W), '--L', '12', '--cells', '4', '--json'], { encoding: 'utf8' }));
  ok(tool.steady.looks === s.looks, 'page = tool: the same steady looks', `page ${s.looks}, tool ${tool.steady.looks}`);
  near(s.force * 1e-3, tool.steady.force_kN, 1e-5, `page = tool: roll force on the whole width [kN] (W ${W} mm, 4 cells, strip 12 mm)`);
  near(s.spread * 100, tool.steady.spread_percent, 1e-5, 'page = tool: spread W1/W0 − 1 [%]');
  near(2 * s.halfThickness[0] * 1e3, tool.steady.centreThickness_mm, 1e-5, 'page = tool: exit thickness at the mid-width [mm]');
  ok(s.spread > 0.03, 'the strip spreads', `${(s.spread * 100).toFixed(2)} %`);
  const table = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent)`);
  const row = table.find((t) => t.startsWith('圧延荷重')) ?? '';
  ok(row.includes((s.force * 1e-3).toFixed(2)), 'the results table shows the steady roll force', row);
  ok((table.find((t) => t.startsWith('幅広がり W1/W0')) ?? '').includes((s.spread * 100).toFixed(2)), 'and the spread');
  await shot('solid');

  // ── playback of the recorded frames (tape.ts): the bar appears once the run has stopped; 巻き戻す, 再生, 一時停止,
  // the slider, and a field tab while playing back; the end of the tape is the live frame
  const rp0 = await c.evaluate('JSON.parse(JSON.stringify({ n: __mpm.solid.replay.length, at: __mpm.solid.replay.at, hidden: document.getElementById("solid-replay").hidden, frames: __mpm.solid.frames }))');
  ok(!rp0.hidden && rp0.n >= 50 && rp0.n <= 400 && rp0.at === null && rp0.frames > rp0.n, 'the run recorded a tape of at most 400 frames and the playback bar is shown, on the live frame', `${rp0.n} kept of ${rp0.frames} frames`);
  await click('#solid-rewind');
  await painted();
  const rp1 = await c.evaluate('JSON.parse(JSON.stringify({ at: __mpm.solid.replay.at, step: __mpm.solid.frameShown.diag.step, phase: document.getElementById("solid-phase").textContent, clock: document.getElementById("clock").textContent, head: Math.max(...__mpm.solid.frameShown.faces[0].pos.filter((v, i) => i % 3 === 0 && !Number.isNaN(v))) }))');
  ok(rp1.at === 0 && rp1.step === 0 && rp1.phase.startsWith('再生 1 /') && rp1.clock.startsWith('t = 0.00 ms') && rp1.head < 0, '巻き戻す shows the first frame: step 0, the strip before the rolls, the clock and the status say so', `${rp1.phase}; ${rp1.clock}; head at ${(rp1.head * 1e3).toFixed(1)} mm`);
  await click('#solid-play');
  await c.waitFor('__mpm.solid.replay.playing && __mpm.solid.replay.at >= 12', 10000);
  await click('#solid-play');
  const rp2 = await c.evaluate('JSON.parse(JSON.stringify({ at: __mpm.solid.replay.at, playing: __mpm.solid.replay.playing, btn: document.getElementById("solid-play").textContent }))');
  await painted();
  await painted();
  const rp3 = await c.evaluate('__mpm.solid.replay.at');
  ok(!rp2.playing && rp2.at >= 12 && rp2.at < rp0.n - 1 && rp3 === rp2.at && rp2.btn === '再生', '再生 runs through the frames (about 12 a second) and the same button pauses it', `paused at ${rp2.at}, still ${rp3}`);
  await click('#solid-tabs button[data-field="ep"]');
  await c.waitFor(`document.getElementById('solid-legend').dataset.field === 'ep'`, 5000);
  ok(await c.evaluate('__mpm.solid.replay.at === ' + rp2.at), 'a field tab while paused recolours the frame on show without leaving it');
  await click('#solid-tabs button[data-field="seq"]');
  await c.waitFor(`document.getElementById('solid-legend').dataset.field === 'seq'`, 5000);
  // a real click at the right end of the slider: the last frame, which is the live one
  const sl = await c.evaluate(`(() => { const b = document.getElementById('solid-scrub').getBoundingClientRect(); return { x: b.right - 6, y: b.y + b.height / 2 }; })()`);
  await mouse('mousePressed', sl.x, sl.y);
  await mouse('mouseReleased', sl.x, sl.y);
  await painted();
  const rp4 = await c.evaluate('JSON.parse(JSON.stringify({ at: __mpm.solid.replay.at, same: __mpm.solid.frameShown.diag.step === __mpm.solid.diag.step, phase: document.getElementById("solid-phase").textContent, slider: +document.getElementById("solid-scrub").value, n: __mpm.solid.replay.length }))');
  ok(rp4.at === null && rp4.same && rp4.slider === rp4.n - 1 && rp4.phase === '圧延が終わった', 'the slider\'s end is the live frame: playback is left and the status is the run\'s', `${rp4.phase}, slider ${rp4.slider} / ${rp4.n - 1}`);
  ok(c.errors.length === 0, 'no exceptions in the playback', c.errors.join(' | '));

  // ── the tape as a video file: the real button, a real download, read back by ffprobe when it is at hand
  const dlDir = shots ? dirname(shots) : null;
  if (dlDir) await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  await c.evaluate(`(() => { const s = document.getElementById('solid-speed'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
  const nTape = await c.evaluate('__mpm.solid.replay.length');
  await click('#solid-video');
  await c.waitFor('__mpm.solid.videoBusy', 5000);
  await c.waitFor('!__mpm.solid.videoBusy', 120000);
  const vMsg = await c.evaluate(`document.getElementById('solid-replay-at').textContent`);
  const vName = /^(rolling-3d-seq-\d+frames\.(mp4|webm)) を保存した/.exec(vMsg)?.[1];
  ok(!!vName && vMsg.includes(`${nTape}frames`), 'a click on 動画に保存 writes the tape to a video file, one frame per recorded frame', vMsg);
  if (dlDir && vName) {
    const f = join(dlDir, vName);
    const t0 = Date.now();
    let size = -1;
    while (Date.now() - t0 < 20000) {
      const n = existsSync(f) ? statSync(f).size : 0;
      if (n > 0 && n === size) break;
      size = n;
      await c.sleep(200);
    }
    ok(existsSync(f) && statSync(f).size > 100000, 'the file is downloaded', `${f}: ${existsSync(f) ? statSync(f).size : 0} bytes`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', f], { encoding: 'utf8' });
    if (probe.status === 0) {
      const j = JSON.parse(probe.stdout);
      const s = j.streams[0];
      // ×2: the frames came every 80 ms (FRAME_MS), the video shows them every 40
      ok(['h264', 'vp9'].includes(s.codec_name) && s.width === 1280 && s.height % 2 === 0 && +s.nb_read_frames === nTape && Math.abs(+j.format.duration - nTape * 0.04) < 0.01 && probe.stderr === '', 'ffprobe decodes every frame: 1280 px wide, one per recorded frame, at ×2 (40 ms each)', `${s.codec_name} ${s.width}×${s.height}, ${s.nb_read_frames} frames, ${j.format.duration} s${probe.stderr ? `, ${probe.stderr.trim()}` : ''}`);
    } else console.log('SKIP  ffprobe not found: the video was not decoded');
  }
  await c.evaluate(`(() => { const s = document.getElementById('solid-speed'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);

  // ── the fracture locus and the stress state of the followed points (explorer.ts on the 3D page)
  const cell = (key) => c.evaluate(`(() => { const r = document.querySelector('#solid-explorer-state tr[data-key="${key}"]'); return r && { value: +r.dataset.value, text: (r.children[1] ?? r).textContent }; })()`);
  const shown = await c.evaluate('JSON.parse(JSON.stringify(__mpm.solid.explorer))');
  ok((await visible('#solid-explorer')) && (await visible('#solid-chart-locus')) && shown?.role === 'max-damage' && shown.path.length >= 30, 'the 3D page shows the stress state and the locus; with no crack, the most damaged point', `${shown?.role}, ${shown?.path.length / 3} samples`);
  ok(await c.evaluate(`document.querySelector('#solid-explorer button[data-role="first-crack"]').disabled && document.querySelector('#solid-explorer button[data-role="max-damage"]').getAttribute('aria-checked') === 'true' && !document.querySelector('#solid-explorer button[data-role="selected"]')`), 'the role buttons: no first crack to show, the most damaged one chosen, no point picking in 3D');
  const same = ['sxx', 'syy', 'szz', 'syz', 'szx', 'seq', 'pres', 's1', 'eta', 'ep', 'dJC'].map(async (k) => [k, (await cell(k))?.value, shown.state[k]]);
  const cells = await Promise.all(same);
  ok(cells.every(([, v, w]) => v === w) && (await cell('position'))?.text.includes('板幅の中央から'), 'the table is the followed point\'s state (six stress components, σ1, η, εp, D) and its position across the width', cells.filter(([, v, w]) => v !== w).map(([k, v, w]) => `${k}: ${v} vs ${w}`).join(', '));
  const inked = await c.evaluate(`(() => { const cv = document.querySelector('#solid-chart-locus'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n / (cv.width * cv.height); })()`);
  ok(inked > 0.02, 'the locus is drawn', `${(inked * 100).toFixed(1)} % of the canvas inked`);
  const legend = await c.evaluate(`document.querySelector('#solid-locus .locus-legend').textContent`);
  ok(/εf\(η\)/.test(legend) && /損傷最大/.test(legend) && /D·εf/.test(legend), 'its legend names the locus, the followed point and D·εf(η)', legend);

  // ── every field tab
  const tabs = await c.evaluate(`[...document.querySelectorAll('#solid-tabs button')].map((b) => b.dataset.field)`);
  for (const id of tabs) {
    await click(`#solid-tabs button[data-field="${id}"]`);
    await c.waitFor(`document.getElementById('solid-legend').dataset.field === ${JSON.stringify(id)}`, 10000);
  }
  ok(tabs.length === 10 && c.errors.length === 0, `every field tab redraws the strip (${tabs.join(', ')})`, c.errors.join(' | '));
  await click('#solid-whole');
  await painted();
  const ms = await c.evaluate('__mpm.solid.drawMs(10)');
  ok(ms < 30, 'a redraw of the whole strip under 30 ms', `${ms.toFixed(1)} ms`);

  // ── turning, zooming, putting back
  const at = await centre('#solid-canvas');
  const v0 = await c.evaluate('__mpm.solid.view');
  await mouse('mousePressed', at.x, at.y, { modifiers: 8 });
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', at.x + 20 * k, at.y + 8 * k, { buttons: 1, modifiers: 8 });
  await mouse('mouseReleased', at.x + 100, at.y + 40, { modifiers: 8 });
  const v1 = await c.evaluate('__mpm.solid.view');
  ok(v1.yaw < v0.yaw - 0.3 && v1.pitch > v0.pitch + 0.1 && v1.pan[0] === v0.pan[0] && v1.pan[1] === v0.pan[1], 'a Shift+drag to the right turns the drawing with the hand (yaw falls) without moving it', `yaw ${v0.yaw.toFixed(2)} → ${v1.yaw.toFixed(2)}, pitch ${v0.pitch.toFixed(2)} → ${v1.pitch.toFixed(2)}`);
  ok(await c.evaluate(`document.querySelectorAll('.look-from button[aria-checked="true"]').length === 0`), 'and no named direction is the current one then');
  // turning about the middle of the canvas: after a plain drag (a pan) the pivot moves to what is at the middle,
  // the picture itself does not move (the origin's projection is the same after a turn left and back), and while
  // the drawing turns the pivot's projection stays at the middle
  const size = await c.evaluate(`(() => { const cv = document.getElementById('solid-canvas'); const r = cv.getBoundingClientRect(); return { w: cv.width, h: cv.height, cssW: r.width * devicePixelRatio, cssH: r.height * devicePixelRatio }; })()`);
  ok(Math.abs(size.w - size.cssW) <= 1 && Math.abs(size.h - size.cssH) <= 1, "the canvas is drawn at its own size (it follows the charts' row under it growing)", `${size.w}×${size.h} px, CSS ${size.cssW.toFixed(0)}×${size.cssH.toFixed(0)}`);
  const mid = await c.evaluate(`(() => { const r = document.getElementById('solid-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 + 8 }; })()`);
  const origin = () => c.evaluate('__mpm.solid.screenOfPoint(0, 0, 0)');
  await mouse('mousePressed', at.x, at.y);
  for (let k = 1; k <= 4; k++) await mouse('mouseMoved', at.x + 20 * k, at.y + 8 * k, { buttons: 1 });
  await mouse('mouseReleased', at.x + 80, at.y + 32);
  await painted();
  const vp = await c.evaluate('__mpm.solid.view');
  const oPan = await origin();
  ok(vp.pan[0] === 80 && vp.pan[1] === 32 && vp.yaw === v1.yaw, 'a plain drag pans without turning', `pan ${vp.pan}, yaw ${vp.yaw.toFixed(2)} (was ${v1.yaw.toFixed(2)})`);
  const key = (k) => c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'ArrowLeft' ? 37 : 39 });
  await key('ArrowLeft');
  await painted();
  const vl = await c.evaluate('__mpm.solid.view');
  const pivotAt = await c.evaluate(`__mpm.solid.screenOfPoint(${vl.pivot.join(',')})`);
  const oLeft = await origin();
  ok(Math.abs(vl.yaw - vp.yaw - (5 * Math.PI) / 180) < 1e-12 && vl.pan[0] === 0 && vl.pan[1] === 0 && Math.hypot(vl.pivot[0] - vp.pivot[0], vl.pivot[1], vl.pivot[2]) > 1e-4,
    '← turns 5° about what is at the middle: the pan is folded into the pivot', `pivot ${vl.pivot.map((v) => (v * 1e3).toFixed(2))} mm (was ${vp.pivot.map((v) => (v * 1e3).toFixed(2))}), pan ${vl.pan}`);
  // (0.6 px: the canvas' size is rounded to whole px)
  ok(Math.hypot(pivotAt.x - mid.x, pivotAt.y - mid.y) < 0.6 && Math.hypot(oLeft.x - oPan.x, oLeft.y - oPan.y) > 1, 'the pivot is drawn at the middle of the canvas and the rest turned about it', `pivot at (${pivotAt.x.toFixed(1)}, ${pivotAt.y.toFixed(1)}), middle (${mid.x.toFixed(1)}, ${mid.y.toFixed(1)})`);
  await key('ArrowRight');
  await painted();
  const oBack = await origin();
  ok(Math.hypot(oBack.x - oPan.x, oBack.y - oPan.y) < 1e-6, '→ turns back: the picture is where the pan left it (moving the pivot did not move it)', `origin at (${oBack.x.toFixed(2)}, ${oBack.y.toFixed(2)}) vs (${oPan.x.toFixed(2)}, ${oPan.y.toFixed(2)})`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -400 });
  await painted();
  const v2 = await c.evaluate('__mpm.solid.view');
  ok(v2.zoom > v1.zoom * 1.3, 'the wheel zooms', `${v1.zoom.toFixed(2)} → ${v2.zoom.toFixed(2)}`);
  await mouse('mousePressed', at.x, at.y, { clickCount: 2 });
  await mouse('mouseReleased', at.x, at.y, { clickCount: 2 });
  const v3 = await c.evaluate('__mpm.solid.view');
  ok(v3.yaw === v0.yaw && v3.pitch === v0.pitch && v3.zoom === 1, 'a double click puts the drawing back');
  await click('.look-from button[data-look="top"]');
  const v4 = await c.evaluate('__mpm.solid.view');
  near(v4.pitch, Math.PI / 2, 1e-12, '「上から」 looks straight down');
  await shot('top');
  await click('.look-from button[data-look="oblique"]');
  await click('#solid-cut');
  await click('#solid-rolls');
  const v5 = await c.evaluate('__mpm.solid.view');
  ok(v5.cut && !v5.rolls, '「板幅の中央で切る」 and 「ロール」 toggle');
  await shot('cut');

  // ── the conditions URL
  const url = await c.evaluate('__mpm.solid.url');
  ok(/(^|&)dim=3(&|$)/.test(url) && url.includes(`W3=${W}`) && !/(^|&)L=/.test(url), 'the conditions URL has the tab and the 3D strip, not the section\'s length', url);
  await c.navigate(page(`?${url}&mu=0.1`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  const again = await c.evaluate('({ s: __mpm.solid.settings, mu: __mpm.solid.params.rolling.mu, L: __mpm.solid.params.rolling.sheetLength })');
  ok(Math.abs(again.s.width - W * 1e-3) < 1e-12 && again.mu === 0.1 && Math.abs(again.L - 12e-3) < 1e-12, 'it opens the 3 次元 tab with that strip; the shared conditions (μ) reach the 3D model');

  // ── a strip that cracks (4340's Johnson-Cook damage, D2 cut to 0.15, 30 %, W 2 mm): the first crack's point, by a real click
  const cond = Buffer.from(JSON.stringify({ damage: { D2: 0.15, etaCutoff: -2 } })).toString('base64url');
  await c.navigate(page(`?dim=3&W3=2&L3=8&mat=s4340&damage=johnson-cook&r=30&cond=${cond}`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  ok(await c.evaluate('__mpm.solid.params.damage.D2 === 0.15 && __mpm.solid.params.rolling.reduction === 0.3'), 'the cond reaches the 3D model (D2 0.15, 30 %)');
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  const crack = await c.evaluate('JSON.parse(JSON.stringify({ first: __mpm.solid.diag.firstCrack, n: __mpm.solid.diag.nFailed, shown: __mpm.solid.explorer, tracks: __mpm.solid.tracks.map((t) => t.role) }))');
  ok(crack.first && crack.n > 10 && crack.shown?.role === 'first-crack' && crack.shown.id === crack.first.point && crack.tracks.includes('max-damage'), 'the strip cracks and the first crack\'s point is shown, unasked', `${crack.n} failed, shown ${crack.shown?.role} ${crack.shown?.id} (crack's point ${crack.first?.point})`);
  const fail = await cell('failed');
  const atFail = await cell('atFailure');
  const end = crack.shown.path.slice(-3);
  ok(fail?.text === '亀裂' && atFail && Math.abs(atFail.value - crack.first.eta) < 1e-9 && Math.abs(end[0] - crack.first.eta) < 1e-9 && Math.abs(end[2] - 1) < 0.05, 'its table says 亀裂 with the state at failure; its path ends at the crack\'s η with D = 1', `η ${atFail?.value?.toFixed(3)} (crack ${crack.first?.eta.toFixed(3)}), D ${end[2]?.toFixed(3)}`);
  await click('#solid-explorer button[data-role="max-damage"]');
  await c.waitFor(`__mpm.solid.explorer.role === 'max-damage' && document.querySelector('#solid-explorer-state').dataset.role === 'max-damage'`, 5000);
  ok((await cell('failed'))?.text === '健全' && (await cell('dJC'))?.value > 0.5, 'a click on 損傷最大 shows an intact point with its damage', `D ${(await cell('dJC'))?.value?.toFixed(3)}`);
  await click('#solid-explorer button[data-role="first-crack"]');
  await c.waitFor(`__mpm.solid.explorer.role === 'first-crack'`, 5000);
  // the rings on the 3D picture: pixels of the ring's colour on a circle of its radius around the point's screen position
  // (the whole strip on show: at the end of the pass the head, where the first crack is, has left the bite's picture)
  await click('#solid-whole');
  await c.waitFor(`__mpm.solid.view.fit === 'strip'`, 5000);
  await painted();
  const ring = (role, rgb, radius) => c.evaluate(`(() => {
    const at = __mpm.solid.screenOf('${role}');
    if (!at) return null;
    const cv = document.getElementById('solid-canvas');
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let hit = 0;
    const N = 72;
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      const x = Math.round((at.x - r.left + ${radius} * Math.cos(a)) * k);
      const y = Math.round((at.y - r.top + ${radius} * Math.sin(a)) * k);
      const o = 4 * (y * cv.width + x);
      if (Math.abs(d[o] - ${rgb[0]}) < 40 && Math.abs(d[o + 1] - ${rgb[1]}) < 40 && Math.abs(d[o + 2] - ${rgb[2]}) < 40) hit++;
    }
    return { hit: hit / N, x: at.x - r.left, y: at.y - r.top, w: r.width, h: r.height };
  })()`);
  const red = await ring('first-crack', [0xc2, 0x3b, 0x22], 9);
  const brown = await ring('max-damage', [0x8d, 0x5a, 0x33], 7);
  ok(red && red.x > 0 && red.x < red.w && red.y > 0 && red.y < red.h && red.hit > 0.3 && red.hit < 0.85, 'a red dashed ring is drawn around the first crack on the 3D picture', red ? `${(red.hit * 100).toFixed(0)} % of the ring red at (${red.x.toFixed(0)}, ${red.y.toFixed(0)})` : 'no position');
  ok(brown && brown.hit > 0.15 && brown.hit < 0.85, 'and a brown dotted ring around the most damaged point', brown ? `${(brown.hit * 100).toFixed(0)} % of the ring brown` : 'no position');
  const keys = await c.evaluate(`document.querySelector('#solid-legend').textContent`);
  ok(/赤の点線の丸は最初の亀裂/.test(keys) && /茶の点線の丸は損傷/.test(keys), 'the legend names both rings');
  await shot('locus');
  ok(c.errors.length === 0, 'no exceptions so far', c.errors.join(' | '));

  // ── back on 2 次元 the section runs; showing 3 次元 pauses it
  await c.navigate(page('?cells=6&L=8&dim=3'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready && __mpm.ready', 60000);
  await click('#dim-tab-2');
  await c.waitFor('!__mpm.solid.active', 5000);
  ok((await visible('#bite')) && !(await visible('#solid-canvas')), 'a click on 2 次元 shows the roll bite again');
  await click('#run');
  await c.waitFor('__mpm.running && __mpm.frames > 3', 30000);
  await click('#dim-tab-3');
  await c.waitFor('__mpm.solid.active && !__mpm.running', 10000);
  await c.sleep(500); // the frames already on their way when the pause was sent
  const f0 = await c.evaluate('__mpm.frames');
  await c.sleep(600);
  const f1 = await c.evaluate('__mpm.frames');
  ok(f1 === f0, 'showing 3 次元 pauses the section\'s run', `${f0} → ${f1} frames`);
  ok(await c.evaluate(`document.getElementById('run').textContent === '圧延を始める' && !document.getElementById('run').disabled`), 'and the run button is the 3D model\'s');
  await click('#dim-tab-2');
  await c.waitFor('!__mpm.solid.active', 5000);
  ok(await c.evaluate(`document.getElementById('run').textContent === '続ける'`), 'back on 2 次元 the button continues the section');

  // ── a tandem, the length steady, rolls that follow the pass: set in the panel, run to the end, against the tool
  await c.setViewport(1600, 1000);
  await c.navigate(page('?dim=3&W3=2'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  const choose = (name, value) => c.evaluate(`(() => { const e = document.querySelector('[name="${name}"]'); e.value = '${value}'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('stands', '2');
  await choose('handoff', 'steady');
  await choose('length', 'steady');
  await choose('flatten', 'hitchcock');
  await choose('control', 'reduction');
  ok(await c.evaluate(`document.querySelector('[name="solid-length"]').disabled`), 'the length steady: the 3D length is not an input');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.stands === 2', 60000);
  const autoL = await c.evaluate(`({ shown: parseFloat(document.querySelector('[name="solid-length"]').value), L: __mpm.solid.geometry.sheetLength * 1e3, p: __mpm.solid.params.rolling })`);
  ok(Math.abs(autoL.shown - autoL.L) < 0.051 && autoL.L > 20 && autoL.p.flattening === 'hitchcock' && autoL.p.gapControl === 'reduction', 'the field shows the length worked out (longer for the rolls to settle)', `${autoL.shown} mm`);
  await click('#run');
  await c.waitFor('__mpm.solid.stand === 1 && __mpm.solid.diag.phase === "bite"', 600000);
  await painted();
  await shot('tandem-mid');
  ok(await c.evaluate(`!document.getElementById('solid-stand-section').hidden && document.querySelectorAll('#solid-stand-results thead th').length === 2 && document.querySelector('#solid-stand-results thead th.current').textContent === '#2'`), 'the stands\' table: two columns, #2 the running one');
  await c.waitFor('__mpm.solid.done', 900000);
  await painted();
  await shot('tandem-end');
  const res = await c.evaluate('__mpm.solid.standResults');
  const tandemTool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--length', 'steady', '--stands', '2', '--handoff', 'steady', '--flatten', 'hitchcock', '--control', 'reduction', '--json'], { encoding: 'utf8' }));
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  const t1 = tandemTool.stands[0];
  ok(res.length === 2 && res[0].phase === 'steady' && res[0].rollsSettled && res[1].rollsSettled, 'both stands ran, #1 handed on while steady, the rolls settled');
  ok(rel(res[0].steady.force * 1e-3, t1.steady.force_kN) < 1e-5 && rel(res[0].rollRadius * 1e3, t1.rollRadius_mm) < 1e-5 && rel(res[0].thicknessOut * 1e3, t1.thicknessOut_mm) < 1e-5, "page = tool, #1: force, R', the strip that came out (1e-5)", `${(res[0].steady.force * 1e-3).toFixed(4)} kN, R' ${(res[0].rollRadius * 1e3).toFixed(2)} mm`);
  // #2 starts from #1's strip, where the last bit of exp and log (Chrome's V8 against Node's) has grown
  const t2 = tandemTool.stands[1];
  ok(rel(res[1].steady.force * 1e-3, t2.steady.force_kN) < 0.01 && rel(res[1].thicknessOut * 1e3, t2.thicknessOut_mm) < 1e-3, 'page = tool, #2: force within 1 %, the strip within 0.1 %', `${(res[1].steady.force * 1e-3).toFixed(4)} against ${t2.steady.force_kN.toFixed(4)} kN`);
  const target2 = res[1].h0 * 0.75;
  ok(rel(res[0].thicknessOut, 0.75e-3) < 2e-3 && rel(res[1].thicknessOut, target2) < 2e-3, 'a constant reduction: each stand\'s strip comes out at 75 % of what came in', `${(res[0].thicknessOut * 1e3).toFixed(4)}, ${(res[1].thicknessOut * 1e3).toFixed(4)} mm`);
  const tUrl = await c.evaluate('__mpm.solid.url');
  ok(/stands=2/.test(tUrl) && /handoff=steady/.test(tUrl) && /length=steady/.test(tUrl) && /flatten=hitchcock/.test(tUrl) && /control=reduction/.test(tUrl) && /dim=3/.test(tUrl), 'the conditions URL carries the tandem and the rolls', tUrl);
  // the width, crown and flatness graphs: both stands one over the other, each in its stand's colour, with a legend
  const over = await c.evaluate(`(() => {
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const cols = ['#4b5a68', '#387262'].map(hex);
    const count = (id) => {
      const cv = document.getElementById(id);
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const n = [0, 0];
      for (let i = 0; i < d.length; i += 4) cols.forEach((c, k) => { if (Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) < 24) n[k]++; });
      return n;
    };
    const legend = (id) => [...document.getElementById(id).parentElement.querySelectorAll('.chart-legend .item')].map((e) => e.textContent);
    return { overlaid: __mpm.solid.overlaid, px: ['solid-chart-width', 'solid-chart-crown', 'solid-chart-flat'].map(count), legends: ['solid-chart-width', 'solid-chart-crown', 'solid-chart-flat'].map(legend) };
  })()`);
  ok(JSON.stringify(over.overlaid) === '[0,1]', 'the width graphs draw both stands', JSON.stringify(over.overlaid));
  ok(over.px.every(([a, b]) => a > 30 && b > 30), '  … each in its stand\'s colour (pixels of #1\'s and #2\'s colours on the load, crown and flatness graphs)', JSON.stringify(over.px));
  ok(over.legends.every((l) => l.includes('#1') && l.includes('#2')) && over.legends[1][0] === '入側（#1）', '  … with a legend under each (the crown\'s with the entry)', JSON.stringify(over.legends));

  // ── the handoff 'crop' from the panel: the 3D model's params and the URL
  await c.navigate(page('?dim=3&W3=2'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await choose('stands', '2');
  await choose('handoff', 'crop');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.stands === 2', 60000);
  ok((await c.evaluate('__mpm.solid.params.rolling.handoff')) === 'crop' && /handoff=crop/.test(await c.evaluate('__mpm.solid.url')), "the handoff 'crop' chosen in the panel is the 3D model's, and the URL carries it");

  // ── the tensions: set in the panel, reach the 3D model, show in the results and the URL
  await c.navigate(page('?dim=3&W3=2'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await choose('tb', '60');
  await choose('tf', '40');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.params.rolling.backTension === 60e6', 60000);
  const tp = await c.evaluate('__mpm.solid.params.rolling');
  ok(tp.backTension === 60e6 && tp.frontTension === 40e6, 'the tensions typed in the panel are the 3D model\'s', `${tp.backTension * 1e-6} / ${tp.frontTension * 1e-6} MPa`);
  ok(/tb=60/.test(await c.evaluate('__mpm.solid.url')) && /tf=40/.test(await c.evaluate('__mpm.solid.url')), 'and the conditions URL carries them');
  await click('#run');
  await c.waitFor('__mpm.solid.diag.phase === "steady"', 600000);
  await c.waitFor('__mpm.solid.done', 600000);
  const td = await c.evaluate('__mpm.solid.diag');
  const trow = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent).filter((t) => /張力/.test(t))`);
  ok(td.backTension === 0 && Math.abs(td.frontTension - 40e6) < 1 && trow.length === 2 && /後方張力.*0 \/ 60MPa/.test(trow[0]) && /前方張力.*40 \/ 40MPa/.test(trow[1]), 'at the end the front tension is on and the back one let go (the tail is past the rolls); the results say so', `${td.backTension * 1e-6} / ${td.frontTension * 1e-6} MPa, rows ${JSON.stringify(trow)}`);
  const tension0 = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--json'], { encoding: 'utf8' }));
  ok(td.steady && td.steady.force < 0.98 * tension0.steady.force_kN * 1e3, 'the tensions lower the steady force by more than 2 %', `${(td.steady?.force * 1e-3).toFixed(2)} vs ${tension0.steady.force_kN.toFixed(2)} kN without`);

  // ── the roll's bending: the panel's rows, their locks and ranges, the settings reach the model and the URL, the results
  await c.navigate(page('?dim=3&W3=2&R=10'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  const bendState = () => c.evaluate(`(() => { const q = (n) => document.querySelector('[name="' + n + '"]'); return { on: q('solid-bend').checked, support: q('solid-support').disabled, barrel: q('solid-barrel').disabled, span: q('solid-span').disabled, spanOff: q('solid-span').closest('label').classList.contains('off'), badSpan: q('solid-span').closest('label').classList.contains('bad'), badBarrel: q('solid-barrel').closest('label').classList.contains('bad') }; })()`);
  let bs = await bendState();
  ok(!bs.on && bs.support && bs.barrel && bs.span && bs.spanOff, 'a rigid roll to begin with: the bending\'s inputs are off', JSON.stringify(bs));
  await click('[name="solid-bend"]');
  bs = await bendState();
  ok(bs.on && !bs.support && !bs.barrel && bs.span && bs.spanOff, 'ticking it frees the supports and the barrel; the span stays off with the supports at the barrel\'s ends', JSON.stringify(bs));
  await choose('solid-barrel', '1');
  bs = await bendState();
  ok(bs.badBarrel, 'a barrel shorter than the strip (2 mm) is flagged');
  await choose('solid-barrel', '60');
  await choose('solid-support', 'bearing');
  await choose('solid-span', '30');
  bs = await bendState();
  ok(!bs.badBarrel && !bs.span && !bs.spanOff && bs.badSpan, 'with bearings the span opens; one shorter than the barrel is flagged', JSON.stringify(bs));
  await choose('solid-span', '80');
  ok(!(await bendState()).badSpan, 'a span beyond the barrel is fine');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.settings.bend && __mpm.solid.settings.barrel === 0.06', 60000);
  const bp = await c.evaluate('__mpm.solid.settings');
  ok(bp.support === 'bearing' && Math.abs(bp.span - 0.08) < 1e-12, 'the barrel and the span typed in the panel are the run\'s settings', JSON.stringify(bp));
  const bUrl = await c.evaluate('__mpm.solid.url');
  ok(/bend3=1/.test(bUrl) && /barrel3=60/.test(bUrl) && /support3=bearing/.test(bUrl) && /span3=80/.test(bUrl) && /R=10/.test(bUrl), 'the conditions URL carries the bending', bUrl);
  await click('#run');
  await c.waitFor('__mpm.solid.diag.phase === "steady"', 600000);
  await c.waitFor('__mpm.solid.done', 600000);
  const bd = await c.evaluate('__mpm.solid.diag');
  const brow = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent).filter((t) => /撓み|クラウン 2/.test(t))`);
  ok(bd.steady?.rollBend && bd.steady.rollBend.centre > bd.steady.rollBend.edge && bd.steady.rollBend.edge > 2e-6, 'the roll bent away from the strip, more at the mid-width than at the edge', `${(bd.steady?.rollBend?.centre * 1e6).toFixed(3)} / ${(bd.steady?.rollBend?.edge * 1e6).toFixed(3)} µm`);
  ok(brow.length === 3 && /板幅の中央.*µm/.test(brow[0]) && /板の端.*µm/.test(brow[1]) && /クラウン.*µm/.test(brow[2]) && new RegExp((bd.steady?.rollBend?.centre * 1e6).toFixed(2)).test(brow[0]), 'the results show the deflection at the mid-width and the edge and the crown, in µm, the steady means', JSON.stringify(brow));
  const bendTool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--R', '10', '--bend', '60', '--span', '80', '--json'], { encoding: 'utf8' }));
  ok(rel(bd.steady.force * 1e-3, bendTool.steady.force_kN) < 1e-5 && rel(bd.steady.rollBend.centre * 1e6, bendTool.steady.rollBend_um.centre) < 1e-5, 'page = tool: the steady force and the deflection (1e-5)', `${(bd.steady.force * 1e-3).toFixed(4)} kN, ${(bd.steady.rollBend.centre * 1e6).toFixed(4)} µm`);
  await c.navigate(page(`?${bUrl}`));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  bs = await bendState();
  const bset = await c.evaluate('__mpm.solid.settings');
  ok(bs.on && !bs.span && bset.bend && bset.support === 'bearing' && Math.abs(bset.barrel - 0.06) < 1e-12 && Math.abs(bset.span - 0.08) < 1e-12, 'the URL opened again gives the same bending settings', JSON.stringify(bset));
  await shot('bend');

  // ── the entry crown and the flatness: the panel, the model, the results, the two graphs; the boundary under the drawing
  await c.navigate(page('?dim=3&W3=2&R=10'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await choose('solid-crown', '40');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.settings.crown > 39e-6 && __mpm.solid.geometry && __mpm.solid.geometry.crownIn > 39e-6', 60000);
  const cUrl = await c.evaluate('__mpm.solid.url');
  ok(/crown3=40/.test(cUrl), 'the entry crown typed in the panel reaches the model and the conditions URL', cUrl);
  const chartBlank = (id) => c.evaluate(`(() => { const cv = document.getElementById('${id}'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`);
  await painted();
  const blank0 = await chartBlank('solid-chart-flat');
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  const cd = await c.evaluate('__mpm.solid.diag');
  const crow = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent).filter((t) => /クラウン|平坦度/.test(t))`);
  const crownTool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--R', '10', '--crown', '40', '--json'], { encoding: 'utf8' }));
  ok(cd.steady && Math.abs(cd.steady.crownIn - 40e-6) < 1e-12 && Math.abs(cd.steady.crownOut) < 4e-6 && rel(cd.steady.force * 1e-3, crownTool.steady.force_kN) < 1e-5, 'the crowned strip comes out flat between rigid rolls (|crown| < 4 µm); page = tool (1e-5)', `crown out ${(cd.steady?.crownOut * 1e6).toFixed(2)} µm, ${(cd.steady?.force * 1e-3).toFixed(4)} vs ${crownTool.steady.force_kN.toFixed(4)} kN`);
  const fl = cd.steady?.flatness ?? [];
  const flMean = fl.reduce((a, b) => a + b, 0) / fl.length;
  ok(fl.length === (await c.evaluate('__mpm.solid.geometry.lattice[2]')), 'the flatness has a value per lattice column', `${fl.length}`);
  ok(fl.every(Number.isFinite) && Math.abs(flMean) < 1e-6 && Math.abs(cd.steady.flatness[0] - crownTool.steady.flatness_I[0]) < 0.2, 'the flatness is finite, centred on its mean, and the page\'s equals the tool\'s (0.2 I-unit: the tool rounds to 0.1)', `${fl.map((v) => v.toFixed(1)).join(' ')} vs the tool's ${crownTool.steady.flatness_I[0]}`);
  ok(crow.length === 3 && /入側の板クラウン40\.0µm/.test(crow[0]) && /出側の板クラウン.*µm/.test(crow[1]) && /平坦度（中央 − 端）-?\d+I 単位/.test(crow[2]), 'the results show the crowns and the flatness', JSON.stringify(crow));
  const blank1 = await chartBlank('solid-chart-flat');
  const blankC = await chartBlank('solid-chart-crown');
  ok(blank1 > blank0 + 300 && blankC > 0, 'the crown and the flatness graphs are drawn once steady', `${blank0} → ${blank1} painted pixels, crown ${blankC}`);
  // the boundary under the drawing: a real drag up makes the graphs taller, double click puts it back
  const h0 = (await box('#solid-chart-flat')).h;
  const split = await box('.solid-stage .splitter');
  ok(split && split.h > 0 && split.w > 200, 'the boundary between the drawing and the graphs is there', JSON.stringify(split));
  await mouse('mouseMoved', split.x + split.w / 2, split.y + split.h / 2);
  await mouse('mousePressed', split.x + split.w / 2, split.y + split.h / 2, { buttons: 1 });
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', split.x + split.w / 2, split.y + split.h / 2 - 16 * k, { buttons: 1 });
  await mouse('mouseReleased', split.x + split.w / 2, split.y + split.h / 2 - 80, { buttons: 0 });
  await painted();
  const h1 = (await box('#solid-chart-flat')).h;
  const varH = await c.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--chart-h3').trim()`);
  ok(Math.abs(h1 - (h0 + 80)) < 3 && varH === `${Math.round(h0 + 80)}px`, 'dragging the boundary up 80 px makes the graphs 80 px taller (--chart-h3)', `${h0} → ${h1}, ${varH}`);
  const drawnAfter = await chartBlank('solid-chart-flat');
  ok(drawnAfter > blank1, 'the graphs are redrawn at the new size', `${blank1} → ${drawnAfter} painted pixels`);
  await c.evaluate(`document.querySelector('.solid-stage .splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await painted();
  const h2 = (await box('#solid-chart-flat')).h;
  ok(Math.abs(h2 - h0) < 3, 'a double click puts the graphs back to their default height', `${h2} vs ${h0}`);
  await shot('crown');

  // ── the whole thickness (both rolls): the checkbox, the URL, the model, the bottom face, the results; page = tool
  await c.navigate(page('?dim=3&W3=2'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await click('[name="solid-full"]');
  await click('#reset');
  await c.waitFor('__mpm.solid.ready && __mpm.solid.settings.full === true && __mpm.solid.geometry && __mpm.solid.geometry.fullThickness === true', 60000);
  const fUrl = await c.evaluate('__mpm.solid.url');
  ok(/full3=1/.test(fUrl), 'the checkbox reaches the model and the conditions URL (full3=1)', fUrl);
  const fGeo = await c.evaluate('__mpm.solid.geometry');
  const qGeo = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--json'], { encoding: 'utf8' }));
  ok(fGeo.lattice[1] === 8 && fGeo.n === 2 * qGeo.points, 'twice the lattice rows and points of the quarter model', `${fGeo.lattice.join(' × ')}, ${fGeo.n} vs ${qGeo.points}`);
  await click('#run');
  await c.waitFor('__mpm.solid.done', 600000);
  await painted();
  const fd = await c.evaluate('__mpm.solid.diag');
  const fullTool = JSON.parse(execFileSync('node', ['tools/solid.mjs', '--W', '2', '--cells', '4', '--full', '--json'], { encoding: 'utf8' }));
  ok(fd.steady && rel(fd.steady.force * 1e-3, fullTool.steady.force_kN) < 1e-5, 'the steady force of the page equals the tool\'s --full (1e-5)', `${(fd.steady?.force * 1e-3).toFixed(4)} vs ${fullTool.steady.force_kN.toFixed(4)} kN`);
  ok(rel(fullTool.steady.force_kN, qGeo.steady.force_kN) < 1e-9 && rel(fullTool.steady.centreThickness_mm, qGeo.steady.centreThickness_mm) < 1e-9, 'the whole thickness gives the quarter model\'s force and thickness (symmetric conditions, 1e-9)', `${fullTool.steady.force_kN} vs ${qGeo.steady.force_kN} kN`);
  const fFaces = await c.evaluate('__mpm.solid.frameShown.faces.map((f) => f.name)');
  ok(fFaces.includes('bottom'), 'the frame carries the bottom face', fFaces.join(','));
  const fRow = await c.evaluate(`[...document.querySelectorAll('#solid-results tr')].map((r) => r.textContent).find((t) => /粒子数/.test(t))`);
  ok(/1\/2 モデル/.test(fRow) && new RegExp(fGeo.n.toLocaleString()).test(fRow), 'the results say 1/2 model with the point count', fRow);
  // the picture: a point under the mid-plane projects below one above it (the picture is not the top half mirrored: the bottom face is its own)
  const under = await c.evaluate(`(() => ({ under: __mpm.solid.screenOfPoint(-0.004, -0.0004, 0), over: __mpm.solid.screenOfPoint(-0.004, 0.0004, 0) }))()`);
  ok(under.under && under.over && under.under.y > under.over.y, 'a point below the mid-plane projects under one above it', JSON.stringify(under));
  await shot('full');

  // ── a narrow screen
  await c.setViewport(700, 1000);
  await c.navigate(page('?dim=3'));
  await c.waitFor('__mpm.solid.active && __mpm.solid.ready', 60000);
  await painted();
  const narrow = await c.evaluate(`({ canvas: document.getElementById('solid-canvas').getBoundingClientRect().height, over: document.documentElement.scrollWidth - innerWidth, tabs: document.getElementById('dim-tabs').getBoundingClientRect().width })`);
  ok(narrow.canvas >= 300 && narrow.over <= 0 && narrow.tabs > 200, '700 px: the 3D picture and the tabs fit, no sideways scroll', JSON.stringify(narrow));
  await shot('narrow');

  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
  await c.navigate('about:blank');
} finally {
  c?.close();
}
done();
