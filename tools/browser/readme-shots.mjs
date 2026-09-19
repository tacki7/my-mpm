// The README's pictures (docs/img/), taken in a headless Chrome: the page laid out at 1600 × 1000 and drawn by
// Chrome at 0.75, so 1200 × 750 with sharp text and under 300 KB (a 1600 px shot shrunk afterwards is blurrier and
// larger). Each scene waits for its signal (the stop step, a crack, the end of the pass), never a fixed time.
// Not a `@check`. About 5 minutes (the front tension and the three stands are most of it): run it under the CPU lock.
//
//   CDP_PORT=<cdp> node tools/browser/readme-shots.mjs <url> <out dir> [scene …]
//
// Scenes (all when none is named):
//   standard      σeq, the metal flow, η and a point picked past the exit (8 cells, 16 mm, stopped at step 20000 in the steady phase),
//                 then the rest of the pass: the results table's steady values and the friction hill's steady mean
//   front-tension the sheet necking and breaking near the head, just after the first crack (damage; the view
//                 moved there by a click on the overview strip's crack mark)
//   central-burst the cracks at mid-thickness (η)
//   plan          the plan view: the edge cracking as a band along the edge (Cockcroft-Latham 0.1, damage)
//   tandem        three stands: the slots, the stand table and the loading path coloured by stand
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './cdp.mjs';

const [target, dir, ...named] = process.argv.slice(2);
if (!target || !dir || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/readme-shots.mjs <url> <out dir> [scene …]');
  process.exit(64);
}
mkdirSync(dir, { recursive: true });
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

const c = await connect(process.env.CDP_PORT);
await c.setViewport(1600, 1000);
const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
const shot = async (name) => {
  await painted();
  await c.sleep(300);
  const f = join(dir, name);
  await c.screenshot(f, { x: 0, y: 0, width: 1600, height: 1000, scale: 0.75 });
  console.log(`shot  ${f}`);
};
const open = async (q) => {
  await c.navigate(page(q));
  await c.waitFor('window.__mpm?.ready', 30000);
  if (c.errors.length) throw new Error(`errors on ${q}: ${c.errors.join(' | ')}`);
};
const field = async (id) => {
  await c.evaluate(`__mpm.setField(${JSON.stringify(id)})`);
  await c.waitFor(`document.getElementById('legend')?.dataset.field === ${JSON.stringify(id)}`, 10000);
};
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
// pause once the run has passed `step` (the shared 一時停止 button), and wait until it has stopped
const pauseAfter = async (cond, timeout) => {
  await c.waitFor(cond, timeout);
  await c.evaluate(`document.getElementById('pause').click()`);
  await c.waitFor('!__mpm.running && !__mpm.pressing', 20000);
};

const scenes = {
  async standard() {
    await open('?preset=standard&cells=8&L=16&field=seq&autorun=1&stopafter=20000');
    await c.waitFor('__mpm.done', 300000);
    await c.waitFor('!__mpm.pressing', 10000);
    await shot('standard-seq.png');
    await field('lagrange');
    await shot('standard-metal-flow.png');
    await field('eta');
    await shot('standard-eta.png');
    // a point near the top surface past the exit: in a band across the picture at `frac` of the bite's width,
    // the second point from the top, clicked where it is the nearest by a pixel
    await field('ep');
    const pick = await c.evaluate(`(() => {
      const b = document.getElementById('bite').getBoundingClientRect();
      const x0 = b.x + ${process.env.PICK_X ?? 0.8} * b.width;
      const all = [];
      for (let id = 0; ; id++) { const s = __mpm.screenOf(id); if (!s) break; all.push({ id, ...s }); }
      const band = all.filter((s) => Math.abs(s.x - x0) < 3 && s.y > b.y && s.y < b.y + b.height).sort((a, b) => a.y - b.y);
      for (const s of band.slice(1)) {
        const x = Math.round(s.x), y = Math.round(s.y), d = Math.hypot(s.x - x, s.y - y);
        if (all.every((o) => o.id === s.id || Math.hypot(o.x - x, o.y - y) >= d + 1)) return { id: s.id, x, y };
      }
      return null;
    })()`);
    if (!pick) throw new Error('no point to pick past the exit');
    await click(pick.x, pick.y);
    await c.waitFor(`__mpm.explorer.role === 'selected' && __mpm.explorer.id === ${pick.id}`, 5000);
    await shot('standard-explorer.png');
    // the rest of the pass: the steady values stay in the table and the hill
    await field('seq');
    await c.evaluate(`document.getElementById('run').click()`); // 続ける
    await c.waitFor(`__mpm.diag.phase === 'done' && !__mpm.running`, 300000);
    await shot('standard-after-pass.png');
  },
  async 'front-tension'() {
    await open('?preset=front-tension&field=damage&autorun=1');
    await c.waitFor('__mpm.cracks.length > 0', 600000);
    const first = await c.evaluate('__mpm.cracks[0].step');
    await pauseAfter(`__mpm.diag.step >= ${first + 150}`, 300000);
    // the sheet breaks near the head, past the window: a real click on the overview strip's vermilion crack mark
    const mark = await c.evaluate(`(() => {
      const ov = document.getElementById('overview');
      const r = ov.getBoundingClientRect();
      const d = ov.getContext('2d').getImageData(0, 0, ov.width, ov.height).data;
      let sx = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 100 && d[i + 2] < 90 && d[i + 3] > 200) (sx += (i / 4) % ov.width), n++;
      return n ? { x: Math.round(r.left + ((sx / n) * r.width) / ov.width), y: Math.round(r.top + r.height / 2) } : null;
    })()`);
    if (!mark) throw new Error('no crack mark on the overview strip');
    await click(mark.x, mark.y);
    // the view is centred on the crack: a real wheel there zooms in on it
    const mid = await c.evaluate(`(() => { const b = document.getElementById('bite').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const z0 = await c.evaluate('__mpm.view.zoom');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 0, deltaY: -600 });
    await c.waitFor(`__mpm.view.zoom > ${z0} * 1.3`, 5000);
    await shot('front-tension-damage.png');
  },
  async 'central-burst'() {
    await open('?preset=central-burst&field=eta&autorun=1');
    await c.waitFor('__mpm.cracks.length > 0', 900000);
    const first = await c.evaluate('__mpm.cracks[0].step');
    await pauseAfter(`__mpm.diag.step >= ${first + 6000}`, 900000);
    await shot('central-burst-eta.png');
  },
  async plan() {
    await open(`?view=plan&W=20&wcells=20&L=16&damage=cockcroft-latham&cond=${b64({ damage: { clCrit: 0.1 } })}&pfield=damage&autorun=1`);
    await c.waitFor('__mpm.plan.cracks.length > 0', 300000);
    await pauseAfter('__mpm.plan.diag?.step >= 6000', 300000).catch(async () => {
      await c.waitFor('!__mpm.plan.running', 20000);
    });
    await c.waitFor('!__mpm.plan.running', 20000);
    await shot('plan-edge-crack.png');
  },
  async tandem() {
    await open('?stands=3&cells=6&L=8&field=seq&autorun=1');
    await c.waitFor('__mpm.done', 900000);
    await shot('tandem.png');
  },
};

let code = 0;
try {
  for (const name of named.length ? named : Object.keys(scenes)) {
    if (!scenes[name]) throw new Error(`no scene ${name}`);
    const t0 = Date.now();
    await scenes[name]();
    console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  if (c.errors.length) throw new Error(`page errors: ${c.errors.join(' | ')}`);
} catch (e) {
  console.error(String(e?.message ?? e));
  code = 1;
} finally {
  await c.navigate('about:blank').catch(() => {});
  c.close();
}
process.exit(code);
