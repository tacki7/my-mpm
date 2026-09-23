// The masthead's 「描画の更新」 select (src/app/frameRate.ts): the interval between the workers' frames, taken up by
// a run that is going, in the section, the plan view and the 3D model; kept in the browser across a reload.
//
//   CDP_PORT=<cdp> node tools/browser/frame-rate.mjs <url> [out-prefix]
//
// About 40 s. Counts the frames of 2 s at each setting through the real select (an 'input' + 'change' on it, as a
// click on an option would). Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, between, done } from '../checks/lib.mjs';

const [target, shots] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/frame-rate.mjs <url> [out-prefix]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;

/** frames counted over 2 s after choosing `ms` on the select (the run must be going) */
const COUNT = (counter) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = document.getElementById('frame-rate');
  const out = {};
  for (const ms of [33, 1000, 0]) {
    sel.value = String(ms);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(400);
    const a = ${counter};
    await wait(2000);
    out[ms] = ${counter} - a;
  }
  out.stored = localStorage.getItem('mpm-frame-ms');
  return out;
})()`;

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);

  // ── the section: a long enough run, the three settings in turn
  await c.navigate(page('/?autorun=1&cells=6&L=16'));
  await c.waitFor('__mpm.running', 60000);
  const sel = await c.evaluate('(() => { const s = document.getElementById("frame-rate"); return { options: [...s.options].map((o) => o.value), value: s.value, mpm: __mpm.frameMs }; })()');
  ok(sel.options.join(',') === '0,33,80,250,1000,5000' && sel.value === String(sel.mpm), 'the select lists the intervals and shows the choice', JSON.stringify(sel));
  const r2 = await c.evaluate(COUNT('__mpm.frames'));
  between(r2[33], 30, 80, `section: 33 ms gives about 60 frames in 2 s (${r2[33]})`);
  between(r2[1000], 1, 3, `section: 1000 ms gives about 2 frames in 2 s (${r2[1000]})`);
  between(r2[0], 30, 80, `section: 自動 is the worker's 33 ms again (${r2[0]})`);
  ok(r2.stored === '0', 'the choice is kept in the browser', r2.stored);
  ok(await c.evaluate('__mpm.running'), 'section: the run went on through the changes');

  // ── the 3D model: its own cadence is 80 ms
  await c.navigate(page('/?dim=3&W3=4&L3=12&cells3=4&autorun=1'));
  await c.waitFor('__mpm.solid.running', 60000);
  const r3 = await c.evaluate(COUNT('__mpm.solid.frames'));
  between(r3[33], 30, 80, `3D: 33 ms gives about 60 frames in 2 s (${r3[33]})`);
  between(r3[1000], 1, 3, `3D: 1000 ms gives about 2 frames in 2 s (${r3[1000]})`);
  between(r3[0], 14, 30, `3D: 自動 is the worker's 80 ms (${r3[0]})`);
  if (shots) await c.screenshot(`${shots}-3d.png`);

  // ── the plan view
  await c.navigate(page('/?view=plan&autorun=1&W=40&wcells=20'));
  await c.waitFor('__mpm.plan.running', 60000);
  const rp = await c.evaluate(COUNT('__mpm.plan.frames'));
  between(rp[33], 30, 80, `plan view: 33 ms gives about 60 frames in 2 s (${rp[33]})`);
  between(rp[1000], 1, 3, `plan view: 1000 ms gives about 2 frames in 2 s (${rp[1000]})`);

  // ── a reload keeps the choice, and a fresh worker gets it
  await c.evaluate('(() => { const s = document.getElementById("frame-rate"); s.value = "250"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await c.navigate(page('/?autorun=1&cells=6&L=16'));
  await c.waitFor('__mpm.running', 60000);
  const kept = await c.evaluate('(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await wait(400); const a = __mpm.frames; await wait(2000); return { value: document.getElementById("frame-rate").value, frames: __mpm.frames - a }; })()');
  ok(kept.value === '250', 'after a reload the select shows the kept choice', kept.value);
  between(kept.frames, 5, 12, `after a reload the new worker frames at 250 ms (${kept.frames} in 2 s)`);
  await c.evaluate('(() => { localStorage.removeItem("mpm-frame-ms"); })()');
  await c.navigate('about:blank');
} catch (err) {
  ok(false, 'the frame-rate check ran to the end', String(err?.message ?? err));
} finally {
  c?.close?.();
}
done();
