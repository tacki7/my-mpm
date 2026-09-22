// The tape of frames a 3D run records for playback (src/app/tape.ts): frames pushed at a steady rate stay evenly
// spaced however many come, the first is kept, the latest is always the end of the tape, the count and the bytes
// stay under their limits, and a cleared tape starts over.
// @check
import { ok, done } from './lib.mjs';
import { Tape } from '../../src/app/tape.ts';

const frame = (i, bytes = 1000) => ({ i, bytes });
{
  const t = new Tape((f) => f.bytes, 100, 1e9);
  for (let i = 0; i < 1000; i++) t.push(frame(i));
  const idx = t.frames.map((f) => f.i);
  const gaps = idx.slice(1).map((v, k) => v - idx[k]);
  ok(t.length <= 100 && t.length >= 50, '1000 frames at most 100: between 50 and 100 kept', `${t.length}`);
  ok(idx[0] === 0 && idx[idx.length - 1] === 999, 'the first frame and the latest are on the tape', `${idx[0]} … ${idx[idx.length - 1]}`);
  const inner = gaps.slice(0, -1);
  ok(inner.every((g) => g === inner[0]) && inner[0] === 16, 'the kept frames are evenly spaced (every 16th)', `gaps ${[...new Set(gaps)].join(', ')}`);
  ok(gaps[gaps.length - 1] <= 16, 'the last gap is no wider', `${gaps[gaps.length - 1]}`);
}
{
  // a frame that was not kept is still the end of the tape, until the next kept one
  const t = new Tape((f) => f.bytes, 4, 1e9);
  for (let i = 0; i < 9; i++) t.push(frame(i));
  ok(t.frames.map((f) => f.i).join(',') === '0,4,8', 'after 9 frames with room for 4: 0, 4, 8', t.frames.map((f) => f.i).join(','));
  t.push(frame(9));
  ok(t.frames.map((f) => f.i).join(',') === '0,4,8,9', 'the 10th, not kept, is shown as the end', t.frames.map((f) => f.i).join(','));
  t.push(frame(10));
  t.push(frame(11));
  t.push(frame(12));
  ok(t.frames.map((f) => f.i).join(',') === '0,4,8,12', 'the 13th falls on the stride and replaces it', t.frames.map((f) => f.i).join(','));
}
{
  const t = new Tape((f) => f.bytes, 1000, 50_000);
  for (let i = 0; i < 300; i++) t.push(frame(i, 1000));
  ok(t.length <= 51 && t.frames[0].i === 0 && t.frames[t.length - 1].i === 299, 'the bytes limit thins the tape as the count limit does', `${t.length} frames`);
  t.clear();
  ok(t.length === 0 && t.frames.length === 0, 'cleared: empty');
  t.push(frame(0));
  t.push(frame(1));
  ok(t.frames.map((f) => f.i).join(',') === '0,1', 'and it takes every frame again', t.frames.map((f) => f.i).join(','));
}
done();
