// A recording of the frames a run sends, to be played back once it has stopped. The frames come at a steady
// rate while the run goes, so the tape is thinned by whole strides: once it holds more than it may, it keeps
// every other frame and from then on takes every other one that comes (then every fourth, ...), so the kept
// frames stay evenly spaced over the whole run however long it gets. The first frame is always kept, and the
// latest one is always on show at the end, kept or not.
export class Tape<T> {
  private kept: T[] = [];
  /** the last frame pushed when it was not kept (shown as the end of the tape) */
  private latest: T | null = null;
  private bytes = 0;
  private stride = 1;
  private count = 0;
  private readonly size: (f: T) => number;
  readonly maxFrames: number;
  readonly maxBytes: number;

  constructor(size: (f: T) => number, maxFrames = 400, maxBytes = 160e6) {
    this.size = size;
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
  }

  /** the frames on the tape, first to last */
  get frames(): readonly T[] {
    return this.latest ? [...this.kept, this.latest] : this.kept;
  }

  get length(): number {
    return this.kept.length + (this.latest ? 1 : 0);
  }

  push(f: T): void {
    const take = this.count % this.stride === 0;
    this.count++;
    if (!take) {
      this.latest = f;
      return;
    }
    this.latest = null;
    this.kept.push(f);
    this.bytes += this.size(f);
    while (this.kept.length > 1 && (this.kept.length > this.maxFrames || this.bytes > this.maxBytes)) this.thin();
  }

  /** A newer version of the last frame (the same step, sent again on a pause or at the end) takes its place. */
  replaceLast(f: T): void {
    if (this.latest) {
      this.latest = f;
      return;
    }
    const last = this.kept.pop();
    if (last === undefined) {
      this.push(f);
      return;
    }
    this.bytes += this.size(f) - this.size(last);
    this.kept.push(f);
  }

  /** every other kept frame goes (the first stays), and from now on only every other pushed frame is taken */
  private thin(): void {
    const keep: T[] = [];
    let bytes = 0;
    for (let i = 0; i < this.kept.length; i += 2) {
      keep.push(this.kept[i]);
      bytes += this.size(this.kept[i]);
    }
    this.kept = keep;
    this.bytes = bytes;
    // the kept frames sit at multiples of the old stride; every other one is at a multiple of the new
    this.stride *= 2;
  }

  clear(): void {
    this.kept = [];
    this.latest = null;
    this.bytes = 0;
    this.stride = 1;
    this.count = 0;
  }
}
