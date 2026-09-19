// The roll-bite view: rolls, the sheet as material points coloured by a field,
// failed points in ink, and a vermilion stamp where each crack started.
import { css, lattice, split, temper, type Rgb } from './colormap.ts';
import { fieldInfo } from './fields.ts';
import { uiFont } from './font.ts';
import type { Frame, Geometry } from './protocol.ts';

const BINS = 48;

export interface ViewState {
  /** screen x of world x = 0 is placed so that the bite sits left of centre */
  exaggeration: number;
  range: [number, number];
}

export class BiteView {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  geometry: Geometry | null = null;
  frame: Frame | null = null;
  /** points followed by the stress explorer, ringed on top of the sheet */
  marks: { id: number; kind: 'selected' | 'first-crack' | 'max-damage' }[] = [];
  state: ViewState = { exaggeration: 1, range: [0, 1] };
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** world → screen transform for the current geometry */
  private transform() {
    const g = this.geometry!;
    const Lc = g.contactLength;
    const worldW = Math.max(3.4 * Lc, 16 * g.h0);
    const sx = this.w / worldW;
    const x0 = -Lc / 2 + worldW * 0.08; // world x at the centre: the bite sits a little left of it, the exit side shows more
    const ez = Math.min(12, Math.max(1, (0.3 * this.h) / (g.h0 * sx)));
    const sy = sx * ez;
    const X = (x: number) => this.w / 2 + (x - x0) * sx;
    const Y = (y: number) => this.h / 2 - y * sy;
    return { sx, sy, ez, X, Y, x0 };
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const g = this.geometry;
    if (!g) return;
    const T = this.transform();
    this.state.exaggeration = T.ez;
    const f = this.frame;

    this.drawRolls(T, f ? f.diag.t : 0);
    this.drawPlanes(T);
    if (f) {
      this.drawParticles(T, f);
      this.drawStamps(T, f);
      this.drawMarks(T, f);
    }
  }

  /** The active point nearest to a click (client coordinates) within `radius` px, or −1. */
  pick(clientX: number, clientY: number, radius = 12): number {
    const f = this.frame;
    if (!f || !this.geometry) return -1;
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const T = this.transform();
    let best = -1;
    let bd = radius * radius;
    for (let p = 0; p < f.flags.length; p++) {
      if (!(f.flags[p] & 1)) continue;
      const dx = T.X(f.pos[2 * p]) - x;
      const dy = T.Y(f.pos[2 * p + 1]) - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Client coordinates of a point (headless checks click it), or null when nothing is drawn. */
  screenOf(p: number): { x: number; y: number } | null {
    const f = this.frame;
    if (!f || !this.geometry || p < 0 || p >= f.flags.length) return null;
    const r = this.canvas.getBoundingClientRect();
    const T = this.transform();
    return { x: r.left + T.X(f.pos[2 * p]), y: r.top + T.Y(f.pos[2 * p + 1]) };
  }

  private drawMarks(T: ReturnType<BiteView['transform']>, f: Frame): void {
    const ctx = this.ctx;
    ctx.save();
    for (const m of this.marks) {
      if (m.id < 0 || m.id >= f.flags.length || !(f.flags[m.id] & 1)) continue;
      const x = T.X(f.pos[2 * m.id]);
      const y = T.Y(f.pos[2 * m.id + 1]);
      ctx.beginPath();
      ctx.arc(x, y, m.kind === 'selected' ? 8 : 6, 0, Math.PI * 2);
      ctx.setLineDash(m.kind === 'max-damage' ? [3, 2] : []);
      ctx.lineWidth = 2;
      ctx.strokeStyle = m.kind === 'first-crack' ? '#c23b22' : m.kind === 'max-damage' ? '#8d5a33' : '#1d2a3a';
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRolls(T: ReturnType<BiteView['transform']>, t: number): void {
    const ctx = this.ctx;
    const g = this.geometry!;
    for (const r of g.rolls) {
      const cx = T.X(r.cx);
      const cy = T.Y(r.cy);
      const rx = r.R * T.sx;
      const ry = r.R * T.sy;
      const top = r.cy > 0;
      // polished steel: dark away from the bite, bright band near the surface
      const surf = top ? cy + ry : cy - ry;
      const grad = ctx.createLinearGradient(0, surf, 0, top ? surf - 90 : surf + 90);
      grad.addColorStop(0, '#9aa4ab');
      grad.addColorStop(0.08, '#e4e8ea');
      grad.addColorStop(0.22, '#aeb7bd');
      grad.addColorStop(1, '#6f7a82');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3d4a55';
      ctx.lineWidth = 1;
      ctx.stroke();
      // ticks that turn with the roll, so its rotation is visible
      const n = 180;
      ctx.strokeStyle = 'rgba(29,42,58,0.35)';
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r.omega * t;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const x1 = cx + rx * ca;
        const y1 = cy - ry * sa;
        if (x1 < -20 || x1 > this.w + 20 || y1 < -20 || y1 > this.h + 20) continue;
        // a fixed 8 px tick pointing at the centre
        const ux = cx - x1;
        const uy = cy - y1;
        const ul = Math.hypot(ux, uy) || 1;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + (8 * ux) / ul, y1 + (8 * uy) / ul);
      }
      ctx.stroke();
    }
  }

  private drawPlanes(T: ReturnType<BiteView['transform']>): void {
    const ctx = this.ctx;
    const g = this.geometry!;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(29,42,58,0.45)';
    ctx.lineWidth = 1;
    const yTop = T.Y(g.h0 * 0.9);
    const yBot = T.Y(-g.h0 * 0.9);
    for (const x of [-g.contactLength, 0]) {
      ctx.beginPath();
      ctx.moveTo(T.X(x), yTop);
      ctx.lineTo(T.X(x), yBot);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#1d2a3a';
    ctx.font = uiFont(12);
    ctx.textAlign = 'center';
    ctx.fillText('入口', T.X(-g.contactLength), yBot + 16);
    ctx.fillText('出口', T.X(0), yBot + 16);
  }

  private colorOf(): (v: number) => Rgb {
    const f = this.frame!;
    const info = fieldInfo(f.field);
    const [lo, hi] = this.state.range;
    if (info.scale === 'lattice') return (v) => lattice(v);
    if (info.scale === 'diverging') {
      const m = (info.flip ? -1 : 1) * (Math.max(Math.abs(lo), Math.abs(hi)) || 1);
      return (v) => split(0.5 + (0.5 * v) / m);
    }
    const span = hi - lo || 1;
    return (v) => temper((v - lo) / span);
  }

  /** Range of the field over the active, unfailed points (or its fixed range). */
  private updateRange(f: Frame): void {
    const info = fieldInfo(f.field);
    if (info.range) {
      this.state.range = info.range;
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
      this.state.range = [-m, m];
    } else this.state.range = [Math.min(0, lo), hi];
  }

  private drawParticles(T: ReturnType<BiteView['transform']>, f: Frame): void {
    const ctx = this.ctx;
    const g = this.geometry!;
    this.updateRange(f);
    const color = this.colorOf();
    const info = fieldInfo(f.field);
    const [lo, hi] = this.state.range;
    const span = hi - lo || 1;
    // a flipped field runs its diverging colours the other way
    const m = (info.flip ? -1 : 1) * (Math.max(Math.abs(lo), Math.abs(hi)) || 1);
    // bucket the points by colour: one fill per bucket
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
      let t: number;
      if (info.scale === 'diverging') t = 0.5 + (0.5 * v) / m;
      else t = (v - lo) / span;
      const b = Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
      buckets[b].push(p);
    }
    const dx = g.dp * T.sx;
    const dy = g.dp * T.sy;
    const rect = (p: number) => {
      const wx = Math.max(1, dx * f.ext[2 * p] * 1.04);
      const wy = Math.max(1, dy * f.ext[2 * p + 1] * 1.04);
      ctx.rect(T.X(f.pos[2 * p]) - wx / 2, T.Y(f.pos[2 * p + 1]) - wy / 2, wx, wy);
    };
    for (let b = 0; b < BINS; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      const mid = (b + 0.5) / BINS;
      const v = info.scale === 'diverging' ? (mid - 0.5) * 2 * m : lo + mid * span;
      ctx.fillStyle = css(color(v));
      ctx.beginPath();
      for (const p of list) rect(p);
      ctx.fill();
    }
    if (failed.length) {
      ctx.fillStyle = '#1d2a3a';
      ctx.beginPath();
      for (const p of failed) rect(p);
      ctx.fill();
    }
  }

  private drawStamps(T: ReturnType<BiteView['transform']>, f: Frame): void {
    const ctx = this.ctx;
    ctx.save();
    for (const c of f.cracks) {
      const x = T.X(c.cx);
      const y = T.Y(c.cy);
      if (x < -30 || x > this.w + 30) continue;
      ctx.strokeStyle = '#c23b22';
      ctx.fillStyle = 'rgba(194,59,34,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c23b22';
      ctx.font = uiFont(12, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.id + 1), x, y + 0.5);
    }
    ctx.restore();
  }
}
