// The roll-bite view: rolls, the sheet as material points coloured by a field,
// failed points in ink, and a vermilion stamp where each crack started. Each
// point is drawn as the parallelogram its deformation gradient makes of its
// initial square, a little oversized so neighbours overlap (no seams). The view
// zooms and pans (viewControls.ts drives it); the thickness can be exaggerated.
import { css, lattice, split, temper, type Rgb } from './colormap.ts';
import { fieldInfo } from './fields.ts';
import { uiFont } from './font.ts';
import type { Frame, Geometry } from './protocol.ts';

const BINS = 48;
const PAD = 1; // px added around each point's cell so that neighbours overlap
const GLYPH = 18; // px between principal-direction glyphs

export type Exaggeration = 'auto' | 1 | 2 | 4;
const PRESS_MS = 420; // a crack's stamp is pressed onto the sheet in this time (no motion if reduced)
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export interface ViewState {
  /** thickness exaggeration in use (from exMode) */
  exaggeration: number;
  range: [number, number];
  /** 1: the default window, 3.4 contact lengths wide */
  zoom: number;
  /** world position of the centre of the canvas, from the default one [m] */
  panX: number;
  panY: number;
  /** auto: the sheet takes about 30 % of the height (at most 12×) */
  exMode: Exaggeration;
  /** draw the in-plane principal directions */
  dirs: boolean;
}

/**
 * Colour range of the frames' field over their active, unfailed points (or the field's fixed range):
 * symmetric about 0 for a signed field. Several frames (the stands of a tandem) share one range.
 */
export function fieldRange(frames: Frame[]): [number, number] {
  const info = fieldInfo(frames[0].field);
  if (info.range) return info.range;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of frames) {
    for (let p = 0; p < f.val.length; p++) {
      if ((f.flags[p] & 3) !== 1) continue;
      const v = f.val[p];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!(hi > lo)) {
    lo = 0;
    hi = 1;
  }
  if (info.scale === 'diverging') {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    return [-m, m];
  }
  return [Math.min(0, lo), hi];
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
  state: ViewState = { exaggeration: 1, range: [0, 1], zoom: 1, panX: 0, panY: 0, exMode: 'auto', dirs: false };
  /**
   * Tandem: the views of the stands share one scale, the first stand's (default window width and automatic
   * exaggeration), so the strip is seen getting thinner; and one colour range over all of them. null: own.
   */
  scaleFrom: Geometry | null = null;
  rangeOverride: [number, number] | null = null;
  private readonly canvas: HTMLCanvasElement;
  /** when each crack's stamp first appeared (key: id and time of the crack, so a new run starts over) */
  private readonly stampBorn = new Map<string, number>();

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

  /** width of the default window [m] */
  private baseWidth(): number {
    const g = this.scaleFrom ?? this.geometry!;
    return Math.max(3.4 * g.contactLength, 16 * g.h0);
  }

  /** world x at the centre of the default window: the bite sits a little left of it, the exit side shows more */
  private homeX(): number {
    return -this.geometry!.contactLength / 2 + this.baseWidth() * 0.08;
  }

  /** world → screen transform for the current geometry, zoom, pan and exaggeration */
  private transform() {
    const g = this.geometry!;
    const st = this.state;
    const sx = (this.w * st.zoom) / this.baseWidth();
    const x0 = this.homeX() + st.panX;
    const y0 = st.panY;
    const h0 = (this.scaleFrom ?? g).h0;
    const ez = st.exMode === 'auto' ? Math.min(12, Math.max(1, (0.3 * this.h) / (h0 * sx))) : st.exMode;
    const sy = sx * ez;
    const X = (x: number) => this.w / 2 + (x - x0) * sx;
    const Y = (y: number) => this.h / 2 - (y - y0) * sy;
    return { sx, sy, ez, X, Y, x0, y0 };
  }

  /** Zoom by `factor` keeping the point under (clientX, clientY) where it is. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    if (!this.geometry) return;
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left - this.w / 2;
    const py = clientY - r.top - this.h / 2;
    const T = this.transform();
    const wx = T.x0 + px / T.sx;
    const wy = T.y0 - py / T.sy;
    this.state.zoom = Math.min(80, Math.max(0.25, this.state.zoom * factor));
    const U = this.transform();
    this.state.panX = wx - px / U.sx - this.homeX();
    this.state.panY = wy + py / U.sy;
  }

  /** Zoom about the centre of the canvas. */
  zoomBy(factor: number): void {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.left + this.w / 2, r.top + this.h / 2, factor);
  }

  /** Move the picture by (dx, dy) screen pixels. */
  panBy(dx: number, dy: number): void {
    if (!this.geometry) return;
    const T = this.transform();
    this.state.panX -= dx / T.sx;
    this.state.panY += dy / T.sy;
  }

  /** Put world x at the centre of the canvas (keeps the zoom). */
  centerOn(x: number): void {
    if (this.geometry) this.state.panX = x - this.homeX();
  }

  /** Back to the default window. */
  resetView(): void {
    this.state.zoom = 1;
    this.state.panX = 0;
    this.state.panY = 0;
  }

  /** World x range shown on the canvas [m]. */
  visibleRange(): [number, number] | null {
    if (!this.geometry) return null;
    const T = this.transform();
    return [T.x0 - this.w / 2 / T.sx, T.x0 + this.w / 2 / T.sx];
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
      this.drawDirections(T, f);
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
    this.state.range = this.rangeOverride ?? fieldRange([f]);
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
    // half cell of the initial lattice, on screen
    const hx = 0.5 * g.dp * T.sx;
    const hy = 0.5 * g.dp * T.sy;
    const { pos, F } = f;
    const W = this.w;
    const rect = (p: number) => {
      const cx = T.X(pos[2 * p]);
      const cy = T.Y(pos[2 * p + 1]);
      if (cx < -40 || cx > W + 40) return;
      // images of the half edges (dp/2, 0) and (0, dp/2); screen y points down
      let ax = F[4 * p] * hx;
      let ay = -F[4 * p + 2] * hy;
      let bx = F[4 * p + 1] * hx;
      let by = -F[4 * p + 3] * hy;
      const ka = 1 + PAD / (Math.hypot(ax, ay) || 1);
      const kb = 1 + PAD / (Math.hypot(bx, by) || 1);
      ax *= ka;
      ay *= ka;
      bx *= kb;
      by *= kb;
      ctx.moveTo(cx + ax + bx, cy + ay + by);
      ctx.lineTo(cx - ax + bx, cy - ay + by);
      ctx.lineTo(cx - ax - bx, cy - ay - by);
      ctx.lineTo(cx + ax - bx, cy + ay - by);
      // no closePath(): fill() closes each subpath, and closePath() on a path of thousands of
      // subpaths made the redraw ten times slower (Chrome, 2026-09-19)
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

  /**
   * In-plane principal directions as small crosses, one per GLYPH px: the arm along σI and the one
   * along σII, copper in tension and blue in compression, longer for a larger |σ|. The directions go
   * through the same exaggeration as the picture.
   */
  private drawDirections(T: ReturnType<BiteView['transform']>, f: Frame): void {
    const d = f.dirs;
    if (!this.state.dirs || !d) return;
    const ctx = this.ctx;
    const n = f.flags.length;
    let smax = 0;
    for (let p = 0; p < n; p++) {
      if ((f.flags[p] & 3) !== 1) continue;
      smax = Math.max(smax, Math.abs(d[3 * p + 1]), Math.abs(d[3 * p + 2]));
    }
    if (!(smax > 0)) return;
    const cols = Math.ceil(this.w / GLYPH) + 1;
    const taken = new Set<number>();
    const tension = new Path2D();
    const compression = new Path2D();
    for (let p = 0; p < n; p++) {
      if ((f.flags[p] & 3) !== 1) continue;
      const cx = T.X(f.pos[2 * p]);
      const cy = T.Y(f.pos[2 * p + 1]);
      if (cx < 0 || cx > this.w || cy < 0 || cy > this.h) continue;
      const key = Math.floor(cy / GLYPH) * cols + Math.floor(cx / GLYPH);
      if (taken.has(key)) continue;
      taken.add(key);
      const th = d[3 * p];
      for (const [a, s] of [
        [th, d[3 * p + 1]],
        [th + Math.PI / 2, d[3 * p + 2]],
      ]) {
        let ux = Math.cos(a) * T.sx;
        let uy = -Math.sin(a) * T.sy;
        const l = Math.hypot(ux, uy) || 1;
        const half = 0.42 * GLYPH * (0.3 + (0.7 * Math.abs(s)) / smax);
        ux = (ux / l) * half;
        uy = (uy / l) * half;
        const path = s > 0 ? tension : compression;
        path.moveTo(cx - ux, cy - uy);
        path.lineTo(cx + ux, cy + uy);
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    // a light halo so the glyphs read on any colour of the field
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(244,245,243,0.75)';
    ctx.stroke(tension);
    ctx.stroke(compression);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#9c4a1c';
    ctx.stroke(tension);
    ctx.strokeStyle = '#1f3f7a';
    ctx.stroke(compression);
    ctx.restore();
  }

  /** Press every stamp again (headless checks capture the moment). */
  pressAgain(): void {
    const now = reducedMotion() ? performance.now() - PRESS_MS : performance.now();
    for (const k of this.stampBorn.keys()) this.stampBorn.set(k, now);
  }

  /** A stamp is being pressed: the page keeps redrawing until it has settled. */
  animating(): boolean {
    const now = performance.now();
    for (const t of this.stampBorn.values()) if (now - t < PRESS_MS) return true;
    return false;
  }

  /**
   * The inspection stamps. A new one is pressed: it comes down large and faint, lands with a
   * slight turn, and a ring of ink spreads from it once; then it stays, turned like the stamps of
   * the crack record.
   */
  private drawStamps(T: ReturnType<BiteView['transform']>, f: Frame): void {
    const ctx = this.ctx;
    const now = performance.now();
    const still = reducedMotion();
    ctx.save();
    for (const c of f.cracks) {
      const key = `${c.id}:${c.t}`;
      if (!this.stampBorn.has(key)) this.stampBorn.set(key, still ? now - PRESS_MS : now);
      const x = T.X(c.cx);
      const y = T.Y(c.cy);
      if (x < -30 || x > this.w + 30) continue;
      const k = Math.min(1, (now - this.stampBorn.get(key)!) / PRESS_MS);
      const down = 1 - (1 - k) * (1 - k) * (1 - k); // eases in to the sheet
      const scale = 1 + 0.9 * (1 - down);
      const turn = ((-8 - 14 * (1 - down)) * Math.PI) / 180;
      ctx.save();
      ctx.translate(x, y);
      if (k < 1 && k > 0.55) {
        // the ink spreading as it lands
        const s = (k - 0.55) / 0.45;
        ctx.strokeStyle = `rgba(194,59,34,${0.4 * (1 - s)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, 14 + 12 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.rotate(turn);
      ctx.scale(scale, scale);
      ctx.globalAlpha = 0.35 + 0.65 * down;
      ctx.strokeStyle = '#c23b22';
      ctx.fillStyle = 'rgba(194,59,34,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c23b22';
      ctx.font = uiFont(12, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.id + 1), 0, 0.5);
      ctx.restore();
    }
    ctx.restore();
  }
}
