// The time a run still needs, estimated from how fast it has been getting on. A worker sends how far the running
// stand is through its pass (src/mpm/progress.ts: the way the strip's tail has come); the rate of that against the
// wall clock over the last WINDOW seconds gives the rest of the stand. A tandem's later stands are not running
// yet: each is taken as the stand before it times `growth` (the finished stands' own ratio once two are in).
// Only the time the run was running counts (a pause is not part of it).

/** the rate is read over this much running time [s], and not before MIN_SPAN of it */
const WINDOW = 12;
const MIN_SPAN = 2;
/** how fast the shown value follows a new estimate (per frame that brings one) */
const FOLLOW = 0.15;

export class Eta {
  /** running time so far [s] and the running stand's progress then */
  private samples: [number, number][] = [];
  private ran = 0;
  private lastNow: number | null = null;
  private stand = -1;
  private standBegan = 0;
  /** the finished stands' running times [s] */
  private spent: number[] = [];
  private shown: number | null = null;
  private shownAt = 0;

  reset(): void {
    this.samples = [];
    this.ran = 0;
    this.lastNow = null;
    this.stand = -1;
    this.standBegan = 0;
    this.spent = [];
    this.shown = null;
    this.shownAt = 0;
  }

  /**
   * A frame. now [ms]; running: the worker is stepping (the time since the last frame counts); progress 0..1 of stand
   * `stand` (0 first) of `stands`; growth: a stand's cost over the one before it (a guess until two stands are in).
   */
  update(now: number, running: boolean, progress: number, stand: number, stands: number, growth: number): void {
    if (stand < this.stand) return;
    // a frame of a paused run (a redraw, the pause itself) changes nothing: the shown value stands still
    if (!running) {
      this.lastNow = null;
      return;
    }
    if (this.lastNow != null) this.ran += (now - this.lastNow) / 1e3;
    this.lastNow = now;
    if (stand !== this.stand) {
      if (this.stand >= 0 && stand > this.stand) this.spent.push(this.ran - this.standBegan);
      this.stand = stand;
      this.standBegan = this.ran;
      this.samples = [];
    }
    const s = this.samples;
    if (!s.length || this.ran > s[s.length - 1][0]) s.push([this.ran, progress]);
    // keep one sample older than the window as its far end
    while (s.length > 2 && s[1][0] <= this.ran - WINDOW) s.shift();

    const [t0, p0] = s[0];
    const span = this.ran - t0;
    if (span < MIN_SPAN || !(progress > p0)) return;
    const rest = ((1 - progress) * span) / (progress - p0);
    // the stands to come, each the one before times g
    const whole = this.ran - this.standBegan + rest;
    const n = this.spent.length;
    const g = n >= 2 && this.spent[n - 2] > 0 ? this.spent[n - 1] / this.spent[n - 2] : growth;
    let later = 0;
    for (let j = 1, c = whole; j < stands - stand; j++) later += c *= g;
    const estimate = rest + later;
    // the shown value runs down with the clock and leans toward each new estimate
    const runDown = this.shown == null ? estimate : Math.max(0, this.shown - (this.ran - this.shownAt));
    this.shown = runDown + FOLLOW * (estimate - runDown);
    this.shownAt = this.ran;
  }

  /** the time left [s] as of the last frame; null before there is a rate to go by */
  get seconds(): number | null {
    return this.shown;
  }
}

/** 残り 約 3 分 20 秒: whole seconds under a minute and a half, tens of seconds under ten minutes, minutes beyond */
export function etaText(seconds: number | null, started: boolean, finished: boolean): string {
  if (finished || !started) return '';
  if (seconds == null) return '残り 計算中…';
  if (seconds < 90) return `残り 約 ${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 600) {
    const s = Math.round(seconds / 10) * 10;
    return `残り 約 ${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : ''}`;
  }
  const m = Math.round(seconds / 60);
  return m < 60 ? `残り 約 ${m} 分` : `残り 約 ${Math.floor(m / 60)} 時間${m % 60 ? ` ${m % 60} 分` : ''}`;
}

/** a tandem's stand against the one before it, before any stand is in: the strip is 1/(1−r) longer on a grid (1−r) finer
 *  (handoff 'done': points and steps both by 1/(1−r)² in the section model, points by one power more in 3D); a stand
 *  that hands on when steady (or its middle stretch, 'crop') rolls a strip as long as its reading needs, which grows
 *  about as the thickness falls */
export function standGrowth(reduction: number, handoff: 'done' | 'steady' | 'crop', threeD: boolean): number {
  const k = 1 / (1 - reduction);
  return handoff === 'done' ? k ** (threeD ? 5 : 4) : k;
}
