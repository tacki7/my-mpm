// @check
// The video containers (src/app/mux.ts): an MP4 and a WebM written from scratch must be read back whole.
// With ffmpeg at hand, real H.264 and VP9 frames are encoded, put in the containers and decoded again by
// ffprobe (every frame, the right size and length); without it, only the containers' structure is walked.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mp4, webm } from '../../src/app/mux.ts';

let failed = 0;
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!cond) failed++;
};

const N = 25;
const FPS = 12.5;
const W = 64;
const H = 48;
const US = 1e6 / FPS;
const stamp = (i) => ({ timestamp: Math.round(i * US), duration: Math.round(US) });

// ── the containers' structure, with made-up frames
const fake = Array.from({ length: N }, (_, i) => ({ data: new Uint8Array(10 + i).fill(i), key: i % 10 === 0, ...stamp(i) }));
const m = mp4(fake, W, H, new Uint8Array([1, 66, 0, 31, 0xff, 0xe1, 0, 0, 1, 0, 0]));
const boxes = (b, at = 0, end = b.length) => {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset);
  while (at + 8 <= end) {
    const n = dv.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    out.push({ type, at, n });
    if (n < 8) throw new Error(`box ${type} of size ${n} at ${at}`);
    at += n;
  }
  return out;
};
const top = boxes(m);
ok(top.map((x) => x.type).join(' ') === 'ftyp mdat moov' && top.at(-1).at + top.at(-1).n === m.length, 'the MP4 is ftyp, mdat, moov and nothing else', top.map((x) => `${x.type}:${x.n}`).join(' '));
const walk = (b, box, path) => {
  const me = path + '/' + box.type;
  if (!['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'stsd', 'avc1'].includes(box.type)) return [me];
  // stsd and the sample entry carry their own fields before their children
  const kids = boxes(b, box.at + 8 + (box.type === 'stsd' ? 8 : box.type === 'avc1' ? 78 : 0), box.at + box.n);
  return [me, ...kids.flatMap((k) => walk(b, k, me))];
};
const tree = walk(m, top[2], '');
ok(['/moov/trak/mdia/minf/stbl/stsd/avc1/avcC', '/moov/trak/mdia/minf/stbl/stco', '/moov/trak/mdia/minf/stbl/stss', '/moov/trak/mdia/hdlr'].every((p) => tree.includes(p)), 'the sample table, the codec configuration and the handler are where a player looks', tree.join(' '));
const mdatData = m.subarray(top[1].at + 8, top[1].at + top[1].n);
ok(mdatData.length === fake.reduce((s, f) => s + f.data.length, 0) && mdatData[0] === 0 && mdatData[10] === 1, 'mdat is the frames back to back');

const w = webm(fake, W, H);
const ebmlIds = (b) => {
  // the top level and the segment's children (every size is written 8 bytes wide)
  const idLen = (x) => (x >= 0x80 ? 1 : x >= 0x40 ? 2 : x >= 0x20 ? 3 : 4);
  const read = (at, end) => {
    const out = [];
    while (at < end) {
      const n = idLen(b[at]);
      let id = 0;
      for (let i = 0; i < n; i++) id = id * 256 + b[at + i];
      let size = 0;
      for (let i = 1; i < 8; i++) size = size * 256 + b[at + n + i];
      out.push({ id: id.toString(16), at, size, body: at + n + 8 });
      at += n + 8 + size;
    }
    return out;
  };
  const tops = read(0, b.length);
  return { tops, segment: read(tops[1].body, tops[1].body + tops[1].size) };
};
const e = ebmlIds(w);
ok(e.tops.map((x) => x.id).join(' ') === '1a45dfa3 18538067', 'the WebM is an EBML header then one segment', e.tops.map((x) => x.id).join(' '));
ok(e.segment.map((x) => x.id).join(' ') === '1549a966 1654ae6b 1c53bb6b 1f43b675', 'the segment is info, tracks, cues and one cluster (25 frames at 12.5 fps fit one)', e.segment.map((x) => x.id).join(' '));
const cues = e.segment[2];
const cuePos = w.subarray(cues.body, cues.body + cues.size);
// the last 8 bytes of the (only) cue point are the cluster's position, from the start of the segment's body
let pos = 0;
for (let i = cuePos.length - 8; i < cuePos.length; i++) pos = pos * 256 + cuePos[i];
ok(pos === e.segment[3].at - e.tops[1].body, 'the cue points at the cluster', `${pos} vs ${e.segment[3].at - e.tops[1].body}`);
// a long run: clusters split so a block's 16-bit offset [ms] always fits
const long = Array.from({ length: 1500 }, (_, i) => ({ data: new Uint8Array(4), key: i % 100 === 0, ...stamp(i) }));
const wl = webm(long, W, H);
const el = ebmlIds(wl);
const clusters = el.segment.filter((x) => x.id === '1f43b675');
// key frames every 8 s, a new cluster at the first one 15 s or more after the cluster's start: 0, 16, 32, ... 112 s
ok(clusters.length === 8 && el.segment[2].size === 8 * (el.segment[2].size / 8) && el.segment[2].size === 8 * (e.segment[2].size), '120 s of frames go in 8 clusters (a new one at the first key frame 15 s on) with a cue each', `${clusters.length} clusters, cues ${el.segment[2].size} bytes vs ${e.segment[2].size} for one`);

// ── real frames through ffmpeg, decoded again by ffprobe
const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
if (!has('ffmpeg') || !has('ffprobe')) {
  console.log('SKIP  ffmpeg / ffprobe not found: the containers were not decoded');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'mux-'));
  const src = ['-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=${FPS}:duration=${N / FPS}`];
  const probe = (file) => {
    const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const err = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-i', file], { encoding: 'utf8' }).stderr;
    const j = JSON.parse(out);
    return { ...j.streams[0], duration: j.format.duration, err: err.split('\n')[0] };
  };

  // H.264 as an Annex B stream (start codes), turned into AVCC frames the way the browser's encoder gives them
  const h264 = join(dir, 'a.h264');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...src, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-x264-params', 'bframes=0', '-f', 'h264', h264]);
  const raw = readFileSync(h264);
  const nals = [];
  for (let i = 0, start = -1; i <= raw.length; i++) {
    const code = i + 3 <= raw.length && raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1;
    if (code || i === raw.length) {
      if (start >= 0) {
        let end = i === raw.length ? i : i;
        while (end > start && raw[end - 1] === 0) end--; // a 4-byte start code's leading zero
        nals.push(raw.subarray(start, end));
      }
      if (code) {
        start = i + 3;
        i += 2;
      }
    }
  }
  const sps = nals.find((n) => (n[0] & 0x1f) === 7);
  const pps = nals.find((n) => (n[0] & 0x1f) === 8);
  const avcC = new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps]);
  const frames = [];
  let au = [];
  let key = false;
  const flush = () => {
    if (!au.length) return;
    const n = au.reduce((s, x) => s + 4 + x.length, 0);
    const data = new Uint8Array(n);
    let at = 0;
    for (const x of au) {
      new DataView(data.buffer).setUint32(at, x.length);
      data.set(x, at + 4);
      at += 4 + x.length;
    }
    frames.push({ data, key, ...stamp(frames.length) });
    au = [];
    key = false;
  };
  for (const n of nals) {
    const type = n[0] & 0x1f;
    if (type === 7 || type === 8 || type === 9) continue;
    // a slice with first_mb_in_slice = 0 (ue(v) '1') starts a new picture
    if ((type === 1 || type === 5) && n[1] & 0x80 && au.some((x) => [1, 5].includes(x[0] & 0x1f))) flush();
    au.push(n);
    if (type === 5) key = true;
  }
  flush();
  ok(frames.length === N && frames[0].key && frames[10].key && !frames[1].key, `ffmpeg gave ${N} H.264 frames, key frames every 10`, `${frames.length} frames, keys at ${frames.flatMap((f, i) => (f.key ? [i] : []))}`);
  const mp4File = join(dir, 'a.mp4');
  writeFileSync(mp4File, mp4(frames, W, H, avcC));
  const pm = probe(mp4File);
  ok(pm.codec_name === 'h264' && pm.width === W && pm.height === H && +pm.nb_read_frames === N && Math.abs(+pm.duration - N / FPS) < 1e-3 && pm.err === '', 'ffprobe decodes every frame of the MP4 at the right size and length, without complaint', `${pm.codec_name} ${pm.width}×${pm.height}, ${pm.nb_read_frames} frames, ${pm.duration} s${pm.err ? `, ${pm.err.trim()}` : ''}`);

  // VP9 as an IVF stream (a 32-byte header, then 12 bytes of header before each frame)
  const ivf = join(dir, 'a.ivf');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...src, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '10', '-lag-in-frames', '0', '-f', 'ivf', ivf]);
  const iv = readFileSync(ivf);
  const vp9 = [];
  for (let at = 32; at + 12 <= iv.length; ) {
    const n = iv.readUInt32LE(at);
    const data = new Uint8Array(iv.subarray(at + 12, at + 12 + n));
    // a VP9 key frame: frame_type bit (the 4th bit of the first byte for profile 0) is 0
    vp9.push({ data, key: (data[0] & 0x04) === 0, ...stamp(vp9.length) });
    at += 12 + n;
  }
  ok(vp9.length === N && vp9[0].key && !vp9[1].key, `ffmpeg gave ${N} VP9 frames`, `${vp9.length} frames, keys at ${vp9.flatMap((f, i) => (f.key ? [i] : []))}`);
  const webmFile = join(dir, 'a.webm');
  writeFileSync(webmFile, webm(vp9, W, H));
  const pw = probe(webmFile);
  ok(pw.codec_name === 'vp9' && pw.width === W && pw.height === H && +pw.nb_read_frames === N && Math.abs(+pw.duration - N / FPS) < 1e-3 && pw.err === '', 'ffprobe decodes every frame of the WebM at the right size and length, without complaint', `${pw.codec_name} ${pw.width}×${pw.height}, ${pw.nb_read_frames} frames, ${pw.duration} s${pw.err ? `, ${pw.err.trim()}` : ''}`);
  // seeking lands on a frame
  const seek = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1.2', '-i', webmFile, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  ok(seek.status === 0 && seek.stderr === '', 'a seek into the WebM finds a frame through the cues', seek.stderr.trim());
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`${failed} FAIL`);
  process.exit(1);
}
