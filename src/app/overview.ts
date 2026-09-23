// The overview strip: the whole sheet from tail to head in a thin band, the roll
// bite, the cracks, and a frame around what the roll-bite view shows. A click moves
// the view there.
import type { BiteView } from './view.ts';

const COLS = 240; // columns of the sheet's outline

export class Overview {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly view: BiteView;
  private lo = 0; // world x range drawn [m]
  private hi = 1;

  /** onMove: the view moved (redraw) */
  constructor(canvas: HTMLCanvasElement, view: BiteView, onMove: () => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.view = view;
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const t = (e.clientX - r.left) / r.width;
      view.centerOn(this.lo + t * (this.hi - this.lo));
      onMove();
    });
  }

  draw(): void {
    const { canvas, ctx, view } = this;
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const f = view.frame;
    const g = view.geometry;
    const vis = view.visibleRange();
    if (!f || !g || !vis) return;
    // extent: the sheet, the bite and the window
    let lo = Math.min(-g.contactLength, vis[0]);
    let hi = Math.max(0, vis[1]);
    for (let p = 0; p < f.flags.length; p++) {
      if (!(f.flags[p] & 1)) continue;
      const x = f.pos[2 * p];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    const pad = 0.02 * (hi - lo);
    this.lo = lo - pad;
    this.hi = hi + pad;
    const X = (x: number) => ((x - this.lo) / (this.hi - this.lo)) * W;
    // thickness: the entry thickness fills half the height
    const sy = (0.5 * H) / g.h0;
    const Y = (y: number) => H / 2 - y * sy;
    // outline of the sheet: top and bottom of the points in each column
    const top = new Float64Array(COLS).fill(-Infinity);
    const bot = new Float64Array(COLS).fill(Infinity);
    for (let p = 0; p < f.flags.length; p++) {
      if (!(f.flags[p] & 1)) continue;
      const c = Math.min(COLS - 1, Math.max(0, Math.floor(((f.pos[2 * p] - this.lo) / (this.hi - this.lo)) * COLS)));
      const y = f.pos[2 * p + 1];
      if (y > top[c]) top[c] = y;
      if (y < bot[c]) bot[c] = y;
      // half: the mirror image is the bottom
      if (g.halfThickness && -y < bot[c]) bot[c] = -y;
    }
    ctx.fillStyle = 'rgba(244,245,243,0.82)';
    ctx.fillRect(0, 0, W, H);
    // the outline through the columns that hold points (a column can fall between two of them)
    const cw = W / COLS;
    const cols: number[] = [];
    for (let c = 0; c < COLS; c++) if (top[c] >= bot[c]) cols.push(c);
    if (cols.length) {
      ctx.fillStyle = '#4b5a68';
      ctx.beginPath();
      ctx.moveTo(cols[0] * cw, Y(top[cols[0]]));
      for (const c of cols) ctx.lineTo((c + 0.5) * cw, Y(top[c]));
      ctx.lineTo((cols[cols.length - 1] + 1) * cw, Y(top[cols[cols.length - 1]]));
      ctx.lineTo((cols[cols.length - 1] + 1) * cw, Y(bot[cols[cols.length - 1]]));
      for (let i = cols.length - 1; i >= 0; i--) ctx.lineTo((cols[i] + 0.5) * cw, Y(bot[cols[i]]));
      ctx.lineTo(cols[0] * cw, Y(bot[cols[0]]));
      ctx.closePath();
      ctx.fill();
    }
    // the bite: entry and exit
    ctx.strokeStyle = '#8a949c';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    for (const x of [-g.contactLength, 0]) {
      ctx.beginPath();
      ctx.moveTo(X(x), 2);
      ctx.lineTo(X(x), H - 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // cracks
    ctx.fillStyle = '#c23b22';
    for (const k of f.cracks) ctx.fillRect(X(k.cx) - 1, Y(k.cy) - 3, 2, 6);
    // what the view shows
    ctx.strokeStyle = '#1d2a3a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(vis[0]), 1, Math.max(2, X(vis[1]) - X(vis[0])), H - 2);
  }
}
