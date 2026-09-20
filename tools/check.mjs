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
//
// Wall-clock watchdog: a script that hangs is FAILed, not waited for. Some ways
// of breaking the solver do not make a check report a wrong number — they make
// one step take minutes (a secant iteration that stops converging, a time step
// that collapses), and without a limit the gate stops being a gate: locally it
// runs until someone gives up, and in CI it hits the job's own cut-off, which
// says "timed out" and not which check or how far over it went.
//
// The limit is one number for every script, `LIMIT_S` below, because a per
// script table here would be the central list that `// @check` exists to avoid.
// A script that is legitimately slower declares its own on its @check line:
//
//   // @check 300s
//
// How LIMIT_S was chosen: in CI the slowest check takes 25 s (tandem.mjs,
// ubuntu, whole gate 134 s); locally the slowest measurement across two runs of
// the whole gate was 52.7 s (stall.mjs; the other run 15.2 s — the machine also
// runs other work, and the same script varies by 3x, M2 with 8 GB, gate 4 min
// 19 s and 4 min 52 s, 2026-09-20). 180 s is ~3.4x the slowest measured, so a
// normal run does not trip it even on a busy machine, while one hung script
// costs 3 minutes instead of CI's 10-minute cut-off. Raise it only for a script
// that genuinely got slower; a script that suddenly needs minutes is the
// failure this is here to catch.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Straight to fd 1: a piped process.stdout is asynchronous on macOS, and with
// the child blocking the run the headings would come out late.
const say = (text) => writeSync(1, `${text}\n`);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const SELF = fileURLToPath(import.meta.url);
const LIMIT_S = 180;
// `// @check` on its own line, or `// @check 300s` for a script with its own limit.
const MARK = /^\/\/\s*@check(?:\s+(\d+)\s*s)?\s*$/;
// A line that meant to be the mark. `// @check 5m` and `// @check 300` are not
// MARK, and a script whose mark is misspelt simply does not join the gate — the
// worst way for a gate to break, since it then reports that everything passed.
// So anything that starts as the mark and is not one is an error, not a miss.
const LOOKS = /^\/\/\s*@check\b/;
// What a normal run of each script took, from the last time it passed here. Only
// used to say "normally M s" next to a script the watchdog killed; a fresh clone
// (CI) simply has no record yet.
const TIMES = join(TOOLS, 'out', 'check-times.json');

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
const checks = [];
const malformed = [];
for (const file of scripts(TOOLS).filter((f) => f !== SELF).map(posix).sort()) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    const m = MARK.exec(lines[i]);
    if (m) {
      if (!marked) checks.push({ file, limitS: m[1] ? Number(m[1]) : LIMIT_S });
      marked = true;
    } else if (LOOKS.test(lines[i])) {
      malformed.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
}

if (malformed.length) {
  say('a line that looks like the @check mark but is not — the script would be left out of the gate:');
  for (const b of malformed) say(`  ${b.file}:${b.line}  ${b.text}`);
  say('\nwrite `// @check` on its own line, or `// @check 300s` for a limit in whole seconds.');
  process.exit(1);
}

if (process.argv.includes('--list')) {
  say('tsc --noEmit');
  for (const c of checks) say(`node ${c.file}${c.limitS === LIMIT_S ? '' : `  (limit ${c.limitS} s)`}`);
  process.exit(0);
}

let before = {};
try {
  before = JSON.parse(readFileSync(TIMES, 'utf8'));
} catch {
  before = {}; // no record yet
}

// The child runs in its own process group so that killing it on a timeout also
// kills anything it spawned (neutral-point.mjs runs tools/run.mjs). That group
// is not the terminal's foreground group any more, so Ctrl-C reaches only this
// process — hence the relay below (SIGHUP too: the child is in another session
// and does not get the hangup when the terminal closes). A SIGKILL to this
// process cannot be relayed, so the running child is then orphaned and has to be
// killed by hand; before the group it would have died with the terminal.
let group = 0;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (group) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(130);
  });
}

function run(cmd, args, limitS) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', detached: true });
    group = child.pid;
    let timedOut = false;
    // SIGKILL, not SIGTERM: a process spinning in one long step never returns to
    // the event loop, so a handler would not run.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, limitS * 1000);
    child.on('error', () => {
      clearTimeout(timer);
      group = 0;
      done({ ok: false, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      group = 0;
      done({ ok: code === 0 && !timedOut, timedOut });
    });
  });
}

const results = [];
async function step(label, cmd, args, limitS) {
  say(`\n── ${label}`);
  const t0 = performance.now();
  const r = await run(cmd, args, limitS);
  const secs = (performance.now() - t0) / 1000;
  let note = '';
  if (r.timedOut) {
    const normal = before[label];
    note = `killed at ${limitS} s${normal === undefined ? ' (no time recorded for a normal run)' : ` (a normal run takes about ${normal.toFixed(0)} s)`}`;
    say(`\n${label}: ${note}`);
  }
  results.push({ label, status: r.ok ? 'PASS' : 'FAIL', secs, note });
}

// The TypeScript of this repository, not whatever `npx tsc` would fetch.
await step('tsc --noEmit', process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], LIMIT_S);
for (const c of checks) await step(c.file, process.execPath, [c.file], c.limitS);

const times = { ...before };
for (const r of results) if (r.status === 'PASS') times[r.label] = Number(r.secs.toFixed(1));
try {
  mkdirSync(dirname(TIMES), { recursive: true });
  writeFileSync(TIMES, `${JSON.stringify(times, null, 2)}\n`);
} catch {
  /* the record is a convenience; a read-only checkout still runs the gate */
}

say('\n── summary');
for (const r of results) say(`${r.status}  ${r.secs.toFixed(1).padStart(6)} s  ${r.label}${r.note ? `  ${r.note}` : ''}`);
const failed = results.filter((r) => r.status !== 'PASS').length;
say(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
