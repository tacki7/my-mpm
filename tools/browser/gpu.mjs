// The 3D model's GPU step (src/mpm/solid/gpu) against the CPU's, in a headless Chrome with WebGPU
// (tools/browser/browser.sh start with BROWSER_GPU=1; a Chrome without an adapter makes this a SKIP, not a
// FAIL: the CI's runners have no GPU, so this is not a `@check`):
// - tools/gpu/check.html: the same state stepped once on each side, field by field; a batch of steps the same
//   way; whole passes to steady for each condition (plain, tensions, whole thickness, adjusted rolls, bending, damage), the
//   steady means compared within the tolerances docs/validation.md「GPU」records
// - the app: a pass on the GPU (`gpu3=1`) reports the GPU, gives the CPU's force, and is faster; the conditions
//   URL keeps the choice; the note under the select
//
//   BROWSER_GPU=1 tools/browser/browser.sh start <cdp> <dir>
//   CDP_PORT=<cdp> node tools/browser/gpu.mjs <url> [out-prefix] [--timeout 600000] [--quick]
//
// Writes <out-prefix>-app.png when a prefix is given; look at it. `--quick` leaves the app's passes out
// (the page's checks alone, about a minute). Prints one PASS / FAIL line per item and exits 1 if any failed.
import { connect } from './cdp.mjs';
import { ok, near, between, done } from '../checks/lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const timeout = +opt('timeout', 600000);
const quick = flag('quick');
const [target, shots] = argv;
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/gpu.mjs <url> [out-prefix] [--timeout ms] [--quick]');
  process.exit(64);
}
const page = (query) => new URL(query, target).href;
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(3)} %`;

// the fields' one-step agreement: f32 against f64 (pres is a small difference of large stresses; eta is p / seq and
// blows up where seq is near zero, so it is not compared). Over a batch of 19 steps the differences grow through
// the contact (a point at the edge of the bite touches on one side only: touch, a 0 / 1 field, is left out there)
const ONE = { default: 1e-4, pres: 5e-3, eta: null };
const BATCH = { default: 0.2, pres: 0.2, eta: null, touch: null };

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  await c.navigate(page('/tools/gpu/check.html'));
  await c.waitFor('window.__ready === true', 30000);
  const info = await c.evaluate('__gpucheck.gpu()');
  if (!info) {
    console.log('SKIP  no WebGPU adapter in this Chrome (start it with BROWSER_GPU=1 on a machine with a GPU)');
    process.exit(0);
  }
  console.log(`adapter: ${info.vendor} ${info.architecture} ${info.device} ${info.backend}`.trim());
  const pool = await c.evaluate('__gpucheck.pool()');
  ok(pool.length >= 1 && pool.some((p) => p.vendor === info.vendor && p.architecture === info.architecture), 'the pool holds the adapter the app uses', pool.map((p) => `${p.vendor} ${p.architecture} ${p.device}`.trim()).join(' | '));

  // ── in sync: one step, then a batch, from the same state (a plain pass, the bending and the whole thickness: the extra kernel paths)
  for (const v of ['plain', 'bend', 'full']) {
    const r = await c.evaluate(`__gpucheck.sync(${JSON.stringify(v)}, 2, 4, 1600)`);
    for (const [label, tol, diff] of [
      ['one step', ONE, r.one],
      ['a batch', BATCH, r.batch],
    ]) {
      let worst = { name: '', err: 0 };
      let bad = [];
      for (const [name, err] of Object.entries(diff)) {
        if (name.includes(':') || name.endsWith('@')) continue;
        const t = name in tol ? tol[name] : tol.default;
        if (t === null) continue;
        if (err > worst.err) worst = { name, err };
        if (!(err <= t)) bad.push(`${name} ${err.toExponential(2)} > ${t}`);
      }
      ok(bad.length === 0, `${v}: ${label} from the same state, every field within its tolerance`, bad.length ? bad.join(', ') : `worst ${worst.name} ${worst.err.toExponential(2)}`);
    }
  }

  // ── whole passes to steady on each side
  const pass = async (v, W, extra = '') => c.evaluate(`__gpucheck.passes(${JSON.stringify(v)}, ${W}, 4${extra})`);
  const both = (r, what) => ok(r.cpu && r.gpu, `${r.variant}: both sides reach steady`, `${r.cpuSteps} / ${r.gpuSteps} steps, ${(r.cpuMs / r.cpuSteps).toFixed(2)} / ${(r.gpuMs / r.gpuSteps).toFixed(2)} ms/step${what ? ', ' + what : ''}`);
  const rigid = (r) => {
    both(r);
    if (!r.cpu || !r.gpu) return;
    near(r.gpu.force, r.cpu.force, 5e-3, `${r.variant}: the steady force within 0.5 %`);
    near(r.gpu.halfThickness[0], r.cpu.halfThickness[0], 2e-3, `${r.variant}: the exit thickness at the mid-width within 0.2 %`);
    near(r.gpu.spread, r.cpu.spread, 1e-2, `${r.variant}: the spread within 1 %`);
    ok(r.gpuMs < r.cpuMs, `${r.variant}: the GPU's pass is faster`, `${(r.cpuMs / r.gpuMs).toFixed(2)}×`);
  };
  const plain = await pass('plain', 2);
  rigid(plain);
  const tension = await pass('tension', 2);
  rigid(tension);
  {
    // the whole thickness with both rolls: the same steady as the quarter (the conditions are symmetric)
    const r = await pass('full', 2);
    rigid(r);
    if (r.cpu && plain.cpu) near(r.cpu.force, plain.cpu.force, 1e-6, 'full: the CPU pass agrees with the quarter model');
  }
  {
    // two passes at once round the pool (one device here: both on it; two: one each), the same steady means
    const all = await c.evaluate('__gpucheck.passesAll(["plain", "tension"], 2, 4)');
    ok(all.length === 2 && all[0].gpu && all[1].gpu, 'pool: two passes at once both reach steady', `${all[0].gpuSteps} / ${all[1].gpuSteps} steps`);
    if (all[0].gpu && plain.gpu) near(all[0].gpu.force, plain.gpu.force, 5e-3, 'pool: plain, the steady force within 0.5 % of the pass alone');
    if (all[1].gpu && tension.gpu) near(all[1].gpu.force, tension.gpu.force, 5e-3, 'pool: tension, the steady force within 0.5 % of the pass alone');
  }
  {
    const r = await pass('bend', 2);
    rigid(r);
    if (r.cpu?.rollBend && r.gpu?.rollBend) near(r.gpu.rollBend.centre, r.cpu.rollBend.centre, 1e-2, `bend: the roll's deflection at the mid-width within 1 %`);
    else ok(false, 'bend: both sides report the deflection');
  }
  {
    // the adjusted rolls: the control's tolerance window (±0.05 % on the gauge) lets the two sides settle on
    // different edges of it, and the GPU's strip is 0.06 % wider: the force differs by up to 1.5 %
    const r = await pass('adjust', 2);
    both(r, `gap ${(r.cpuEnd.gap * 1e6).toFixed(2)} / ${(r.gpuEnd.gap * 1e6).toFixed(2)} µm, R ${(r.cpuEnd.R * 1e3).toFixed(2)} / ${(r.gpuEnd.R * 1e3).toFixed(2)} mm`);
    if (r.cpu && r.gpu) {
      ok(r.cpuEnd.settled && r.gpuEnd.settled, 'adjust: both sides settle the rolls');
      near(r.gpu.force, r.cpu.force, 2e-2, 'adjust: the steady force within 2 %');
      near(r.gpuEnd.gap, r.cpuEnd.gap, 5e-3, 'adjust: the settled gap within 0.5 %');
      near(r.gpuEnd.R, r.cpuEnd.R, 5e-3, 'adjust: the flattened radius within 0.5 %');
      near(r.gpu.halfThickness[0], r.cpu.halfThickness[0], 5e-3, 'adjust: the exit thickness at the mid-width within 0.5 %');
    }
  }
  {
    const r = await pass('damage', 2, ', 0.05');
    both(r, `first crack at step ${r.cpuCrack} / ${r.gpuCrack}, ${r.cpuFailed} / ${r.gpuFailed} failed`);
    ok(r.cpuCrack !== null && r.gpuCrack !== null, 'damage: a crack on both sides');
    if (r.cpuCrack !== null && r.gpuCrack !== null) {
      between(r.gpuCrack - r.cpuCrack, -50, 50, 'damage: the first crack within 50 steps');
      near(r.gpuFailed, r.cpuFailed, 5e-2, 'damage: the failed points within 5 %');
    }
  }

  // ── the app: the same pass on the GPU and on the CPU
  if (!quick) {
    const q = '?dim=3&W3=4&L3=12&cells3=4&autorun=1';
    await c.navigate(page(q + '&gpu3=1'));
    await c.waitFor('__mpm?.solid?.ready', 60000);
    const early = await c.evaluate('(() => ({ note: document.querySelector(".compute-note")?.textContent ?? "", hidden: document.querySelector(".compute-note")?.hidden, select: document.querySelector("[name=solid-compute]").value, disabled: document.querySelector("[name=solid-compute]").disabled }))()');
    ok(early.select === 'gpu' && !early.disabled, 'app: gpu3=1 selects the GPU, the select is on', JSON.stringify(early));
    ok(!early.hidden && early.note.startsWith('GPU で計算する'), 'app: the note under the select names the GPU', early.note);
    await c.waitFor('__mpm.solid.done', timeout);
    const g = await c.evaluate('(() => { const s = __mpm.solid; return { compute: s.compute, force: s.diag.steady?.force ?? null, spread: s.diag.steady?.spread ?? null, ms: s.frameShown?.msPerStep ?? null, url: s.url, row: [...document.querySelectorAll("#solid-results tr")].map((r) => r.textContent).find((t) => t.startsWith("計算")) ?? "", frames: s.frames }; })()');
    ok(g.compute?.compute === 'gpu' && g.compute.gpu && g.compute.note === null, 'app: the pass ran on the GPU', JSON.stringify(g.compute));
    ok(g.force !== null, 'app: the GPU pass reaches steady', `${g.force} N`);
    ok(/^計算GPU（/.test(g.row), 'app: the results table names the GPU', g.row);
    ok(/(^|&)gpu3=1(&|$)/.test(g.url), 'app: the conditions URL keeps gpu3=1', g.url);
    if (shots) await c.screenshot(`${shots}-app.png`);
    await c.navigate(page(q));
    await c.waitFor('__mpm?.solid?.ready', 60000);
    const note = await c.evaluate('(() => ({ hidden: document.querySelector(".compute-note")?.hidden, select: document.querySelector("[name=solid-compute]").value }))()');
    ok(note.select === 'cpu' && note.hidden === true, 'app: without gpu3 the CPU, no note', JSON.stringify(note));
    await c.waitFor('__mpm.solid.done', timeout);
    const p = await c.evaluate('(() => { const s = __mpm.solid; return { compute: s.compute, force: s.diag.steady?.force ?? null, spread: s.diag.steady?.spread ?? null, ms: s.frameShown?.msPerStep ?? null, url: s.url }; })()');
    ok(p.compute?.compute === 'cpu' && p.compute.gpu === null, 'app: the pass ran on the CPU', JSON.stringify(p.compute));
    ok(!/gpu3/.test(p.url), 'app: the conditions URL has no gpu3 on the CPU', p.url);
    if (g.force !== null && p.force !== null) {
      near(g.force, p.force, 5e-3, `app: the GPU's steady force within 0.5 % of the CPU's (${pct(g.force, p.force)})`);
      near(g.spread, p.spread, 1e-2, 'app: the spread within 1 %');
      ok(g.ms !== null && p.ms !== null && g.ms < p.ms, 'app: the GPU step is faster', `${p.ms?.toFixed(2)} → ${g.ms?.toFixed(2)} ms/step`);
    }
  }
  await c.navigate('about:blank');
} catch (err) {
  ok(false, 'the GPU check ran to the end', String(err?.message ?? err));
} finally {
  c?.close?.();
}
done();
