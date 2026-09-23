// The three-dimensional picture: the strip's faces (the quarter the model solves, mirrored to the whole strip; with
// the whole thickness solved, the top and bottom faces as they are, mirrored across the mid-width only)
// between the two rolls, drawn on a 2D canvas as an axonometric drawing — parallel projection, the faces' cells
// filled far to near, the strip's outline in ink. The top roll is drawn over the strip as a ghost, so the bite
// stays visible; the bottom roll is solid steel under it.
import { css, split, temper, type Rgb } from './colormap.ts';
import { uiFont } from './font.ts';
import { SOLID_FIELD_IDS, type SolidFieldName, type SolidFrame, type SolidGeometry } from './solidProtocol.ts';
import type { Face } from '../mpm/solid/surface.ts';

export interface SolidFieldInfo {
  id: SolidFieldName;
  label: string;
  tab?: string;
  unit: string;
  scale: 'sequential' | 'diverging';
  range?: [number, number];
}

export const SOLID_FIELDS: SolidFieldInfo[] = [
  // a fixed bar, the same from run to run
  { id: 'seq', label: '相当応力 σeq', unit: 'MPa', scale: 'sequential', range: [0, 600] },
  { id: 'ep', label: '塑性ひずみ εp', unit: '', scale: 'sequential' },
  { id: 'pres', label: '静水圧 p（圧縮が正）', tab: '静水圧 p', unit: 'MPa', scale: 'diverging' },
  { id: 'eta', label: '応力三軸度 η', unit: '', scale: 'diverging', range: [-1.5, 1.5] },
  { id: 'sxx', label: '圧延方向の応力 σxx', tab: '圧延方向 σxx', unit: 'MPa', scale: 'diverging' },
  { id: 'syy', label: '板厚方向の応力 σyy', tab: '板厚方向 σyy', unit: 'MPa', scale: 'diverging' },
  { id: 'szz', label: '板幅方向の応力 σzz', tab: '板幅方向 σzz', unit: 'MPa', scale: 'diverging' },
  { id: 'damage', label: '損傷 D', unit: '', scale: 'sequential' },
  { id: 'spread', label: '板幅方向の変位（外向きが正）', tab: '幅広がり uz', unit: 'mm', scale: 'sequential' },
  { id: 'rate', label: '相当ひずみ速度（実機の速度）', tab: 'ひずみ速度', unit: '1/s', scale: 'sequential' },
];

export const solidFieldInfo = (id: SolidFieldName) => SOLID_FIELDS.find((f) => f.id === id) ?? SOLID_FIELDS[0];

/** a face's values of one field (a frame carries every field) */
export function faceValues(face: Face, field: SolidFieldName): Float32Array {
  const n = face.rows * face.cols;
  const q = Math.max(0, SOLID_FIELD_IDS.indexOf(field));
  return face.vals.subarray(q * n, (q + 1) * n);
}

export type ViewPreset = 'oblique' | 'top' | 'side' | 'front';

const DEG = Math.PI / 180;
const PRESETS: Record<ViewPreset, [number, number]> = {
  oblique: [-32 * DEG, 26 * DEG],
  top: [0, 90 * DEG],
  side: [0, 0],
  front: [-90 * DEG, 0],
};

const INK = '#1d2a3a';
/** the most cells along a side of a face that are drawn one by one */
const MAX_CELLS = 160;
const SHEET = '244,245,243';

export class SolidView {
  geometry: SolidGeometry | null = null;
  frame: SolidFrame | null = null;
  /** what the strip's faces are coloured by */
  field: SolidFieldName = 'seq';
  yaw = PRESETS.oblique[0];
  pitch = PRESETS.oblique[1];
  zoom = 1;
  /** pan [CSS px] */
  panX = 0;
  panY = 0;
  /** the pivot the drawing turns about, as an offset [m] from the picture's own centre (the bite, or the strip's
   *  middle): moved to whatever is at the middle of the canvas when the drawing is turned, so it turns about that */
  pivotOff: [number, number, number] = [0, 0, 0];
  /** show the far half only, cut open at the mid-width plane */
  cut = false;
  rolls = true;
  fit: 'bite' | 'strip' = 'bite';
  /** the thickness direction drawn this many times larger */
  yScale = 1;
  range: [number, number] = [0, 1];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** a fixed size [CSS px] for a canvas off the page (a video's frames), instead of the canvas' layout size */
  setSize(w: number, h: number, dpr = 1): void {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** the look of another view: its angles, zoom, pivot, cut, rolls, fit, y scale and field, and its pan scaled to this size */
  sameLook(v: SolidView): void {
    this.yaw = v.yaw;
    this.pitch = v.pitch;
    this.zoom = v.zoom;
    this.pivotOff = [...v.pivotOff];
    this.cut = v.cut;
    this.rolls = v.rolls;
    this.fit = v.fit;
    this.yScale = v.yScale;
    this.field = v.field;
    // the projection's scale is min(w, 1.7 h) / span (frameOf): the pan [px] follows it
    const k = Math.min(this.w, this.h * 1.7) / Math.min(v.w, v.h * 1.7);
    this.panX = v.panX * k;
    this.panY = v.panY * k;
  }

  setPreset(p: ViewPreset): void {
    [this.yaw, this.pitch] = PRESETS[p];
    this.panX = this.panY = 0;
    this.pivotOff = [0, 0, 0];
  }

  reset(): void {
    this.setPreset('oblique');
    this.zoom = 1;
  }

  /** the pivot in the strip's frame [m] */
  get pivot(): [number, number, number] {
    const { xMid } = this.frameOf();
    const o = this.pivotOff;
    return [xMid + o[0], o[1], o[2]];
  }

  /** Turn the drawing about what is at the middle of the canvas now. */
  rotate(dYaw: number, dPitch: number): void {
    this.recentre();
    this.yaw += dYaw;
    this.pitch = Math.min(90 * DEG, Math.max(0, this.pitch + dPitch));
  }

  /** Move the pivot to the point of the view plane at the middle of the canvas and drop the pan: the picture does
   *  not change (the pan is a shift in the view plane, and so is this move), only what it turns about. */
  private recentre(): void {
    if (!this.geometry || (this.panX === 0 && this.panY === 0)) return;
    const { s } = this.frameOf();
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    // in the turned frame the middle of the canvas is at (-panX/s, panY/s) with the pivot's depth
    const x1 = -this.panX / s;
    const a = this.panY / s;
    const Y = a * cp;
    const z1 = -a * sp;
    const X = x1 * cy + z1 * sy;
    const Z = -x1 * sy + z1 * cy;
    const o = this.pivotOff;
    this.pivotOff = [o[0] + X, o[1] + Y / this.yScale, o[2] + Z];
    this.panX = this.panY = 0;
  }

  /** the strip's x range on show (the bite when nothing is drawn yet) */
  private stripSpan(): [number, number] {
    const g = this.geometry!;
    let lo = -g.contactLength;
    let hi = 0;
    const top = this.frame?.faces.find((f) => f.name === 'top');
    if (top) {
      for (let v = 0; v < top.rows * top.cols; v++) {
        const x = top.pos[3 * v];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    return [lo, hi];
  }

  /** the picture's own centre [m] along the strip and its scale [px/m]: the bite (following the head on its way
   *  to the rolls), or the whole strip */
  private frameOf(): { xMid: number; s: number } {
    const g = this.geometry!;
    const W = 2 * g.halfWidth0;
    let xMid = -0.5 * g.contactLength;
    // what must fit: the bite with some strip on both sides, or the whole strip
    let span = Math.max(2.4 * W, 4.5 * g.contactLength, 8 * g.h0);
    if (this.fit === 'bite' && this.frame) {
      // on its way to the rolls the strip's head is what to look at: the picture follows it up to the bite
      const head = this.stripSpan()[1];
      xMid = Math.min(xMid, head - 0.12 * span);
    }
    if (this.fit === 'strip') {
      const [lo, hi] = this.stripSpan();
      xMid = (lo + hi) / 2;
      span = Math.max(span, (hi - lo) * 1.08);
    }
    const s = (Math.min(this.w, this.h * 1.7) / span) * this.zoom;
    return { xMid, s };
  }

  /** world [m] → CSS px and depth (larger is nearer) */
  private projector() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const ys = this.yScale;
    const { s } = this.frameOf();
    const [px, py, pz] = this.pivot;
    const ox = this.w / 2 + this.panX;
    const oy = this.h / 2 + 8 + this.panY;
    return (x: number, y: number, z0: number, out: Float64Array) => {
      const X = x - px;
      const Y = (y - py) * ys;
      const z = z0 - pz;
      const x1 = X * cy - z * sy;
      const z1 = X * sy + z * cy;
      out[0] = ox + x1 * s;
      out[1] = oy - (Y * cp - z1 * sp) * s;
      out[2] = Y * sp + z1 * cp;
    };
  }

  private updateRange(f: SolidFrame, info: SolidFieldInfo): void {
    if (info.range) {
      this.range = info.range;
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const face of f.faces) {
      const val = faceValues(face, this.field);
      for (let v = 0; v < val.length; v++) {
        if (Number.isNaN(face.pos[3 * v]) || face.failed[v]) continue;
        const x = val[v];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
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
    if (!g) return;
    const project = this.projector();
    if (this.rolls) this.drawRoll(project, -1);
    if (this.frame) this.drawStrip(project, this.frame);
    this.drawMarks(project);
    if (this.frame) this.drawTracks(project, this.frame);
    if (this.rolls) this.drawRoll(project, 1);
    this.drawTriad();
  }

  // ── the strip ──────────────────────────────────────────────────────────────
  private drawStrip(project: (x: number, y: number, z: number, out: Float64Array) => void, f: SolidFrame): void {
    const ctx = this.ctx;
    const info = solidFieldInfo(this.field);
    this.updateRange(f, info);
    const [lo, hi] = this.range;
    const span = hi - lo || 1;
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const colour = (v: number): Rgb => (info.scale === 'diverging' ? split(0.5 + (0.5 * v) / m) : temper((v - lo) / span));

    // the faces the viewer sees: the outward normal (in the strip's frame) turned to the view must face the viewer
    const tmp = new Float64Array(3);
    const zero = new Float64Array(3);
    project(0, 0, 0, zero);
    const facing = (nx: number, ny: number, nz: number): boolean => {
      project(nx, ny / this.yScale, nz, tmp);
      return tmp[2] - zero[2] > 1e-9;
    };
    // [face, mirror y, mirror z, shade]
    const shown: [Face, number, number, number][] = [];
    const byName = (n: Face['name']) => f.faces.find((x) => x.name === n)!;
    const zSides = this.cut ? [-1] : [1, -1];
    // the whole thickness solved: the bottom face is its own, nothing is mirrored across y
    const full = this.geometry?.fullThickness === true;
    const ySides = full ? [1] : [1, -1];
    for (const sz of zSides) {
      if (facing(0, 1, 0)) shown.push([byName('top'), 1, sz, 1]);
      if (facing(0, -1, 0)) shown.push([full ? byName('bottom') : byName('top'), full ? 1 : -1, sz, 0.8]);
      for (const sy of ySides) {
        if (facing(0, 0, sz)) shown.push([byName('edge'), sy, sz, 0.9]);
        if (facing(1, 0, 0)) shown.push([byName('head'), sy, sz, 0.84]);
        if (facing(-1, 0, 0)) shown.push([byName('tail'), sy, sz, 0.84]);
      }
    }
    if (this.cut && facing(0, 0, 1)) for (const sy of ySides) shown.push([byName('cut'), sy, -1, 0.95]);

    let total = 0;
    for (const [face] of shown) total += (face.rows - 1) * (face.cols - 1);
    const xy = new Float32Array(8 * total);
    const depth = new Float32Array(total);
    const fill: string[] = new Array(total);
    let q = 0;
    const pr = new Float64Array(3);
    for (const [face, sy, sz, shade] of shown) {
      const { rows, cols, pos, failed } = face;
      const val = faceValues(face, this.field);
      // project the face's vertices once
      const sx2 = new Float32Array(rows * cols);
      const sy2 = new Float32Array(rows * cols);
      const sd = new Float32Array(rows * cols);
      for (let v = 0; v < rows * cols; v++) {
        if (Number.isNaN(pos[3 * v])) {
          sx2[v] = NaN;
          continue;
        }
        project(pos[3 * v], sy * pos[3 * v + 1], sz * pos[3 * v + 2], pr);
        sx2[v] = pr[0];
        sy2[v] = pr[1];
        sd[v] = pr[2];
      }
      // a wide strip has more cells than the picture has pixels for: at most MAX_CELLS a side are drawn (every
      // n-th vertex; the last cell of a side is the shorter one)
      const dr = Math.ceil((rows - 1) / MAX_CELLS);
      const dc = Math.ceil((cols - 1) / MAX_CELLS);
      for (let r = 0; r < rows - 1; r += dr) {
        const r1 = Math.min(rows - 1, r + dr);
        for (let c = 0; c < cols - 1; c += dc) {
          const c1 = Math.min(cols - 1, c + dc);
          const a = r * cols + c;
          const b = r * cols + c1;
          const d = r1 * cols + c;
          const e = r1 * cols + c1;
          if (Number.isNaN(sx2[a]) || Number.isNaN(sx2[b]) || Number.isNaN(sx2[d]) || Number.isNaN(sx2[e])) continue;
          const o = 8 * q;
          xy[o] = sx2[a];
          xy[o + 1] = sy2[a];
          xy[o + 2] = sx2[b];
          xy[o + 3] = sy2[b];
          xy[o + 4] = sx2[e];
          xy[o + 5] = sy2[e];
          xy[o + 6] = sx2[d];
          xy[o + 7] = sy2[d];
          depth[q] = 0.25 * (sd[a] + sd[b] + sd[d] + sd[e]);
          if (failed[a] || failed[b] || failed[d] || failed[e]) fill[q] = INK;
          else {
            const rgb = colour(0.25 * (val[a] + val[b] + val[d] + val[e]));
            fill[q] = css([rgb[0] * shade, rgb[1] * shade, rgb[2] * shade]);
          }
          q++;
        }
      }
    }
    const order = new Uint32Array(q);
    for (let i = 0; i < q; i++) order[i] = i;
    order.sort((i, j) => depth[i] - depth[j]);
    // a hair of the same colour around each cell closes the seams between neighbours
    ctx.lineWidth = 0.75;
    ctx.lineJoin = 'round';
    for (let n = 0; n < q; n++) {
      const o = 8 * order[n];
      ctx.beginPath();
      ctx.moveTo(xy[o], xy[o + 1]);
      ctx.lineTo(xy[o + 2], xy[o + 3]);
      ctx.lineTo(xy[o + 4], xy[o + 5]);
      ctx.lineTo(xy[o + 6], xy[o + 7]);
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle = fill[order[n]];
      ctx.fill();
      ctx.stroke();
    }
    // the drawing's ink: the outline of every face on show
    ctx.strokeStyle = 'rgba(29,42,58,0.7)';
    ctx.lineWidth = 1;
    for (const [face, sy, sz] of shown) this.outline(project, face, sy, sz);
  }

  private outline(project: (x: number, y: number, z: number, out: Float64Array) => void, face: Face, sy: number, sz: number): void {
    const ctx = this.ctx;
    const { rows, cols, pos } = face;
    const pr = new Float64Array(3);
    const line = (index: (k: number) => number, count: number) => {
      // a line on a plane of symmetry is the seam between the quarter and its mirror image, not an edge of the strip:
      // (the mid-width plane is one once the strip is cut open there)
      let onY = true;
      let onZ = true;
      for (let k = 0; k < count; k++) {
        const v = index(k);
        if (Number.isNaN(pos[3 * v])) continue;
        if (Math.abs(pos[3 * v + 1]) > 1e-12) onY = false;
        if (Math.abs(pos[3 * v + 2]) > 1e-12) onZ = false;
      }
      // drawn dotted: where the solved quarter meets its mirror image (across y only when the top half is what is solved)
      const seam = (onY && this.geometry?.fullThickness !== true) || (onZ && !this.cut);
      ctx.setLineDash(seam ? [2, 3] : []);
      let pen = false;
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const v = index(k);
        if (Number.isNaN(pos[3 * v])) {
          pen = false;
          continue;
        }
        project(pos[3 * v], sy * pos[3 * v + 1], sz * pos[3 * v + 2], pr);
        if (pen) ctx.lineTo(pr[0], pr[1]);
        else ctx.moveTo(pr[0], pr[1]);
        pen = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line((k) => k, cols);
    line((k) => (rows - 1) * cols + k, cols);
    line((k) => k * cols, rows);
    line((k) => k * cols + cols - 1, rows);
  }

  // ── the rolls ──────────────────────────────────────────────────────────────
  /** side +1: the top roll, a ghost over the strip; −1: the bottom roll, solid, under it */
  private drawRoll(project: (x: number, y: number, z: number, out: Float64Array) => void, side: number): void {
    const ctx = this.ctx;
    const g = this.geometry!;
    const R = g.rollRadius;
    const cyRoll = side * (R + g.gap / 2);
    // the barrel is wider than the strip; of the roll only the arc over the bite and a little more is drawn
    const half = g.halfWidth0 * 1.3 + g.h0;
    const reach = Math.min(R * 0.6, g.contactLength * 1.7 + 2 * g.h0);
    const phiMax = Math.asin(reach / R);
    const N = 18;
    const pr = new Float64Array(3);
    const pt = (phi: number, z: number): [number, number] => {
      project(R * Math.sin(phi), cyRoll - side * R * Math.cos(phi), z, pr);
      return [pr[0], pr[1]];
    };
    ctx.save();
    const ghost = side > 0;
    // the barrel's arc, shaded along it
    for (let k = 0; k < N; k++) {
      const p0 = -phiMax + (2 * phiMax * k) / N;
      const p1 = -phiMax + (2 * phiMax * (k + 1)) / N;
      const a = pt(p0, -half);
      const b = pt(p1, -half);
      const c = pt(p1, half);
      const d = pt(p0, half);
      const light = 0.5 + 0.5 * Math.cos((p0 + p1) / 2 + 0.5);
      const v = Math.round(111 + 60 * light);
      ctx.fillStyle = ghost ? `rgba(${v},${v + 8},${v + 14},0.2)` : `rgb(${v},${v + 8},${v + 14})`;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(d[0], d[1]);
      ctx.closePath();
      ctx.fill();
      if (!ghost) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }
    // generators that turn with the roll: the rolling is seen
    const t = this.frame?.diag.t ?? 0;
    const turn = ((1 / R) * t * 1) % (4 * DEG); // surface speed 1 m/s over R
    ctx.strokeStyle = ghost ? 'rgba(29,42,58,0.22)' : 'rgba(29,42,58,0.28)';
    ctx.lineWidth = 1;
    for (let phi = -phiMax + ((turn + phiMax) % (4 * DEG)); phi < phiMax; phi += 4 * DEG) {
      const a = pt(phi, -half);
      const b = pt(phi, half);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    // the two end arcs and the arc's two ends, in ink
    ctx.strokeStyle = ghost ? 'rgba(29,42,58,0.55)' : 'rgba(29,42,58,0.6)';
    ctx.lineWidth = 1.2;
    for (const z of [-half, half]) {
      ctx.beginPath();
      for (let k = 0; k <= N; k++) {
        const [x, y] = pt(-phiMax + (2 * phiMax * k) / N, z);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── marks ──────────────────────────────────────────────────────────────────
  private drawMarks(project: (x: number, y: number, z: number, out: Float64Array) => void): void {
    const ctx = this.ctx;
    const g = this.geometry!;
    const half = g.halfWidth0 * 1.3 + g.h0;
    const pr = new Float64Array(3);
    ctx.save();
    ctx.font = uiFont(12);
    ctx.textBaseline = 'middle';
    for (const [x, label] of [
      [-g.contactLength, '入口'],
      [0, '出口'],
    ] as [number, string][]) {
      project(x, 0, -half, pr);
      const ax = pr[0];
      const ay = pr[1];
      project(x, 0, half, pr);
      ctx.strokeStyle = 'rgba(29,42,58,0.5)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(pr[0], pr[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      // the label at the end nearer the viewer (the lower one on the screen), on a sheet-coloured chip
      let [lx, ly] = pr[1] > ay ? [pr[0], pr[1]] : [ax, ay];
      // kept on the picture, above the legend: slid back along the line when its end is outside
      const yMax = this.h - 120;
      if (ly > yMax && Math.abs(pr[1] - ay) > 1) {
        const k = (yMax - ay) / (pr[1] - ay);
        lx = ax + (pr[0] - ax) * k;
        ly = yMax;
      }
      const wText = ctx.measureText(label).width;
      ctx.fillStyle = `rgba(${SHEET},0.9)`;
      ctx.fillRect(lx - wText / 2 - 5, ly + 4, wText + 10, 18);
      ctx.fillStyle = INK;
      ctx.fillText(label, lx - wText / 2, ly + 13.5);
    }
    ctx.restore();
  }

  /** The mirror images of a solved point that the picture shows: itself and its image across the mid-width plane,
   *  or the far image alone once the strip is cut open there. */
  private mirrors(): number[] {
    return this.cut ? [-1] : [1, -1];
  }

  /** the followed points: a red dashed ring around the first crack, a brown dotted one around the most damaged point */
  private drawTracks(project: (x: number, y: number, z: number, out: Float64Array) => void, f: SolidFrame): void {
    const ctx = this.ctx;
    const pr = new Float64Array(3);
    ctx.save();
    ctx.lineWidth = 2;
    for (const t of f.tracks) {
      const crack = t.role === 'first-crack';
      ctx.strokeStyle = crack ? '#c23b22' : '#8d5a33';
      ctx.setLineDash(crack ? [4, 3] : [2, 2]);
      for (const sz of this.mirrors()) {
        project(t.state.x, t.state.y, sz * (t.state.z ?? 0), pr);
        ctx.beginPath();
        ctx.arc(pr[0], pr[1], crack ? 9 : 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Client coordinates of a followed point's ring (headless checks look there), or null when none is drawn. */
  screenOf(role: SolidFrame['tracks'][number]['role']): { x: number; y: number } | null {
    const t = this.frame?.tracks.find((k) => k.role === role);
    if (!t || !this.geometry) return null;
    const r = this.canvas.getBoundingClientRect();
    const pr = new Float64Array(3);
    this.projector()(t.state.x, t.state.y, this.mirrors()[0] * (t.state.z ?? 0), pr);
    return { x: r.left + pr[0], y: r.top + pr[1] };
  }

  /** Client coordinates of a point of the strip's frame [m] (headless checks read it), or null when nothing is drawn. */
  screenOfPoint(x: number, y: number, z: number): { x: number; y: number } | null {
    if (!this.geometry) return null;
    const r = this.canvas.getBoundingClientRect();
    const pr = new Float64Array(3);
    this.projector()(x, y, z, pr);
    return { x: r.left + pr[0], y: r.top + pr[1] };
  }

  /** which way the axes point, bottom left (above the legend) */
  private drawTriad(): void {
    const ctx = this.ctx;
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const ox = this.w - 74;
    const oy = this.h - 64;
    const L = 30;
    const axes: [number, number, number, string][] = [
      [1, 0, 0, '圧延方向 x'],
      [0, 1, 0, '板厚 y'],
      [0, 0, 1, '板幅 z'],
    ];
    ctx.save();
    ctx.font = uiFont(11);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${SHEET},0.9)`;
    ctx.fillRect(ox - 62, oy - 46, 132, 92);
    for (const [x, y, z, label] of axes) {
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      const ex = ox + x1 * L;
      const ey = oy - (y * cp - z1 * sp) * L;
      // an axis pointing at the viewer has no direction to show
      if (Math.hypot(ex - ox, ey - oy) < 0.25 * L) continue;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = INK;
      const wText = ctx.measureText(label).width;
      const tx = ex + (ex >= ox ? 4 : -4 - wText);
      ctx.fillText(label, Math.max(ox - 60, Math.min(ox + 68 - wText, tx)), ey + (ey > oy ? 8 : -8));
    }
    ctx.restore();
  }
}
