// The conditions tools/run.mjs runs (tools/run-params.mjs): with no option a preset runs as
// it is, bit for bit (the front-tension preset keeps its front tension, which run.mjs used
// to set to 0 unless --tf was given), and an option given changes only its own value.
// @check
import { ok, near, done } from './lib.mjs';
import { runParams } from '../run-params.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { PRESETS, presetById } from '../../src/mpm/presets.ts';

// leaf paths whose values differ (Object.is: bit for bit)
const leaves = (o, at = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') leaves(v, `${at}${k}.`, out);
    else out[at + k] = v;
  }
  return out;
};
const changed = (a, b) => {
  const [A, B] = [leaves(a), leaves(b)];
  return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => !Object.is(A[k], B[k]));
};

let diff = changed(runParams([]), defaultParams());
ok(diff.length === 0, 'no option: the defaults as they are', diff.join(', '));
for (const p of PRESETS) {
  diff = changed(runParams(['--preset', p.id]), p.build());
  ok(diff.length === 0, `--preset ${p.id}: the preset as it is, bit for bit`, diff.join(', '));
}

const ft = presetById('front-tension').build().rolling.frontTension;
ok(ft > 0 && runParams(['--preset', 'front-tension', '--cells', '4']).rolling.frontTension === ft, `--preset front-tension --cells 4 keeps the front tension (${ft * 1e-6} MPa)`);

const given = runParams(['--preset', 'front-tension', '--tf', '100', '--mu', '0.1', '--cells', '4', '--L', '8', '--mat', 'al6061']);
near(given.rolling.frontTension, 100e6, 1e-12, '--tf 100: the front tension given [Pa]');
diff = changed(given, presetById('front-tension').build()).filter((k) => !k.startsWith('material.'));
const want = ['rolling.frontTension', 'rolling.mu', 'numerics.cellsThrough', 'rolling.sheetLength'];
ok(diff.length === want.length && want.every((k) => diff.includes(k)), 'the options given change only their own values', diff.join(', '));
ok(given.material.name.includes('6061'), '--mat al6061 takes the catalogue material', given.material.name);
const old = runParams(['--contact', 'stencil', '--vrc', '5']);
ok(old.numerics.contact === 'stencil' && old.numerics.volRelaxContact === 5, '--contact stencil --vrc 5: the contact of before', `${old.numerics.contact}, ${old.numerics.volRelaxContact}`);
diff = changed(old, defaultParams());
ok(diff.length === 2 && diff.includes('numerics.contact') && diff.includes('numerics.volRelaxContact'), '--contact and --vrc change only their own values', diff.join(', '));
done();
