// `npm run check`: the regression gate — the type check, then every check script.
//
//   node tools/check.mjs          run everything (exit 1 if anything FAILs)
//   node tools/check.mjs --list   show what would run, in order
//
// A script under tools/ joins the gate by carrying the line
//
//   // @check
//
// (by convention just above its imports). Nothing else lists the checks, so two
// changes that each add one do not touch the same file. The scripts import the
// TypeScript in src/ directly (Node 22.18+ strips the types; the sources use
// only erasable syntax and `.ts` import paths for this reason).
//
// Serial — the machine this runs on has 8 GB. A failure does not stop the run:
// everything is tried, the table at the end says what passed, and the exit
// code says whether all did.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Straight to fd 1: a piped process.stdout is asynchronous on macOS, and with
// spawnSync blocking the loop the headings would come out late.
const say = (text) => writeSync(1, `${text}\n`);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const SELF = fileURLToPath(import.meta.url);

function scripts(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'out') continue;
      out.push(...scripts(join(dir, e.name)));
    } else if (e.name.endsWith('.mjs')) out.push(join(dir, e.name));
  }
  return out;
}

const posix = (p) => relative(ROOT, p).split(sep).join('/');
const checks = scripts(TOOLS)
  .filter((f) => f !== SELF)
  .map(posix)
  .sort()
  .filter((file) => readFileSync(join(ROOT, file), 'utf8').split('\n').some((l) => /^\/\/\s*@check\s*$/.test(l)));

if (process.argv.includes('--list')) {
  say('tsc --noEmit');
  for (const c of checks) say(`node ${c}`);
  process.exit(0);
}

const results = [];
function step(label, cmd, args) {
  say(`\n── ${label}`);
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  results.push({ label, status: r.status === 0 ? 'PASS' : 'FAIL', secs: (performance.now() - t0) / 1000 });
}

// The TypeScript of this repository, not whatever `npx tsc` would fetch.
step('tsc --noEmit', process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
for (const c of checks) step(c, process.execPath, [c]);

say('\n── summary');
for (const r of results) say(`${r.status}  ${r.secs.toFixed(1).padStart(6)} s  ${r.label}`);
const failed = results.filter((r) => r.status !== 'PASS').length;
say(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
