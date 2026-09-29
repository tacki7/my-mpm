// The pieces of computing on another machine (src/app/remote.ts, tools/remote/) and the mid-thickness face, in
// node without a network or a GPU (about 20 s):
// - src/app/remoteCodec.ts: a message of every kind the workers send (typed arrays of each type, a subarray at an
//   offset, an ArrayBuffer, NaN and ±Infinity, nested objects and arrays, null, Japanese text) comes back equal
// - tools/remote/host.mjs runs the page's own 3D worker (src/app/solid.worker.ts) on worker_threads, spoken to in
//   the codec's frames as the server passes them: 'ready' with the two threads asked for (its team of helpers,
//   host.mjs's Worker, on SharedArrayBuffer), frames with the faces as typed arrays, and at the stop the look
//   of a Tandem3 stepped here the same number of steps (1e-9: the team's sums in another order)
// - the faces (src/mpm/solid/surface.ts) carry the mid-thickness plane ('mid', for solidView's 板厚の中央で切る):
//   in the quarter model at y = 0 exactly, in the whole-thickness model at y = 0 before the rolls touch, both
//   under the top face's vertices
// Calibration (2026-09-29, copies of the tree): with the codec's NaN words taken out (JSON's null) the round trip
// FAILs; with host.mjs's crossOriginIsolated left unset the worker falls back to 1 thread and 'ready' FAILs; with
// the mid face made from the top row it is not at y = 0 and FAILs.
// @check
import { Worker } from 'node:worker_threads';
import { ok, near, done } from './lib.mjs';
import { encode, decode } from '../../src/app/remoteCodec.ts';
import { defaultParams } from '../../src/mpm/params.ts';
import { Sim3, solidParams } from '../../src/mpm/solid/sim3.ts';
import { Tandem3 } from '../../src/mpm/solid/tandem3.ts';
import { faces } from '../../src/mpm/solid/surface.ts';

// ── the codec
{
  const big = new Float32Array(1000).map((_, i) => Math.sin(i));
  const msg = {
    type: 'frame',
    faces: [{ name: 'top', rows: 2, cols: 3, pos: big, vals: new Float64Array([1.5, NaN, -0]), failed: new Uint8Array([0, 1, 1]).subarray(1) }],
    ints: new Int32Array([-1, 2 ** 31 - 1]),
    raw: new Uint16Array([7, 8, 9]).buffer,
    diag: { t: 1e-3, steady: null, firstCrack: { x: Infinity, y: -Infinity, z: NaN }, finished: false, phase: '定常圧延' },
    history: { from: 3, t: [0.1, 0.2], force: [NaN, 5] },
  };
  const back = decode(encode(msg));
  const same = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (a === 0 && b === 0);
    if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && a.constructor === b.constructor && a.length === b.length && [...a].every((v, i) => Object.is(v, b[i]));
    if (a instanceof ArrayBuffer) return b instanceof ArrayBuffer && same(new Uint8Array(a), new Uint8Array(b));
    if (a && typeof a === 'object') return b && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => same(a[k], b[k]));
    return a === b;
  };
  ok(same(msg, back), 'the codec returns a frame as it was (typed arrays, a subarray, an ArrayBuffer, NaN, ±Infinity, text)');
  ok(back.faces[0].failed.length === 2 && back.faces[0].failed[0] === 1, 'a subarray comes back as its own elements only', String([...back.faces[0].failed]));
  ok(encode(msg).byteLength < 4 * 1000 + 2000, 'the Float32Array travels as binary, not digits', `${encode(msg).byteLength} bytes`);
}

// ── the mid-thickness face
const base = () => {
  const P = defaultParams();
  P.numerics.cellsThrough = 4;
  P.rolling.sheetLength = 8e-3;
  return P;
};
for (const full of [false, true]) {
  const s = new Sim3(solidParams(base(), { width: 2e-3, ...(full ? { fullThickness: true } : {}) }));
  const fs = faces(s, []);
  const mid = fs.find((f) => f.name === 'mid');
  const top = fs.find((f) => f.name === 'top');
  ok(!!mid && mid.rows === top.rows && mid.cols === top.cols, `${full ? 'whole thickness' : 'quarter'}: a mid face the size of the top one`);
  let worst = 0;
  let under = 0;
  for (let v = 0; v < mid.rows * mid.cols; v++) {
    if (Number.isNaN(mid.pos[3 * v])) continue;
    worst = Math.max(worst, Math.abs(mid.pos[3 * v + 1]));
    under = Math.max(under, Math.abs(mid.pos[3 * v] - top.pos[3 * v]) + Math.abs(mid.pos[3 * v + 2] - top.pos[3 * v + 2]));
  }
  const h0 = s.params.rolling.h0;
  ok(full ? worst < 1e-9 * h0 : worst === 0, `${full ? 'whole thickness' : 'quarter'}: the mid face lies at y = 0`, `worst |y| ${worst.toExponential(2)} m`);
  ok(under < 1e-12, `${full ? 'whole thickness' : 'quarter'}: under the top face's vertices`, `${under.toExponential(2)} m`);
}

// ── the 3D worker on host.mjs, as the server runs it
{
  const STOP = 1000;
  const P = base();
  const solid = { width: 2e-3 };
  const w = new Worker(new URL('../remote/host.mjs', import.meta.url), { workerData: { entry: new URL('../../src/app/solid.worker.ts', import.meta.url).href, wire: true } });
  const send = (m) => {
    const b = encode(m);
    w.postMessage(b, [b]);
  };
  let ready = null;
  let frames = 0;
  let last = null;
  let error = null;
  const end = new Promise((resolve) => {
    w.on('message', (buf) => {
      const m = decode(buf);
      if (m.type === 'ready') {
        ready = m.geometry;
        send({ type: 'run' });
      } else if (m.type === 'frame') {
        frames++;
        last = m;
        if (!m.running && m.diag.step >= STOP) resolve();
      } else if (m.type === 'error') {
        error = m.message;
        resolve();
      }
    });
    w.on('error', (e) => {
      error = e.message;
      resolve();
    });
  });
  send({ type: 'init', params: P, solid, stands: 1, handoff: 'done', stopAfter: STOP, compute: 'cpu', threads: 2 });
  const timer = setTimeout(() => {
    error = 'timed out';
    w.terminate();
  }, 120000);
  await end;
  clearTimeout(timer);
  await w.terminate();
  ok(!error, 'the worker ran without an error', error ?? '');
  ok(ready?.threads === 2 && !ready?.threadsNote, "'ready' with the two threads asked for (the team on host.mjs's Worker)", `threads ${ready?.threads} ${ready?.threadsNote ?? ''}`);
  const f = last?.faces?.find((x) => x.name === 'mid');
  ok(frames > 0 && f?.pos instanceof Float32Array && f.vals instanceof Float32Array && f.failed instanceof Uint8Array, 'frames carry the faces as typed arrays, the mid face among them', `${frames} frames`);
  const T = new Tandem3(solidParams(P, solid), 1, 'done');
  while (T.stepOffset + T.sim.step < STOP) T.advance();
  near(last?.diag.now?.force, T.sampler.last?.force, 1e-9, `the look at step ${STOP} is the one of a Tandem3 stepped here`);
}

done();
