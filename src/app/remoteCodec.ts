// The messages between the page and a worker running on another machine (src/app/remote.ts, tools/remote/), as one
// binary WebSocket frame each: the message as JSON with its typed arrays taken out into binary blocks after it (a
// frame of the 3D model's faces is megabytes of Float32Array, which JSON would spell out digit by digit), and the
// numbers JSON has no words for (NaN, ±Infinity) spelled as objects. Plain data only: what postMessage carries
// between the page and its workers (objects, arrays, numbers, strings, booleans, null, typed arrays).
//
//   [u32 LE: header bytes][header: UTF-8 JSON { m, b: [[offset, bytes], ...] }][pad to 8][blocks, each at a multiple of 8]

type Ctor = new (b: ArrayBuffer) => ArrayBufferView;
const TYPED: Record<string, Ctor> = {
  Float64Array,
  Float32Array,
  Int32Array,
  Uint32Array,
  Int16Array,
  Uint16Array,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
};

const align8 = (n: number) => (n + 7) & ~7;

export function encode(message: unknown): ArrayBuffer {
  const blocks: Uint8Array[] = [];
  const json = JSON.stringify(message, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $n: String(v) };
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      blocks.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return { $t: v.constructor.name, $i: blocks.length - 1 };
    }
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
      blocks.push(new Uint8Array(v));
      return { $t: 'ArrayBuffer', $i: blocks.length - 1 };
    }
    return v;
  });
  const b: [number, number][] = [];
  let at = 0;
  for (const blk of blocks) {
    b.push([at, blk.byteLength]);
    at = align8(at + blk.byteLength);
  }
  const head = new TextEncoder().encode(JSON.stringify({ m: json, b }));
  const base = align8(4 + head.byteLength);
  const out = new ArrayBuffer(base + at);
  new DataView(out).setUint32(0, head.byteLength, true);
  const bytes = new Uint8Array(out);
  bytes.set(head, 4);
  blocks.forEach((blk, i) => bytes.set(blk, base + b[i][0]));
  return out;
}

export function decode(data: ArrayBuffer): unknown {
  const n = new DataView(data).getUint32(0, true);
  const { m, b } = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, n))) as { m: string; b: [number, number][] };
  const base = align8(4 + n);
  return JSON.parse(m, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as { $n?: string; $t?: string; $i?: number };
      if (typeof o.$n === 'string' && Object.keys(o).length === 1) return Number(o.$n);
      if (typeof o.$t === 'string' && typeof o.$i === 'number' && Object.keys(o).length === 2) {
        const [off, len] = b[o.$i];
        const buf = data.slice(base + off, base + off + len);
        if (o.$t === 'ArrayBuffer') return buf;
        const C = TYPED[o.$t];
        return C ? new C(buf) : buf;
      }
    }
    return v;
  });
}
