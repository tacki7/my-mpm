// Containers for the frames a VideoEncoder gives: an MP4 (H.264, one video track, everything in one chunk) and a
// WebM (VP9). Written from scratch so the app needs no library; only what a player needs to find, decode and seek
// the frames is written. Pure functions over bytes, so they can be checked in node (tools/checks/mux.mjs).

/** one encoded frame, as an EncodedVideoChunk gives it */
export interface EncodedFrame {
  data: Uint8Array;
  key: boolean;
  /** [µs] */
  timestamp: number;
  /** [µs] */
  duration: number;
}

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(...vs: number[]): Uint8Array {
  const b = new Uint8Array(4 * vs.length);
  const dv = new DataView(b.buffer);
  vs.forEach((v, i) => dv.setUint32(4 * i, v >>> 0));
  return b;
}

function u16(...vs: number[]): Uint8Array {
  const b = new Uint8Array(2 * vs.length);
  const dv = new DataView(b.buffer);
  vs.forEach((v, i) => dv.setUint16(2 * i, v));
  return b;
}

/** the total length [µs] of the frames */
export function lengthOf(frames: EncodedFrame[]): number {
  const last = frames[frames.length - 1];
  return last ? last.timestamp + last.duration : 0;
}

// ── MP4 (ISO base media) ─────────────────────────────────────────────────────
const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
};
/** a full box: version and flags first */
const full = (type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array => box(type, u32((version << 24) | flags), ...parts);
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
/** the media's clock: one tick per µs, the encoder's unit */
const TICKS = 1_000_000;

/**
 * An MP4 holding H.264 frames in AVCC form (length-prefixed NAL units, `avc: { format: 'avc' }` of the encoder),
 * with the decoder configuration (the `avcC` box's body, `decoderConfig.description` of the first chunk).
 */
export function mp4(frames: EncodedFrame[], width: number, height: number, avcC: Uint8Array): Uint8Array {
  if (frames.length === 0) throw new Error('no frames');
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  const mdat = box('mdat', ...frames.map((f) => f.data));
  const lengthUs = lengthOf(frames);
  const lengthMs = Math.round(lengthUs / 1e3);

  // sample durations, run-length coded
  const stts: number[] = [];
  for (const f of frames) {
    const d = Math.round(f.duration);
    if (stts.length && stts[stts.length - 1] === d) stts[stts.length - 2]++;
    else stts.push(1, d);
  }
  const keys = frames.flatMap((f, i) => (f.key ? [i + 1] : []));
  const avc1 = box(
    'avc1',
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(width, height),
    u32(0x480000, 0x480000), // 72 dpi
    zeros(4),
    u16(1), // frames per sample
    zeros(32), // compressor name
    u16(0x18, 0xffff), // depth, no colour table
    box('avcC', avcC),
  );
  const stbl = box(
    'stbl',
    full('stsd', 0, 0, u32(1), avc1),
    full('stts', 0, 0, u32(stts.length / 2), u32(...stts)),
    full('stss', 0, 0, u32(keys.length), u32(...keys)),
    full('stsc', 0, 0, u32(1), u32(1, frames.length, 1)),
    full('stsz', 0, 0, u32(0, frames.length), u32(...frames.map((f) => f.data.length))),
    full('stco', 0, 0, u32(1), u32(ftyp.length + 8)),
  );
  const minf = box('minf', full('vmhd', 0, 1, zeros(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
  const mdia = box(
    'mdia',
    full('mdhd', 0, 0, u32(0, 0, TICKS, lengthUs), u16(0x55c4, 0)),
    full('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler\0')),
    minf,
  );
  const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, lengthMs), zeros(8), u16(0, 0, 0, 0), MATRIX, u32(width << 16, height << 16));
  const mvhd = full('mvhd', 0, 0, u32(0, 0, 1000, lengthMs, 0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2));
  const moov = box('moov', mvhd, box('trak', tkhd, mdia));
  return concat([ftyp, mdat, moov]);
}

// ── WebM (Matroska) ──────────────────────────────────────────────────────────
const ID = {
  ebml: 0x1a45dfa3,
  ebmlVersion: 0x4286,
  ebmlReadVersion: 0x42f7,
  maxIdLength: 0x42f2,
  maxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
};

function idBytes(id: number): Uint8Array {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const b = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    b[i] = id & 0xff;
    id = Math.floor(id / 256);
  }
  return b;
}

/** an element's size, always in the 8-byte form (0x01 then 7 bytes) so sizes never change the layout */
function sizeBytes(n: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 7; i >= 1; i--) {
    b[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return b;
}

const element = (id: number, ...parts: Uint8Array[]): Uint8Array => {
  const body = concat(parts);
  return concat([idBytes(id), sizeBytes(body.length), body]);
};
/** an unsigned integer element, always 8 bytes wide */
const uint = (id: number, v: number): Uint8Array => {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return element(id, b);
};
const float = (id: number, v: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return element(id, b);
};
const str = (id: number, s: string): Uint8Array => element(id, ascii(s));

/** a cluster's blocks carry a 16-bit offset [ms] from the cluster's time, so a cluster spans at most this long */
const CLUSTER_MS = 30_000;

/** A WebM holding VP9 (or VP8 / AV1, by the codec id: `V_VP9`, `V_VP8`, `V_AV1`) frames, with cues for seeking. */
export function webm(frames: EncodedFrame[], width: number, height: number, codecId = 'V_VP9'): Uint8Array {
  if (frames.length === 0) throw new Error('no frames');
  const header = element(
    ID.ebml,
    uint(ID.ebmlVersion, 1),
    uint(ID.ebmlReadVersion, 1),
    uint(ID.maxIdLength, 4),
    uint(ID.maxSizeLength, 8),
    str(ID.docType, 'webm'),
    uint(ID.docTypeVersion, 4),
    uint(ID.docTypeReadVersion, 2),
  );
  const info = element(ID.info, uint(ID.timecodeScale, 1_000_000), float(ID.duration, lengthOf(frames) / 1e3), str(ID.muxingApp, 'mpm-rolling-lab'), str(ID.writingApp, 'mpm-rolling-lab'));
  const tracks = element(
    ID.tracks,
    element(ID.trackEntry, uint(ID.trackNumber, 1), uint(ID.trackUid, 1), uint(ID.trackType, 1), str(ID.codecId, codecId), element(ID.video, uint(ID.pixelWidth, width), uint(ID.pixelHeight, height))),
  );
  // clusters: a new one at every key frame that is far enough from the cluster's start, or when a block's offset
  // would not fit; the first frame must be a key frame for the first cluster to be decodable
  const clusters: { ms: number; body: Uint8Array }[] = [];
  let cur: { ms: number; blocks: Uint8Array[] } | null = null;
  for (const f of frames) {
    const ms = Math.round(f.timestamp / 1e3);
    if (!cur || (f.key && ms - cur.ms >= CLUSTER_MS / 2) || ms - cur.ms > CLUSTER_MS) {
      if (cur) clusters.push({ ms: cur.ms, body: concat([uint(ID.timecode, cur.ms), ...cur.blocks]) });
      cur = { ms, blocks: [] };
    }
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, ms - cur.ms);
    head[3] = f.key ? 0x80 : 0;
    cur.blocks.push(element(ID.simpleBlock, head, f.data));
  }
  if (cur) clusters.push({ ms: cur.ms, body: concat([uint(ID.timecode, cur.ms), ...cur.blocks]) });
  const clusterBytes = clusters.map((c) => element(ID.cluster, c.body));
  // the cues point at the clusters, as offsets from the start of the segment's body; every element here has a
  // fixed width, so the cues built with any offsets are as long as the real ones
  const cuesAt = (start: number) => {
    let at = start;
    return element(
      ID.cues,
      ...clusters.map((c, i) => {
        const p = element(ID.cuePoint, uint(ID.cueTime, c.ms), element(ID.cueTrackPositions, uint(ID.cueTrack, 1), uint(ID.cueClusterPosition, at)));
        at += clusterBytes[i].length;
        return p;
      }),
    );
  };
  const cues = cuesAt(info.length + tracks.length + cuesAt(0).length);
  return concat([header, element(ID.segment, info, tracks, cues, ...clusterBytes)]);
}
