// Small line charts on canvas: the roll force over time, the contact tractions
// along the bite (the friction hill), and the fracture locus of the stress explorer.
// Lines break at non-finite values and are clipped to the plot area.
import { uiFont } from './font.ts';

export interface Series {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  label: string;
  dash?: number[];
  /** line width [px], 1.8 by default */
  width?: number;
}

export interface ChartSpec {
  xLabel: string;
  yLabel: string;
  series: Series[];
  /** vertical guide lines at these x values, with their labels */
  marks?: { x: number; label: string }[];
  /** horizontal guide lines at these y values, with their labels (at the right end) */
  hmarks?: { y: number; label: string }[];
  /** filled (or ringed) points on top of the lines */
  /** points; label: a short text written beside it (e.g. a tandem stand's number) */
  dots?: { x: number; y: number; color: string; r?: number; ring?: boolean; label?: string }[];
  xRange?: [number, number];
  yRange?: [number, number];
}

export function drawChart(canvas: HTMLCanvasElement, spec: ChartSpec): void {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(r.width));
  const H = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const L = 52;
  const Rm = 12;
  const Tm = 10;
  const B = 32;
  let [x0, x1] = spec.xRange ?? [Infinity, -Infinity];
  let [y0, y1] = spec.yRange ?? [Infinity, -Infinity];
  for (const s of spec.series) {
    for (let i = 0; i < s.x.length; i++) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) continue;
      if (!spec.xRange) {
        x0 = Math.min(x0, s.x[i]);
        x1 = Math.max(x1, s.x[i]);
      }
      if (!spec.yRange) {
        y0 = Math.min(y0, s.y[i]);
        y1 = Math.max(y1, s.y[i]);
      }
    }
  }
  if (!(x1 > x0)) [x0, x1] = [0, 1];
  if (!(y1 > y0)) [y0, y1] = [0, 1];
  if (!spec.yRange) {
    const pad = (y1 - y0) * 0.08;
    y0 = Math.min(0, y0 - pad);
    y1 += pad;
  }
  const X = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - Rm);
  const Y = (y: number) => H - B - ((y - y0) / (y1 - y0)) * (H - B - Tm);

  const ink = '#1d2a3a';
  ctx.font = uiFont(11);
  ctx.fillStyle = ink;
  ctx.strokeStyle = 'rgba(29,42,58,0.14)';
  ctx.lineWidth = 1;
  // grid and ticks
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ticks(y0, y1, 4)) {
    ctx.beginPath();
    ctx.moveTo(L, Y(v));
    ctx.lineTo(W - Rm, Y(v));
    ctx.stroke();
    ctx.fillText(fmt(v), L - 6, Y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of ticks(x0, x1, 5)) ctx.fillText(fmt(v), X(v), H - B + 4);
  ctx.fillStyle = 'rgba(29,42,58,0.7)';
  ctx.fillText(spec.xLabel, (L + W - Rm) / 2, H - 14);
  ctx.save();
  ctx.translate(12, (Tm + H - B) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.yLabel, 0, 0);
  ctx.restore();
  // zero line
  if (y0 < 0 && y1 > 0) {
    ctx.strokeStyle = 'rgba(29,42,58,0.45)';
    ctx.beginPath();
    ctx.moveTo(L, Y(0));
    ctx.lineTo(W - Rm, Y(0));
    ctx.stroke();
  }
  for (const m of spec.marks ?? []) {
    if (m.x < x0 || m.x > x1) continue;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(29,42,58,0.5)';
    ctx.beginPath();
    ctx.moveTo(X(m.x), Tm);
    ctx.lineTo(X(m.x), H - B);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, X(m.x), Tm);
  }
  for (const m of spec.hmarks ?? []) {
    if (m.y < y0 || m.y > y1) continue;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(29,42,58,0.5)';
    ctx.beginPath();
    ctx.moveTo(L, Y(m.y));
    ctx.lineTo(W - Rm, Y(m.y));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, W - Rm, Y(m.y) + 2);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, Tm, W - L - Rm, H - B - Tm);
  ctx.clip();
  for (const s of spec.series) {
    if (!s.x.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.8;
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < s.x.length; i++) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) {
        pen = false;
        continue;
      }
      const px = X(s.x[i]);
      const py = Y(s.y[i]);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const d of spec.dots ?? []) {
    ctx.beginPath();
    ctx.arc(X(d.x), Y(d.y), d.r ?? 3.5, 0, Math.PI * 2);
    if (d.ring) {
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = d.color;
      ctx.fill();
    }
    if (d.label) {
      ctx.fillStyle = d.color;
      ctx.font = uiFont(11, 600);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(d.label, X(d.x) + 5, Y(d.y) - 3);
    }
  }
  ctx.restore();
}

function ticks(a: number, b: number, n: number): number[] {
  const step = niceStep((b - a) / n);
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9 * step; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function niceStep(raw: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toPrecision(2);
}
