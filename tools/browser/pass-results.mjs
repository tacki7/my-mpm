// What the page shows once the pass is over, in a headless Chrome: the results table's load, torque, exit
// thickness and forward slip are the steady means (they were the moment's values, 0 once the sheet had left the
// rolls) and equal `node tools/run.mjs` for the same condition; the friction hill still shows the steady phase's
// mean profile where the moment's is 0; a tandem's table at the end reads the last stand's steady values, as the
// stand table does; and a sheet too short for a steady reading shows none, with the reason. Not a `@check` (it
// needs the dev server and Chrome). About 25 s.
//
//   CDP_PORT=<cdp> node tools/browser/pass-results.mjs <url> [shot.png]
//
// The page and the tool agree to about 1e-7, not bit for bit (Chrome's and Node's V8 round exp, log and atan2
// differently in the last bit; tools/browser/planview.mjs): the steady means are both TandemSim's / run.mjs's
// readings every 2000 steps.
import { execFileSync } from 'node:child_process';
import { connect } from './cdp.mjs';
import { ok, near, done } from '../checks/lib.mjs';

const [target, shot] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/pass-results.mjs <url> [shot.png]');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const rows = (c) =>
  c.evaluate(`Object.fromEntries([...document.querySelectorAll('#results tr[data-key]')].map((r) => [r.dataset.key, { value: r.dataset.value === '' ? null : +r.dataset.value, steady: r.dataset.steady === '1', label: r.firstChild.textContent, text: r.children[1].textContent }]))`);

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

  // ── one stand, the standard pass on 6 cells, to the end
  await c.navigate(page('?autorun=1&cells=6&L=8'));
  await c.waitFor('__mpm.done', 180000);
  await painted();
  const r = await rows(c);
  const d = await c.evaluate('({ phase: __mpm.diag.phase, force: __mpm.diag.rollForce })');
  ok(d.phase === 'done' && d.force === 0, "the sheet has left the rolls: the moment's load is 0 (__mpm.diag stays the moment's)", `${d.phase}, ${d.force} N/m`);
  ok(['force', 'torque', 'exit', 'slip'].every((k) => r[k]?.steady && r[k].value != null && r[k].label.endsWith('（定常）')),
    'after the pass the table shows the steady means, labelled so', Object.values(r).map((x) => `${x.label} ${x.text}`).join(', '));
  const tool = JSON.parse(execFileSync('node', ['tools/run.mjs', '--cells', '6', '--L', '8', '--json'], { encoding: 'utf8' }));
  near(r.force.value, tool.steadyForce_kN_per_mm, 1e-6, 'load = run.mjs steady force [kN/mm]');
  near(r.torque.value, tool.steadyTorque_N * 1e-3, 1e-6, 'torque = run.mjs steady torque [kN·m/m]');
  near(r.exit.value, tool.exitThickness_mm, 1e-6, 'exit thickness = run.mjs [mm]');
  near(r.slip.value, tool.forwardSlip * 100, 1e-5, 'forward slip = run.mjs [%]');
  const hill = await c.evaluate('__mpm.hill');
  const peak = (a) => (a ? Math.max(...a.p) : 0);
  ok(peak(hill.frame) === 0 && peak(hill.steady) > 300e6,
    "the friction hill keeps the steady phase's mean (the moment's profile is 0 after the pass)",
    `moment ${(peak(hill.frame) * 1e-6).toFixed(0)} MPa, steady mean peak ${(peak(hill.steady) * 1e-6).toFixed(0)} MPa`);
  const legend = await c.evaluate(`document.getElementById('legend-hill').textContent`);
  ok(legend.includes('定常の平均'), "the hill's legend tells the steady mean from the moment's line", legend.slice(0, 80));
  if (shot) {
    await c.screenshot(shot);
    console.log(`shot  ${shot}`);
  }

  // ── before the steady phase: the moment's values
  await c.navigate(page('?autorun=1&cells=6&L=8&stopafter=2000'));
  await c.waitFor('__mpm.done', 60000);
  const early = await rows(c);
  ok(!early.force.steady && early.force.label === '圧延荷重', 'before the steady phase the rows are the moment\'s values', `${early.force.label} ${early.force.text}`);

  // ── a tandem: at the end the table reads the last stand's steady values, as the stand table has them
  await c.navigate(page('?stands=3&cells=4&L=4&autorun=1'));
  await c.waitFor('__mpm.done', 300000);
  const t = await rows(c);
  const last = await c.evaluate('__mpm.standResults.at(-1)');
  ok(t.force.steady && t.force.value === last.steadyForce * 1e-6 && t.exit.value === last.exitThickness * 1e3,
    "a tandem's table at the end: the last stand's steady load and exit thickness, as its result",
    `${t.force.text} kN/mm, ${t.exit.text} mm (result ${(last.steadyForce * 1e-6).toFixed(3)}, ${(last.exitThickness * 1e3).toFixed(4)})`);

  // ── a sheet too short for a steady reading: none, and why
  await c.navigate(page('?autorun=1&cells=4&L=4'));
  await c.waitFor('__mpm.done', 120000);
  const short = await rows(c);
  const note = await c.evaluate(`document.getElementById('results-note').textContent`);
  ok(short.force.value === null && short.force.text === '—' && note.includes('定常の読みが無い'), 'a 4 mm sheet on 4 cells: no steady reading, the rows show — and the note says why', note.slice(0, 40));

  // ── a front tension over 2k pulls the strip out: the torque turns negative, and the note says why
  await c.navigate(page('?preset=front-tension&cells=4&L=16&autorun=1'));
  await c.waitFor('__mpm.done', 300000);
  const pulled = await rows(c);
  const pulledNote = await c.evaluate(`document.getElementById('results-note').textContent`);
  ok(pulled.torque.value < 0 && pulledNote.includes('圧延トルクが負'), 'the front-tension pass: a negative torque, with the reason under the table', `${pulled.torque.value.toFixed(3)} kN·m/m, 「${pulledNote.slice(pulledNote.indexOf('圧延トルク'))}」`);
  ok(!note.includes('圧延トルクが負'), 'a pass with a positive torque says nothing about it');
} finally {
  if (c) {
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
}
done();
