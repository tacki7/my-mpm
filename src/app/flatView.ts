// 平坦度の形: the rolled strip laid on an inspection table under a raking light, its flatness drawn as the waves it
// takes free (src/mpm/solid/flatShape.ts: the pattern, whether it buckles past Shohet's limits, the steepness) —
// wavy edges, a centre buckle, quarter buckles, or a flat strip that holds the difference as residual stress. The light comes low
// along the strip, as an inspector holds a lamp to see shape: a flat strip shines evenly, a wave throws bands of
// light and shade. The heights are exaggerated by a stated factor (docs/design.md: an exaggeration always says so);
// the pitch is the viewer's (the flatness does not set it). Drag turns it, a double click puts it back, the arrow
// keys turn it when it has the focus. Drawn on a 2D canvas: the strip's faces as quads, farthest first.
import { FLAT_NAMES, flatShape, waveHeight, type FlatShape } from '../mpm/solid/flatShape.ts';

export interface FlatLook {
  /** turn about the vertical and tilt toward the viewer [rad] */
  yaw: number;
  tilt: number;
  /** the heights' exaggeration */
  scale: number;
  /** the waves' pitch over the strip's width */
  pitch: number;
  /** for reference: the waves the whole difference of elongation would make, the insensitive band ignored */
  latent: boolean;
}

export const FLAT_LOOK: FlatLook = { yaw: -0.55, tilt: 0.42, scale: 5, pitch: 1, latent: false };
/** the exaggerations and pitches offered */
export const FLAT_SCALES = [1, 2, 5, 10, 20];
export const FLAT_PITCHES = [0.5, 1, 2];

const PITCHES_SHOWN = 3;
const NX_PER_PITCH = 36;
const NZ = 28;
const INK = '#1d2a3a';
// the strip's steel, lit; the table a shade under the sheet
const STEEL: [number, number, number] = [168, 176, 183];
const SHINE: [number, number, number] = [244, 245, 243];
const TABLE: [number, number, number] = [214, 219, 216];

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// the lamp: low (about 30° up), from the strip's head end and a little from the side
const LIGHT = norm([-0.75, 0.5, 0.42]);

interface Quad {
  p: V3[];
  n: V3;
  kind: 'top' | 'side' | 'table';
}

export class FlatView {
  look: FlatLook = { ...FLAT_LOOK };
  private input: { exitZ: ArrayLike<number>; flatness: ArrayLike<number> } | null = null;
  /** the shape drawn (null before a steady reading) */
  shape: FlatShape | null = null;
  private halfWidth = 0;
  private thickness = 0;
  private note = '';
  private dragging: { x: number; y: number; yaw: number; tilt: number } | null = null;
  /** what the picture shows, in words (the canvas's aria-label and __mpm.solid.flat) */
  summary = '';

  private readonly canvas: HTMLCanvasElement;
  private readonly changed: () => void;

  constructor(canvas: HTMLCanvasElement, changed: () => void = () => {}) {
    this.canvas = canvas;
    this.changed = changed;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.dragging = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, tilt: this.look.tilt };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.turn(this.dragging.yaw + (e.clientX - this.dragging.x) * 0.01, this.dragging.tilt + (e.clientY - this.dragging.y) * 0.01);
    });
    const end = () => (this.dragging = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', () => this.turn(FLAT_LOOK.yaw, FLAT_LOOK.tilt));
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.3 : 0.08;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === '0') this.turn(FLAT_LOOK.yaw, FLAT_LOOK.tilt);
      else if (d[e.key]) this.turn(this.look.yaw + d[e.key][0], this.look.tilt + d[e.key][1]);
      else return;
      e.preventDefault();
    });
  }

  private turn(yaw: number, tilt: number): void {
    this.look.yaw = yaw;
    this.look.tilt = Math.max(0.05, Math.min(1.45, tilt));
    this.draw();
    this.changed();
  }

  /** the strip to draw: its steady flatness by column (steady.ts; null before a reading), exit half-width and thickness [m];
   *  `note` when there is none */
  set(input: { exitZ: ArrayLike<number>; flatness: ArrayLike<number> } | null, halfWidth: number, thickness: number, note = ''): void {
    this.input = input;
    this.halfWidth = halfWidth;
    this.thickness = thickness;
    this.note = note;
    this.reshape();
  }

  /** the shape again (the look's `latent` changed, or the input) and the picture */
  reshape(): void {
    const i = this.input;
    this.shape = i ? flatShape(i.exitZ, i.flatness, this.halfWidth, this.thickness, this.look.latent) : null;
    this.draw();
  }

  /** the strip's faces [mm]: the top and bottom surfaces, the edges and the ends, and the table under it */
  private quads(): { quads: Quad[]; low: number; len: number } {
    const s = this.shape!;
    const hw = this.halfWidth * 1e3;
    const t = this.thickness * 1e3;
    const p = 2 * hw * this.look.pitch;
    const len = PITCHES_SHOWN * p;
    const nx = PITCHES_SHOWN * NX_PER_PITCH;
    const k = this.look.scale;
    const y = (x: number, z: number) => k * waveHeight(s, x, z / hw, p);
    const grid: V3[][] = [];
    let low = 0;
    for (let i = 0; i <= nx; i++) {
      const row: V3[] = [];
      const x = (i / nx) * len - len / 2;
      for (let j = 0; j <= NZ; j++) {
        const z = -hw + (2 * hw * j) / NZ;
        const h = y(x + len / 2, z);
        low = Math.min(low, h);
        row.push([x, h, z]);
      }
      grid.push(row);
    }
    const up = (v: V3): V3 => [v[0], v[1] + t, v[2]];
    const quads: Quad[] = [];
    const face = (a: V3, b: V3, c: V3, d: V3, kind: Quad['kind']) => {
      const u: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const w: V3 = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
      const n = norm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
      quads.push({ p: [a, b, c, d], n, kind });
    };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < NZ; j++) {
        const [a, b, c, d] = [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]];
        face(up(a), up(b), up(c), up(d), 'top');
        face(a, d, c, b, 'top'); // the underside
      }
      // the edges: z = ±hw
      const [a0, b0] = [grid[i][0], grid[i + 1][0]];
      face(a0, up(a0), up(b0), b0, 'side');
      const [a1, b1] = [grid[i][NZ], grid[i + 1][NZ]];
      face(a1, b1, up(b1), up(a1), 'side');
    }
    // the ends: x = ±len / 2
    for (let j = 0; j < NZ; j++) {
      const [a, b] = [grid[0][j], grid[0][j + 1]];
      face(a, b, up(b), up(a), 'side');
      const [c, d] = [grid[nx][j], grid[nx][j + 1]];
      face(c, up(c), up(d), d, 'side');
    }
    return { quads, low, len };
  }

  draw(): void {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr);
    const H = Math.round(r.height * dpr);
    if (c.width !== W || c.height !== H) (c.width = W, c.height = H);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const s = this.shape;
    if (!s || !this.halfWidth) {
      this.summary = this.note || '定常の読みが出ると、出側の平坦度から板の波の形を描く';
      c.setAttribute('aria-label', this.summary);
      g.fillStyle = '#5f6b75';
      g.font = '12px "BIZ UDPGothic", sans-serif';
      g.textAlign = 'center';
      g.fillText(this.summary, r.width / 2, r.height / 2);
      return;
    }
    const { quads, low, len } = this.quads();
    const hw = this.halfWidth * 1e3;
    // the table: a plate under the strip's lowest point, a little larger than the strip
    const ty = low - 1e-3;
    const tx = len / 2 + hw * 0.6;
    const tz = hw * 1.9;
    const table: Quad = { p: [[-tx, ty, -tz], [-tx, ty, tz], [tx, ty, tz], [tx, ty, -tz]], n: [0, 1, 0], kind: 'table' };
    // the view: turn by yaw about y, tilt toward the viewer about the screen's x; orthographic
    const { yaw, tilt } = this.look;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const rot = (v: V3): V3 => {
      const x1 = cy * v[0] - sy * v[2];
      const z1 = sy * v[0] + cy * v[2];
      return [x1, ct * v[1] - st * z1, st * v[1] + ct * z1];
    };
    // the viewer's direction in the strip's frame (for the shine)
    const view: V3 = norm([sy * ct, st, cy * ct]);
    const half = norm([LIGHT[0] + view[0], LIGHT[1] + view[1], LIGHT[2] + view[2]]);
    // the words: what the strip shows and why, how it is drawn, on the sheet's colour
    const I = (v: number) => `${Math.round(v * 1e5).toLocaleString()} I`;
    const side = s.pattern === 'centre' ? '中伸び' : s.pattern === 'quarter' ? 'クォーター伸び' : '耳波';
    const limit = `${s.pattern === 'centre' || (s.pattern === 'quarter' && s.edge <= 0) ? '40' : '80'}(h/B)² = ${I(s.band)}`;
    const where = s.at >= 0.85 ? '（端）' : s.at <= 0.15 ? '（板幅の中央）' : `（中央から板幅の ${Math.round(s.at * 50)} % 外）`;
    let head: string;
    let why: string;
    if (this.look.latent) {
      head = `参考: 伸び差をそのまま波に（${side}の形、急峻度 最大 ${(s.steepness * 100).toFixed(2)} %${where}）`;
      why = `形状不感帯を無視し λ = (2/π)√Δε。判定は ${FLAT_NAMES[flatShape(this.input!.exitZ, this.input!.flatness, this.halfWidth, this.thickness)!.kind]}`;
    } else if (s.kind === 'flat') {
      head = FLAT_NAMES.flat;
      why =
        s.a === 0
          ? `伸び差 ${I(s.drive)}（${side}の形）。B/h = ${s.bh.toFixed(1)} < 50 では波にならない（残留応力で残る）`
          : `伸び差 ${I(s.drive)}（${side}の形）は形状不感帯 ${limit} の中（B/h = ${s.bh.toFixed(0)}）`;
    } else {
      head = `${FLAT_NAMES[s.kind]}　急峻度 λ = ${(s.steepness * 100).toFixed(2)} %${where}`;
      why = `伸び差 ${I(s.drive)} ＞ 限界 ${limit}。λ[%] = a√(Δε[%] − b)、a = ${s.a.toFixed(2)}（B/h = ${s.bh.toFixed(0)}）`;
    }
    const foot = `高さを ${this.look.scale} 倍に拡大。波のピッチは板幅の ${this.look.pitch} 倍、両端は同位相（ピッチと位相は模式）`;
    this.summary = `平坦度の形: ${head}。${why}。${foot}`;
    c.setAttribute('aria-label', this.summary);
    const whyLines = this.wrap(g, why, r.width - 16);
    const top = 52 + 18 * (whyLines.length - 1);
    // fit the table's corners into the canvas, a margin for the words
    const corners = table.p.map(rot);
    const xs = corners.map((v) => v[0]);
    const ys = corners.map((v) => v[1]);
    const sc = Math.min((r.width - 24) / (Math.max(...xs) - Math.min(...xs)), (r.height - top - 32) / (Math.max(...ys) - Math.min(...ys) + 2 * this.thickness * 1e3));
    const ox = r.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * sc;
    const oy = top + (r.height - top - 32) / 2 + ((Math.max(...ys) + Math.min(...ys)) / 2) * sc;
    const screen = (v: V3): [number, number, number] => {
      const q = rot(v);
      return [ox + q[0] * sc, oy - q[1] * sc, q[2]];
    };
    const shade = (q: Quad): string => {
      const n = rot(q.n)[2] >= 0 ? q.n : ([-q.n[0], -q.n[1], -q.n[2]] as V3);
      // wrapped a little: the slopes turned from the lamp still read, only darker
      const diffuse = Math.max(0, (dot(n, LIGHT) + 0.25) / 1.25);
      if (q.kind === 'table') {
        const k = 0.9 + 0.1 * diffuse;
        return `rgb(${TABLE.map((v) => Math.round(v * k)).join(',')})`;
      }
      const spec = Math.max(0, dot(n, half)) ** 36 * (q.kind === 'top' ? 0.7 : 0.15);
      const lit = q.kind === 'top' ? 0.38 + 0.72 * diffuse : 0.3 + 0.35 * diffuse;
      return `rgb(${STEEL.map((v, i) => Math.round(Math.min(255, v * lit + (SHINE[i] - v * lit) * spec))).join(',')})`;
    };
    // the table first, then the strip's faces that face the viewer, farthest first
    const drawn = [table, ...quads.filter((q) => rot(q.n)[2] > -1e-9)]
      .map((q) => ({ q, pts: q.p.map(screen) }))
      .map((d) => ({ ...d, depth: d.q.kind === 'table' ? -Infinity : d.pts.reduce((a, v) => a + v[2], 0) / 4 }))
      .sort((a, b) => a.depth - b.depth);
    g.lineJoin = 'round';
    for (const { q, pts } of drawn) {
      const col = shade(q);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillStyle = col;
      g.fill();
      // the same colour a hair wider: no seams between the quads
      g.strokeStyle = col;
      g.lineWidth = 0.6;
      g.stroke();
      if (q.kind === 'table') this.tableMarks(g, screen, tx, ty, tz, hw);
    }
    this.label(g, [head], 8, 8, true);
    this.label(g, whyLines, 8, 28, false);
    this.label(g, [foot], 8, r.height - 24, false);
  }

  /** the rolling direction on the table */
  private tableMarks(g: CanvasRenderingContext2D, screen: (v: V3) => [number, number, number], tx: number, ty: number, tz: number, hw: number): void {
    const a = screen([-tx * 0.55, ty, tz * 0.8]);
    const b = screen([tx * 0.55, ty, tz * 0.8]);
    g.strokeStyle = '#8a949c';
    g.fillStyle = '#5f6b75';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    g.beginPath();
    g.moveTo(b[0], b[1]);
    g.lineTo(b[0] - 7 * Math.cos(ang - 0.4), b[1] - 7 * Math.sin(ang - 0.4));
    g.lineTo(b[0] - 7 * Math.cos(ang + 0.4), b[1] - 7 * Math.sin(ang + 0.4));
    g.closePath();
    g.fill();
    g.font = '11px "BIZ UDPGothic", sans-serif';
    g.textAlign = 'left';
    const m = screen([tx * 0.2, ty, tz * 0.8 + hw * 0.1]);
    g.fillText('圧延方向', m[0] + 4, m[1] + 14);
  }

  /** lines of words on a backing, 18 px apart */
  private label(g: CanvasRenderingContext2D, lines: string[], x: number, y: number, strong: boolean): void {
    g.font = `${strong ? '700 ' : ''}12px "BIZ UDPGothic", sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    lines.forEach((text, i) => {
      const w = g.measureText(text).width;
      g.fillStyle = 'rgba(244, 245, 243, 0.9)';
      g.fillRect(x - 4, y + 18 * i - 3, w + 8, 18);
      g.fillStyle = INK;
      g.fillText(text, x, y + 18 * i);
    });
    g.textBaseline = 'alphabetic';
  }

  /** the words broken at 。 and 、 into lines no wider than `width` (the last break that fits; a piece that never fits stays whole) */
  private wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
    g.font = '12px "BIZ UDPGothic", sans-serif';
    const lines: string[] = [];
    let rest = text;
    while (g.measureText(rest).width > width) {
      let cut = -1;
      for (let i = 0; i < rest.length; i++) {
        if ((rest[i] === '。' || rest[i] === '、') && g.measureText(rest.slice(0, i + 1)).width <= width) cut = i + 1;
      }
      if (cut <= 0) break;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    lines.push(rest);
    return lines;
  }
}
