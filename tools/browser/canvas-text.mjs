// Measuring text drawn on a 2D canvas, for the headless checks (a11y.mjs, export.mjs).
//
// FILL_TEXT_HOOK goes in before the page loads (Page.addScriptToEvaluateOnNewDocument): every fillText is recorded
// in window.__texts with its canvas (id, size), its box in the canvas's pixels and its colour. TEXT_CONTRAST defines
// window.__textContrast(data, width, height, box, fill, under): in the box, the ink is the colour the text was drawn
// in (over the ground, when it is translucent), the ground the colours of the other pixels that cover 5 % of them
// or more (a gradient gives a few), and r the lowest contrast (WCAG) of the ink with any of them; seen = the pixels
// near the ink (none: something was drawn over the words). data is the whole image's RGBA, under the colour behind
// its transparent pixels.

export const FILL_TEXT_HOOK = `(() => {
  const fill = CanvasRenderingContext2D.prototype.fillText;
  window.__texts = [];
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    const m = this.measureText(text);
    const t = this.getTransform();
    const xs = [x - m.actualBoundingBoxLeft, x + m.actualBoundingBoxRight], ys = [y - m.actualBoundingBoxAscent, y + m.actualBoundingBoxDescent];
    const pts = xs.flatMap((a) => ys.map((b) => t.transformPoint(new DOMPoint(a, b))));
    const box = [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))];
    window.__texts.push({ canvas: this.canvas.id || '', width: this.canvas.width, height: this.canvas.height, text: String(text), box, fill: String(this.fillStyle) });
    return maxWidth === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, maxWidth);
  };
})()`;

export const TEXT_CONTRAST = `window.__textContrast = (() => {
  const parse = (s) => {
    const h = /^#([0-9a-f]{6})$/i.exec(s);
    if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)).concat(1);
    const m = /rgba?\\(([^)]+)\\)/.exec(s);
    const v = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number);
    return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
  };
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (top, bot) => [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * (1 - top[3]));
  return (data, width, height, box, fill, under = [255, 255, 255]) => {
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(width, Math.ceil(box[2])), y1 = Math.min(height, Math.ceil(box[3]));
    if (x1 - x0 < 1 || y1 - y0 < 1) return { r: 0, seen: 0 };
    const px = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = 4 * (y * width + x);
      px.push(over([data[i], data[i + 1], data[i + 2], data[i + 3] / 255], under).map(Math.round));
    }
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 24;
    const common = (list) => {
      const count = new Map();
      for (const p of list) count.set(p.join(), (count.get(p.join()) || 0) + 1);
      return [...count.entries()].sort((a, b) => b[1] - a[1]);
    };
    const f = parse(fill);
    // the ink over the most common colour first (a translucent fill takes the colour under it), then the ground
    // among the pixels that are not the ink
    const first = common(px)[0][0].split(',').map(Number);
    const rest = px.filter((p) => !near(p, over(f, first)));
    const grounds = common(rest.length ? rest : px).filter(([, n], i) => i === 0 || n >= 0.05 * rest.length).map(([k]) => k.split(',').map(Number));
    let r = Infinity;
    for (const g of grounds) r = Math.min(r, ratio(over(f, g), g));
    const ink = over(f, grounds[0]);
    return { r, seen: px.filter((p) => near(p, ink)).length };
  };
})(); true`;
