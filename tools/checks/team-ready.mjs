// The team's attach (src/mpm/solid/team.ts): a worker takes the barrier's generation before it says 'ready', so
// that a step launched as soon as the coordinator hears 'ready' is not missed. Before 2026-09-30 the generation
// was read after the post: a worker slow between the two (a stand switch is an attach, so the window opened at
// every stand) saw the first stage's generation as the one to wait on, waited for the next, and the coordinator
// waited for it — a deadlock. Each case runs in a child process with a 20 s limit (a deadlock is Atomics.wait in
// the main thread, which no timer in that process can interrupt). About 5 s.
// - a worker that sleeps 300 ms after posting 'ready' (the race, forced): three attaches, three steps each
// - the node helper as tools/solid.mjs spawns it: six attaches in a row (stand switches), three steps each
// @check
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ok, done } from './lib.mjs';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Team } from '../../src/mpm/solid/team.ts';
import { nodeTeam } from '../lib/solid-team.mjs';

const SELF = fileURLToPath(import.meta.url);
const LIMIT_MS = 20000;
const STEPS = 3;

const params = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 3e-3;
  return solidParams(P, { width: 1e-3, planeStrain: true });
};

/** a worker of the team that naps `delay` ms right after posting 'ready' (still inside runWorker, before its first wait) */
function slowSpawn(delay) {
  const teamUrl = new URL('../../src/mpm/solid/team.ts', import.meta.url).href;
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    import(workerData.teamUrl).then(({ runWorker }) => {
      let handler = null;
      parentPort.on('message', (m) => handler?.(m));
      runWorker({
        postMessage: (m) => { parentPort.postMessage(m); if (m && m.type === 'ready') nap(workerData.delay); },
        get onmessage() { return handler; },
        set onmessage(h) { handler = h; },
        terminate: () => process.exit(0),
      });
    });
  `;
  return () => {
    const w = new Worker(code, { eval: true, workerData: { teamUrl, delay } });
    let handler = null;
    w.on('message', (m) => handler?.(m));
    return {
      postMessage: (m) => w.postMessage(m),
      get onmessage() {
        return handler;
      },
      set onmessage(h) {
        handler = h;
      },
      terminate: () => void w.terminate(),
    };
  };
}

/** the child: `attaches` Sim3s attached one after another, STEPS steps each */
async function inner(delay, attaches) {
  const team = delay > 0 ? new Team(2, slowSpawn(delay)) : nodeTeam(2);
  const t0 = performance.now();
  for (let i = 0; i < attaches; i++) {
    const sim = new Sim3(params(), { shared: true, size: 2 });
    await team.attach(sim);
    for (let k = 0; k < STEPS; k++) team.step();
    if (sim.step !== STEPS) throw new Error(`attach #${i + 1}: ${sim.step} steps, not ${STEPS}`);
    console.log(`attach #${i + 1}: ${STEPS} steps`);
  }
  team.close();
  console.log(`${attaches} attaches in ${((performance.now() - t0) / 1e3).toFixed(1)} s`);
}

if (process.argv[2] === '--inner') {
  await inner(+process.argv[3], +process.argv[4]);
  process.exit(0);
}

const cases = [
  { what: 'a worker slow (300 ms) between its ready and its first wait: three attaches, three steps each', delay: 300, attaches: 3 },
  { what: 'the node helper: six attaches in a row (stand switches), three steps each', delay: 0, attaches: 6 },
];
for (const c of cases) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [SELF, '--inner', String(c.delay), String(c.attaches)], { timeout: LIMIT_MS, encoding: 'utf8' });
  const secs = ((performance.now() - t0) / 1e3).toFixed(1);
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean);
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const detail = timedOut ? `no end after ${LIMIT_MS / 1e3} s: ${lines.at(-1) ?? 'nothing printed'} (a deadlock)` : `${lines.at(-1) ?? ''}${r.status === 0 ? '' : `, exit ${r.status}`}`;
  ok(!timedOut && r.status === 0, c.what, `${detail}, ${secs} s`);
}
done();
