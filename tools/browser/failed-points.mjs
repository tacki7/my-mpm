// How failed points are drawn, in a headless Chrome: after a sheet breaks, its failed points are stretched, and drawn
// with their deformation gradient they would paint an ink band over their neighbours (T56, found taking the README
// pictures). The front tension, 1500 steps after the first crack, the view moved to the crack by a real click on the
// overview strip's mark; the section model with one field and with 'dfg':
// - the ink area is at most a few times the failed points' own cells (the number of failed points × the area of an
//   undeformed point on screen, from two lattice neighbours in the incoming strip)
// - the intact points stay visible: the points whose centre pixel is ink are hardly more than the failed points
// Before the fix (failed points drawn with their F) both fail: with one field the ink covered 104 times the failed
// points' cells and 63 times as many centres, with 'dfg' 28 and 7 times. The plan view keeps drawing failed points with
// F: their stretch stays under 1.5 there (Cockcroft-Latham 0.1, W 20 mm), and square cells left white seams in the band.
// Not a `@check` (it needs the dev server and Chrome). About 3 minutes.
//
//   CDP_PORT=<cdp> node tools/browser/failed-points.mjs <url> <shot prefix>
import { connect } from './cdp.mjs';
import { ok, between, done } from '../checks/lib.mjs';

const [target, prefix] = process.argv.slice(2);
if (!target || !prefix || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/failed-points.mjs <url> <shot prefix>');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};
const INK = [0x1d, 0x2a, 0x3a];

// the ink on a canvas: its area [CSS px²] within the rows [y0, y1] (the labels under the rolls are ink too), and
// which of the given screen points have an ink centre pixel
const inkOf = (c, canvasId, pts, y0, y1) =>
  c.evaluate(`(() => {
    const cv = document.getElementById(${JSON.stringify(canvasId)});
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const ink = (i) => Math.abs(d[i] - ${INK[0]}) <= 6 && Math.abs(d[i + 1] - ${INK[1]}) <= 6 && Math.abs(d[i + 2] - ${INK[2]}) <= 6 && d[i + 3] > 200;
    let area = 0;
    const r0 = Math.max(0, Math.floor((${y0} - r.top) * k)), r1 = Math.min(cv.height, Math.ceil((${y1} - r.top) * k));
    for (let y = r0; y < r1; y++) for (let x = 0; x < cv.width; x++) if (ink(4 * (y * cv.width + x))) area++;
    let centres = 0;
    for (const [sx, sy] of ${JSON.stringify(pts)}) {
      const x = Math.round((sx - r.left) * k), y = Math.round((sy - r.top) * k);
      if (x >= 0 && y >= 0 && x < cv.width && y < cv.height && ink(4 * (y * cv.width + x))) centres++;
    }
    return { area: area / (k * k), centres };
  })()`);

async function section(c, crack) {
  await c.navigate(page(`?preset=front-tension&field=damage&autorun=1&crack=${crack}`));
  await c.waitFor('__mpm.cracks.length > 0', 600000);
  const first = await c.evaluate('__mpm.cracks[0].step');
  await c.waitFor(`__mpm.diag.step >= ${first + 1500}`, 300000);
  await c.evaluate(`document.getElementById('pause').click()`);
  await c.waitFor('!__mpm.running && !__mpm.pressing', 20000);
  const mark = await c.evaluate(`(() => {
    const ov = document.getElementById('overview');
    const r = ov.getBoundingClientRect();
    const d = ov.getContext('2d').getImageData(0, 0, ov.width, ov.height).data;
    let sx = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 100 && d[i + 2] < 90 && d[i + 3] > 200) (sx += (i / 4) % ov.width), n++;
    return n ? { x: Math.round(r.left + ((sx / n) * r.width) / ov.width), y: Math.round(r.top + r.height / 2) } : null;
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: mark.x, y: mark.y, button: 'left', clickCount: 1 });
  await c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  // the points on screen, the failed count, and an undeformed point's cell on screen: points 0 / 1 are neighbours
  // across the thickness and 0 / NJ along x, at the tail (still before the entry)
  const s = await c.evaluate(`(() => {
    const b = document.getElementById('bite').getBoundingClientRect();
    const pts = [];
    let y0 = Infinity, y1 = -Infinity;
    for (let id = 0; ; id++) {
      const p = __mpm.screenOf(id);
      if (!p) break;
      if (p.x < b.left || p.x > b.right || p.y < b.top || p.y > b.bottom) continue;
      pts.push([p.x, p.y]);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const NJ = __mpm.params.numerics.cellsThrough * __mpm.params.numerics.ppc;
    const a = __mpm.screenOf(0), up = __mpm.screenOf(1), along = __mpm.screenOf(NJ);
    return { pts, y0: y0 - 20, y1: y1 + 20, cell: Math.abs(along.x - a.x) * Math.abs(up.y - a.y), failed: __mpm.diag.nFailed };
  })()`);
  const ink = await inkOf(c, 'bite', s.pts, s.y0, s.y1);
  await c.screenshot(`${prefix}-${crack}.png`);
  console.log(`shot  ${prefix}-${crack}.png`);
  const label = `front tension, crack=${crack}, 1500 steps after the first crack`;
  between(ink.area / (s.failed * s.cell), 0, 4, `${label}: the ink area over the failed points' own cells (${s.failed} failed, a cell ${s.cell.toFixed(1)} px²)`);
  between(ink.centres / s.failed, 0, 1.5, `${label}: points with an ink centre pixel over the failed points (${s.pts.length} points on screen)`);
}

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  await section(c, 'none');
  await section(c, 'dfg');
  ok(c.errors.length === 0, 'no exceptions or console errors', c.errors.join(' | '));
} finally {
  await c?.navigate('about:blank').catch(() => {});
  c?.close();
}
done();
