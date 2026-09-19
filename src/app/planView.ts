// The plan view of the strip: rolling direction x to the right, the width z up, the half width the
// model solves mirrored about the mid-width so the whole strip shows. The roll contact is the band
// between the entry and the exit; points are coloured by the selected field, failed ones in ink,
// and each crack gets its number stamped in vermilion (docs/design.md: vermilion only for cracks).
import { css, split, temper } from './colormap.ts';
import { uiFont } from './font.ts';
import type { PlanFieldName, PlanFrame, PlanGeometry } from './planProtocol.ts';

export interface PlanFieldInfo {
  id: PlanFieldName;
  label: string;
  /** shorter name on the tab */
  tab?: string;
  unit: string;
  scale: 'sequential' | 'diverging';
  range?: [number, number];
}

export const PLAN_FIELDS: PlanFieldInfo[] = [
  { id: 'sxx', label: '圧延方向応力 σxx', tab: '圧延方向 σxx', unit: 'MPa', scale: 'diverging' },
  { id: 'szz', label: '板幅方向応力 σzz', tab: '板幅方向 σzz', unit: 'MPa', scale: 'diverging' },
  { id: 'seq', label: '相当応力 σeq', unit: 'MPa', scale: 'sequential' },
  { id: 'eta', label: '応力三軸度 η', unit: '', scale: 'diverging', range: [-1.5, 1.5] },
  { id: 'damage', label: '損傷 D', unit: '', scale: 'sequential', range: [0, 1] },
  { id: 'spread', label: '板幅方向の変位（外向き +）', tab: '幅広がり', unit: 'mm', scale: 'diverging' },
];

export const planFieldInfo = (id: PlanFieldName) => PLAN_FIELDS.find((f) => f.id === id) ?? PLAN_FIELDS[0];

const BINS = 48;
const PAD = 0.6; // px added around each point's cell so that neighbours overlap
const INK = '#1d2a3a';
const INK_SOFT = '#4b5a68';
const STAMP = '#c23b22';

export class PlanView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  geometry: PlanGeometry | null = null;
  frame: PlanFrame | null = null;
  /** colour range of the field last drawn */
  range: [number, number] = [0, 1];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** metres → CSS pixels: the whole width (with room for the spread) fits, the bite in the middle */
  private transform() {
    const g = this.geometry!;
    const top = 44; // under the toolbar-free top edge: the phase and the labels
    const bottom = 96; // above the legend
    const usable = Math.max(60, this.h - top - bottom);
    const zSpan = 2 * g.halfWidth0 * 1.2;
    let s = usable / zSpan;
    const xSpanMin = 3 * g.contactLength;
    if (this.w / s < xSpanMin) s = this.w / xSpanMin;
    const xMid = -0.5 * g.contactLength;
    const yMid = top + usable / 2;
    return { s, X: (x: number) => this.w / 2 + (x - xMid) * s, Y: (z: number) => yMid - z * s };
  }

  private colorOf(info: PlanFieldInfo): (v: number) => string {
    const [lo, hi] = this.range;
    if (info.scale === 'diverging') {
      const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return (v) => css(split(0.5 + (0.5 * v) / m));
    }
    const span = hi - lo || 1;
    return (v) => css(temper((v - lo) / span));
  }

  private updateRange(f: PlanFrame, info: PlanFieldInfo): void {
    if (info.range) {
      this.range = info.range;
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < f.val.length; p++) {
      if ((f.flags[p] & 3) !== 1) continue;
      const v = f.val[p];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) {
      lo = 0;
      hi = 1;
    }
    if (info.scale === 'diverging') {
      const m = Math.max(Math.abs(lo), Math.abs(hi));
      this.range = [-m, m];
    } else this.range = [Math.min(0, lo), hi];
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const g = this.geometry;
    const f = this.frame;
    if (!g) return;
    const T = this.transform();
    this.drawBite(T, g);
    if (f) {
      this.drawPoints(T, g, f);
      this.drawCracks(T, f);
    }
    this.drawNotes(T, g);
  }

  /** the roll contact, from the entry to the exit, across the whole picture */
  private drawBite(T: ReturnType<PlanView['transform']>, g: PlanGeometry): void {
    const ctx = this.ctx;
    const x0 = T.X(-g.contactLength);
    const x1 = T.X(0);
    const zTop = T.Y(g.halfWidth0 * 1.2);
    const zBot = T.Y(-g.halfWidth0 * 1.2);
    ctx.fillStyle = 'rgba(138,148,156,0.22)';
    ctx.fillRect(x0, zTop, x1 - x0, zBot - zTop);
    ctx.strokeStyle = 'rgba(29,42,58,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const x of [x0, x1]) {
      ctx.moveTo(x, zTop - 6);
      ctx.lineTo(x, zBot + 6);
    }
    // the mid-width
    ctx.moveTo(0, T.Y(0));
    ctx.lineTo(this.w, T.Y(0));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK;
    ctx.font = uiFont(12);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('入口', x0, zBot + 10);
    ctx.fillText('出口', x1, zBot + 10);
  }

  /** the notes on the picture: last, over the sheet, each on the sheet's colour (4.5:1 over anything under it) */
  private drawNotes(T: ReturnType<PlanView['transform']>, g: PlanGeometry): void {
    const ctx = this.ctx;
    ctx.font = uiFont(12);
    ctx.textBaseline = 'bottom';
    const note = (text: string, x: number, y: number, align: 'left' | 'right') => {
      const m = ctx.measureText(text);
      const left = align === 'right' ? x - m.width : x;
      ctx.fillStyle = 'rgba(244,245,243,0.9)';
      ctx.fillRect(left - 3, y - m.actualBoundingBoxAscent - 2, m.width + 6, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 4);
      ctx.textAlign = align;
      ctx.fillStyle = INK_SOFT;
      ctx.fillText(text, x, y);
    };
    note('ロールの接触', T.X(-g.contactLength) + 4, T.Y(g.halfWidth0 * 1.2) - 4, 'left');
    note('板幅の中央', this.w - 8, T.Y(0) - 3, 'right');
  }

  private drawPoints(T: ReturnType<PlanView['transform']>, g: PlanGeometry, f: PlanFrame): void {
    const ctx = this.ctx;
    const info = planFieldInfo(f.field);
    this.updateRange(f, info);
    const color = this.colorOf(info);
    const [lo, hi] = this.range;
    const span = hi - lo || 1;
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const buckets: number[][] = Array.from({ length: BINS }, () => []);
    const failed: number[] = [];
    const n = f.val.length;
    for (let p = 0; p < n; p++) {
      const fl = f.flags[p];
      if (!(fl & 1)) continue;
      if (fl & 2) {
        failed.push(p);
        continue;
      }
      const v = f.val[p];
      const t = info.scale === 'diverging' ? 0.5 + (0.5 * v) / m : (v - lo) / span;
      buckets[Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)))].push(p);
    }
    const hp = 0.5 * g.dp * T.s;
    const { pos, F } = f;
    const W = this.w;
    // a point's cell (F times the initial square), and its mirror image across the mid-width
    const quad = (p: number) => {
      const cx = T.X(pos[2 * p]);
      if (cx < -20 || cx > W + 20) return;
      const z = pos[2 * p + 1];
      let ax = F[4 * p] * hp;
      let ay = F[4 * p + 2] * hp;
      let bx = F[4 * p + 1] * hp;
      let by = F[4 * p + 3] * hp;
      const ka = 1 + PAD / (Math.hypot(ax, ay) || 1);
      const kb = 1 + PAD / (Math.hypot(bx, by) || 1);
      ax *= ka;
      ay *= ka;
      bx *= kb;
      by *= kb;
      for (const sgn of [1, -1]) {
        // screen y points down; the mirror flips z, so the images of the edges flip their z parts
        const cy = T.Y(sgn * z);
        const ay_ = -sgn * ay;
        const by_ = -sgn * by;
        ctx.moveTo(cx + ax + bx, cy + ay_ + by_);
        ctx.lineTo(cx - ax + bx, cy - ay_ + by_);
        ctx.lineTo(cx - ax - bx, cy - ay_ - by_);
        ctx.lineTo(cx + ax - bx, cy + ay_ - by_);
      }
    };
    for (let b = 0; b < BINS; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      const mid = (b + 0.5) / BINS;
      ctx.fillStyle = color(info.scale === 'diverging' ? (mid - 0.5) * 2 * m : lo + mid * span);
      ctx.beginPath();
      for (const p of list) quad(p);
      ctx.fill();
    }
    if (failed.length) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      for (const p of failed) quad(p);
      ctx.fill();
    }
  }

  /** the crack numbers, on the upper half (the lower half is its mirror image) */
  private drawCracks(T: ReturnType<PlanView['transform']>, f: PlanFrame): void {
    const ctx = this.ctx;
    for (const c of f.cracks) {
      const x = T.X(c.cx);
      const y = T.Y(c.cz);
      if (x < -20 || x > this.w + 20) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = STAMP;
      ctx.fillStyle = 'rgba(194,59,34,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = STAMP;
      ctx.font = uiFont(12, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.id + 1), 0, 0.5);
      ctx.restore();
    }
  }
}
