// The recorded frames of a 3D run written to a video file: each frame is drawn on a canvas off the page at a fixed
// size, encoded with the browser's VideoEncoder (H.264 in an MP4 where the browser can encode it, else VP9 in a
// WebM) and put in a container written here (mux.ts). Nothing leaves the browser.
import { mp4, webm, type EncodedFrame } from './mux.ts';

export interface VideoJob {
  /** [px], even numbers */
  width: number;
  height: number;
  /** the time between frames [µs] */
  frameUs: number;
  /** how many frames */
  n: number;
  /** draw frame i on the canvas */
  draw: (i: number, canvas: HTMLCanvasElement) => void;
  /** after each frame is handed to the encoder */
  onProgress?: (done: number, n: number) => void;
  signal?: AbortSignal;
}

export interface VideoResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  width: number;
  height: number;
  frames: number;
  /** the video's length [s] */
  seconds: number;
}

/** a key frame this often, so seeking is quick */
const KEY_EVERY = 50;

export const videoSupported = (): boolean => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

/** H.264 (Main, level 4: up to 1920×1080) in an MP4 when the browser can encode it, else VP9 in a WebM */
async function pickCodec(width: number, height: number): Promise<{ codec: string; ext: VideoResult['ext'] }> {
  const tries: { codec: string; ext: VideoResult['ext'] }[] = [
    { codec: 'avc1.4d0028', ext: 'mp4' },
    { codec: 'vp09.00.10.08', ext: 'webm' },
  ];
  for (const t of tries) {
    const s = await VideoEncoder.isConfigSupported({ codec: t.codec, width, height, ...(t.ext === 'mp4' ? { avc: { format: 'avc' } } : {}) });
    if (s.supported) return t;
  }
  throw new Error('このブラウザには H.264 も VP9 のエンコーダも無い');
}

/** a copy of a buffer source's bytes (the decoder configuration comes as one) */
function bytesOf(d: AllowSharedBufferSource): Uint8Array {
  if (d instanceof ArrayBuffer || d instanceof SharedArrayBuffer) return new Uint8Array(d.slice(0));
  return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

export async function recordVideo(job: VideoJob): Promise<VideoResult> {
  const { width, height, frameUs, n } = job;
  if (!videoSupported()) throw new Error('このブラウザは動画のエンコード（WebCodecs）に対応していない');
  if (n < 1) throw new Error('no frames');
  const { codec, ext } = await pickCodec(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const frames: EncodedFrame[] = [];
  let avcC: Uint8Array | null = null;
  let failed: Error | null = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !avcC) avcC = bytesOf(d);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp, duration: chunk.duration ?? frameUs });
    },
    error: (e) => {
      failed = e;
    },
  });
  const fps = 1e6 / frameUs;
  enc.configure({
    codec,
    width,
    height,
    framerate: fps,
    bitrate: Math.round(0.25 * width * height * fps),
    latencyMode: 'quality',
    ...(ext === 'mp4' ? { avc: { format: 'avc' } } : {}),
  });
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
  try {
    for (let i = 0; i < n; i++) {
      if (job.signal?.aborted) throw new DOMException('動画の書き出しをやめた', 'AbortError');
      if (failed) throw failed;
      job.draw(i, canvas);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      enc.encode(vf, { keyFrame: i % KEY_EVERY === 0 });
      vf.close();
      job.onProgress?.(i + 1, n);
      // let the encoder catch up and the page draw
      while (enc.encodeQueueSize > 2) await breathe();
      if (i % 4 === 3) await breathe();
    }
    await enc.flush();
    if (failed) throw failed;
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
  if (frames.length !== n) throw new Error(`the encoder gave ${frames.length} frames for ${n}`);
  if (ext === 'mp4' && !avcC) throw new Error('the H.264 encoder gave no decoder configuration');
  frames.sort((a, b) => a.timestamp - b.timestamp);
  const bytes = ext === 'mp4' ? mp4(frames, width, height, avcC!) : webm(frames, width, height);
  return {
    blob: new Blob([bytes as BlobPart], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' }),
    ext,
    width,
    height,
    frames: n,
    seconds: (n * frameUs) / 1e6,
  };
}
