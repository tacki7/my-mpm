// A sweep of conditions with the 3D model (src/mpm/solid/sweep.ts, the page's 「条件の比較」 tab), headless: the
// same tandem rolled for n conditions whose entry thickness, width, roll diameter and friction go linearly from a
// first to a last value, and what each came to after its last pass.
//   node tools/sweep.mjs [--vary h0=0.8:1.2] [--vary W=4:8] [--vary D=150:250] [--vary mu=0.05:0.12] [--n 10]
//                        [--stands 4] [--handoff steady|crop|done] [--jobs 4] [--json]
//                        and the base conditions as tools/solid.mjs has them ([--W 4] [--cells 4] [--h0 1] [--R 100] [--mu 0.08]
//                        [--r 0.25] [--mat spcc] [--tb 0] [--tf 0] [--plane-strain] [--flatten hitchcock] [--control reduction]
//                        [--bend <barrel mm> [--span <mm>]] [--crown <µm>])
// h0, W, D in mm (D the roll's diameter). --jobs: conditions rolled at once, one worker thread each (default: the
// cores less one, at most n). Prints a table, or with --json the values and the summaries (SI, as the page's
// __mpm.sweep.summaries).
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { defaultParams, MATERIALS } from '../src/mpm/params.ts';
import { solidParams } from '../src/mpm/solid/sim3.ts';
import { summarize, sweepCase, sweepValues } from '../src/mpm/solid/sweep.ts';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => (has(n) ? args[args.indexOf(`--${n}`) + 1] : d);
const base = defaultParams();
const r = base.rolling;
r.h0 = +opt('h0', 1) * 1e-3;
r.reduction = +opt('r', 0.25);
r.rollRadius = +opt('R', 100) * 1e-3;
r.mu = +opt('mu', 0.08);
r.backTension = +opt('tb', 0) * 1e6;
r.frontTension = +opt('tf', 0) * 1e6;
if (opt('flatten', 'none') === 'hitchcock') r.flattening = 'hitchcock';
if (has('rollE')) r.rollE = +opt('rollE') * 1e9;
if (opt('control', 'gap') === 'reduction') r.gapControl = 'reduction';
if (has('mat')) base.material = { ...MATERIALS[opt('mat')] };
if (has('damage')) base.damage.model = opt('damage');
base.numerics.cellsThrough = +opt('cells', 4);
const P = solidParams(base, { width: +opt('W', 4) * 1e-3, planeStrain: has('plane-strain'), ...(has('bend') ? { rollBend: { barrel: +opt('bend') * 1e-3, span: +opt('span', 0) * 1e-3 } } : {}), ...(has('crown') ? { crownIn: +opt('crown') * 1e-6 } : {}) });

const KEYS = { h0: ['h0', 1e-3], W: ['width', 1e-3], D: ['rollDiameter', 1e-3], mu: ['mu', 1] };
const vary = {};
args.forEach((a, i) => {
  if (a !== '--vary') return;
  const [name, range] = args[i + 1].split('=');
  const [key, f] = KEYS[name] ?? [];
  if (!key) throw new Error(`--vary: one of ${Object.keys(KEYS).join(', ')}`);
  const [a0, a1] = range.split(':').map(Number);
  vary[key] = [a0 * f, a1 * f];
});
const spec = { vary, count: +opt('n', 10), stands: +opt('stands', 4), handoff: opt('handoff', 'steady') };
const values = sweepValues(P, spec);
const jobs = Math.max(1, Math.min(values.length, +opt('jobs', Math.max(1, availableParallelism() - 1))));
const json = has('json');

const t0 = performance.now();
const results = new Array(values.length);
let next = 0;
await Promise.all(
  Array.from({ length: jobs }, () =>
    new Promise((resolve) => {
      const w = new Worker(new URL('./lib/sweep-case.mjs', import.meta.url));
      const give = () => {
        if (next >= values.length) return w.terminate().then(resolve);
        const index = next++;
        w.postMessage({ index, P: sweepCase(P, values[index]), values: values[index], stands: spec.stands, handoff: spec.handoff });
      };
      w.on('message', (m) => {
        results[m.index] = m;
        if (!json) console.log(`#${m.index + 1} ${m.error ? `error: ${m.error}` : m.result.stopped ? `stopped: ${m.result.stopped}` : 'done'} (${m.seconds.toFixed(0)} s)`);
        give();
      });
      give();
    }),
  ),
);
const secs = (performance.now() - t0) / 1e3;
const summaries = results.map((m) => (m.error ? null : summarize(m.result)));
if (json) {
  console.log(JSON.stringify({ spec, seconds: secs, cases: results.map((m, i) => ({ values: values[i], error: m.error ?? null, stopped: m.result?.stopped ?? null, seconds: m.seconds, summary: summaries[i] })) }, null, 1));
} else {
  const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  console.log(`\n${values.length} conditions, ${spec.stands} passes, handoff ${spec.handoff}, ${jobs} at once: ${secs.toFixed(0)} s`);
  console.log(['#', 'h0 mm', 'W mm', 'D mm', 'mu', ...Array.from({ length: spec.stands }, (_, k) => `F${k + 1} kN`), 'crown µm', 'spread %', 'h mm', 'flat I', 'D max'].join('\t'));
  summaries.forEach((s, i) => {
    const v = values[i];
    console.log([i + 1, f(v.h0 * 1e3, 3), f(v.width * 1e3, 2), f(v.rollDiameter * 1e3, 1), f(v.mu, 3), ...(s ? s.force.map((x) => f(x * 1e-3, 3)) : []), s ? f(s.crownOut * 1e6, 2) : '—', s ? f(s.spread * 100, 2) : '—', s ? f(s.thicknessOut * 1e3, 4) : '—', s ? f(s.flatness, 0) : '—', s ? f(s.maxDamage, 3) : '—'].join('\t'));
  });
}
