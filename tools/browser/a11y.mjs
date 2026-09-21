// Accessibility and the UI basics on the page, in a headless Chrome, with WCAG 2.2 AA as the yardstick:
// the keyboard alone goes round the page (the conditions, the run, the colour tabs, the roll bite, the view tools,
// the handles, the stress state and the export), a radio group is one Tab stop that the arrow keys move, every stop
// has a name and a focus ring that nothing covers and that stands out from what is around it, the results tables
// say which cells are headers, the status line is rewritten only when its words change (a screen reader may read
// every rewrite), text has 4.5:1 (3:1 when large) against what is under it — on the roll-bite picture, the canvas
// pixels under its box, and text drawn on the plan view's canvas against the pixels around it — in the section
// view, a tandem of five stands and the plan view, Enter on the roll bite chooses the point in the middle of the
// view, the handles take the mouse 12 px wide while drawn 1 px, the view tools stay clear of the status line and
// are 24 px tall at 700 and 400 px, the preset's note opens by a real button, and a crack's stamp does not move
// when the viewer asks for less motion.
// Not a `@check` (it needs the dev server and Chrome). About 20 s.
//
//   CDP_PORT=<cdp> node tools/browser/a11y.mjs <url> [shot-prefix]
//
// <url> is the page, e.g. http://localhost:<dev>/ (its query is replaced).
import { connect } from './cdp.mjs';
import { ok, done } from '../checks/lib.mjs';
import { DAMAGE_4340 } from '../../src/mpm/params.ts';
import { FILL_TEXT_HOOK, TEXT_CONTRAST } from './canvas-text.mjs';

const [target, prefix] = process.argv.slice(2);
if (!target || !process.env.CDP_PORT) {
  console.error('usage: CDP_PORT=<cdp> node tools/browser/a11y.mjs <url> [shot-prefix]');
  process.exit(64);
}
const page = (q) => {
  const u = new URL(target);
  u.search = q;
  return u.href;
};

// in the page: WCAG's contrast, the colour behind an element, and the text below AA
const LIB = `window.__a11y = (() => {
  const parse = (s) => { const h = /^#([0-9a-f]{6})$/i.exec(s); if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)).concat(1); const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const v = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1); };
  // the backgrounds of the element and its ancestors, composited down to the first opaque one
  const backdrop = (e) => {
    const stack = [];
    for (let x = e; x; x = x.parentElement) { const b = parse(getComputedStyle(x).backgroundColor); if (b && b[3] > 0) { stack.push(b); if (b[3] >= 1) break; } }
    let bg = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
    return bg;
  };
  const opacity = (e) => { let o = 1; for (let x = e; x; x = x.parentElement) o *= +getComputedStyle(x).opacity; return o; };
  const need = (s) => { const px = parseFloat(s.fontSize); return px >= 24 || (+s.fontWeight >= 700 && px >= 18.66) ? 3 : 4.5; };
  const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' "' + e.textContent.trim().slice(0, 16) + '"';
  const textElements = (root) => {
    const out = new Set();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // (text for screen readers only is not seen)
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.textContent.trim() && t.parentElement.checkVisibility({ visibilityProperty: true }) && !t.parentElement.closest('.sr-only')) out.add(t.parentElement);
    return [...out];
  };
  // text on CSS backgrounds (not over the roll-bite pictures; disabled controls are exempt in WCAG)
  const lowText = (root = document.body) => textElements(root).filter((e) => !e.closest('.bite') && !e.closest(':disabled')).map((e) => {
    const s = getComputedStyle(e); const bg = backdrop(e); const c = parse(s.color);
    const fg = over([c[0], c[1], c[2], c[3] * opacity(e)], bg);
    return { what: label(e), r: ratio(fg, bg), need: need(s) };
  }).filter((x) => x.r < x.need);
  // text laid over a roll-bite picture: against every canvas pixel under its box, with its own background on top
  const overPicture = () => {
    const cvs = [...document.querySelectorAll('.bite canvas')].filter((e) => e.checkVisibility() && !e.classList.contains('overview'));
    return textElements(document.body).filter((e) => e.closest('.bite')).map((e) => {
      let own = null;
      for (let x = e; x && !x.classList.contains('bite'); x = x.parentElement) { const b = parse(getComputedStyle(x).backgroundColor); if (b && b[3] > 0) { own = b; break; } }
      const s = getComputedStyle(e); const fg = parse(s.color); const b = e.getBoundingClientRect();
      let worst = Infinity;
      for (const cv of cvs) {
        const cb = cv.getBoundingClientRect();
        const x0 = Math.max(b.x, cb.x), x1 = Math.min(b.right, cb.right), y0 = Math.max(b.y, cb.y), y1 = Math.min(b.bottom, cb.bottom);
        if (x1 - x0 < 1 || y1 - y0 < 1) continue;
        const sx = cv.width / cb.width, sy = cv.height / cb.height;
        const px = cv.getContext('2d').getImageData(Math.floor((x0 - cb.x) * sx), Math.floor((y0 - cb.y) * sy), Math.max(1, Math.floor((x1 - x0) * sx)), Math.max(1, Math.floor((y1 - y0) * sy))).data;
        const under = backdrop(cv.parentElement);
        for (let i = 0; i < px.length; i += 4) {
          let p = over([px[i], px[i + 1], px[i + 2], px[i + 3] / 255], under);
          if (own) p = over(own, p);
          worst = Math.min(worst, ratio(fg, p));
        }
      }
      return { what: label(e), r: worst, need: need(s) };
    }).filter((x) => Number.isFinite(x.r));
  };
  // text drawn on a canvas (recorded by the fillText hook, for the last draw): canvas-text.mjs
  const canvasText = (id) => (window.__texts || []).filter((t) => t.canvas === id).map((t) => {
    const cv = document.getElementById(id);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    return { text: t.text, ...window.__textContrast(d, cv.width, cv.height, t.box, t.fill, backdrop(cv.parentElement)) };
  });
  return { parse, ratio, backdrop, lowText, overPicture, canvasText };
})(); true`;

const FOCUS = [44, 74, 140]; // --focus #2c4a8c

let c;
try {
  c = await connect(process.env.CDP_PORT);
  await c.setViewport(1600, 1000);
  await c.send('Accessibility.enable');
  // every fillText on a 2D canvas, with its box (so that text drawn on a canvas can be measured): canvas-text.mjs
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FILL_TEXT_HOOK });
  const painted = () => c.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  const open = async (q, wait) => {
    await c.navigate(page(q));
    await c.evaluate(LIB);
    await c.evaluate(TEXT_CONTRAST);
    if (wait) await c.waitFor(wait, 180000);
    await painted();
  };
  const key = async (k, shift = false) => {
    const code = { Tab: 9, Enter: 13, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 }[k];
    const name = k === ' ' ? 'Space' : k;
    const m = shift ? 8 : 0;
    // Enter and Space also type a character, as a real key does
    const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined;
    await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, modifiers: m, text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: m });
  };
  // the element with the focus, and the name Chrome computes for it
  const active = async () => {
    const info = await c.evaluate(`(() => { const e = document.activeElement; if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      return { tag: e.tagName.toLowerCase(), id: e.id, role: e.getAttribute('role'), group: e.closest('[role=radiogroup]')?.id || e.closest('[role=radiogroup]')?.getAttribute('aria-label') || null,
        field: e.dataset.field ?? null, checked: e.getAttribute('aria-checked'), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
    })()`);
    if (!info) return null;
    const { result } = await c.send('Runtime.evaluate', { expression: 'document.activeElement' });
    const { nodes } = await c.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
    info.text = (nodes[0]?.name?.value ?? '').trim();
    return info;
  };
  // the keyboard's way round: Tab from the top of the page until the focus comes back to the first stop
  const walk = async () => {
    await c.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0); true');
    const stops = [];
    for (let k = 0; k < 200; k++) {
      await key('Tab');
      const a = await active();
      if (!a) break;
      if (stops.length && a.tag === stops[0].tag && a.id === stops[0].id && a.text === stops[0].text && a.field === stops[0].field) break;
      stops.push(a);
    }
    return stops;
  };
  // the accessible names Chrome computes for everything that takes the focus
  const unnamed = async () => {
    const { nodes } = await c.send('Accessibility.getFullAXTree');
    return nodes
      .filter((n) => !n.ignored && n.properties?.some((p) => p.name === 'focusable' && p.value.value) && !(n.name?.value ?? '').trim() && n.role?.value !== 'RootWebArea')
      .map((n) => n.role?.value);
  };
  // the focus ring of the element with the focus, from a screenshot around it: on each side, the share of the side
  // that has the ring colour within 5 px of the edge, and the ring's contrast with what is just outside it
  const ring = async () => {
    const b = await c.evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const pad = 10;
    const clip = { x: Math.max(0, Math.floor(b.x - pad)), y: Math.max(0, Math.floor(b.y - pad)), width: Math.ceil(b.w + 2 * pad), height: Math.ceil(b.h + 2 * pad), scale: 1 };
    const shot = await c.send('Page.captureScreenshot', { format: 'png', clip });
    return c.evaluate(`new Promise((done) => {
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        const at = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return null; const i = 4 * (y * cv.width + x); return [d[i], d[i + 1], d[i + 2], 1]; };
        const isRing = (p) => p && Math.hypot(p[0] - ${FOCUS[0]}, p[1] - ${FOCUS[1]}, p[2] - ${FOCUS[2]}) < 40;
        const L = { x: ${b.x} - ${clip.x}, y: ${b.y} - ${clip.y}, w: ${b.w}, h: ${b.h} };
        // a line across each side, from 5 px inside the box to 5 px outside it (a ring may sit on either side of the edge)
        const sides = {
          top: (t) => [L.x + t * L.w, L.y, 0, -1], bottom: (t) => [L.x + t * L.w, L.y + L.h - 1, 0, 1],
          left: (t) => [L.x, L.y + t * L.h, -1, 0], right: (t) => [L.x + L.w - 1, L.y + t * L.h, 1, 0],
        };
        const out = {};
        for (const [name, f] of Object.entries(sides)) {
          let hit = 0, n = 0; const contrasts = [];
          for (let t = 0.1; t <= 0.9001; t += 0.02) {
            n++;
            const [x0, y0, dx, dy] = f(t);
            let outer = null;
            for (let s = -5; s <= 5; s++) if (isRing(at(x0 + dx * s, y0 + dy * s))) outer = s;
            if (outer == null) continue;
            hit++;
            const beyond = at(x0 + dx * (outer + 1), y0 + dy * (outer + 1));
            if (beyond) contrasts.push(__a11y.ratio([${FOCUS}], beyond));
          }
          contrasts.sort((a, b) => a - b);
          out[name] = { cover: hit / n, outside: contrasts.length ? contrasts[Math.floor(contrasts.length / 2)] : null };
        }
        done(out);
      };
      im.src = 'data:image/png;base64,${shot.data}';
    })`);
  };
  const f2 = (x) => (x == null ? '—' : x.toFixed(2));
  const sidesText = (r) => Object.entries(r).map(([k, v]) => `${k} ${(v.cover * 100).toFixed(0)} % / ${f2(v.outside)}`).join(', ');

  // ── the section view: a run, watching the status line's rewrites
  await open('?cells=6&L=8', 'window.__mpm?.ready');
  await c.evaluate(`(() => {
    const e = document.getElementById('phase');
    window.__phase = { writes: 0, changes: 0, last: e.textContent };
    new MutationObserver((ms) => { window.__phase.writes++; if (e.textContent !== window.__phase.last) { window.__phase.changes++; window.__phase.last = e.textContent; } })
      .observe(e, { childList: true, characterData: true, subtree: true });
    // the charts' words for a screen reader, how often they are written
    window.__summary = [...document.querySelectorAll('.charts figure .chart-summary')].map((e) => {
      const rec = { writes: 0 };
      new MutationObserver(() => rec.writes++).observe(e, { childList: true, characterData: true, subtree: true });
      return rec;
    });
    return true;
  })()`);
  await c.evaluate("document.getElementById('run').click(); true");
  await c.waitFor('__mpm.done', 180000);
  await painted();
  const ph = await c.evaluate('window.__phase');
  ok(ph.changes >= 3 && ph.writes <= ph.changes, 'the status line (aria-live) is rewritten only when its words change', `${ph.writes} rewrites for ${ph.changes} changes over ${await c.evaluate('__mpm.frames')} frames`);
  // each chart has a few words for a screen reader, from the page's own numbers, written when the steady reading
  // came and at the end of the pass only
  const sum = await c.evaluate(`(() => {
    const t = [...document.querySelectorAll('.stage .charts figure')].map((f) => f.querySelector('.chart-summary')?.textContent ?? null);
    const s = __mpm.slab, h = __mpm.hill.steady, e = __mpm.explorer;
    const pt = __mpm.tracks.find((k) => k.role === e.role);
    return { t, writes: (window.__summary || []).map((r) => r.writes), load: (s.steadyForce * 1e-6).toFixed(2) + ' kN/mm', ratio: s.ratio?.toFixed(2), peak: h ? (Math.max(...h.p) * 1e-6).toFixed(0) + ' MPa' : null, eta: pt ? pt.state.eta.toFixed(3) : null };
  })()`);
  ok(sum.t.length === 3 && sum.t.every((x) => x?.startsWith('（パスの終わり）')) && sum.t[0].includes(sum.load) && sum.t[0].includes(`比 ${sum.ratio}`) && sum.t[1].includes(sum.peak) && sum.t[2].includes(`η ${sum.eta}`),
    "each chart has words for a screen reader from the page's numbers (steady load and the slab ratio, the hill's peak, the point shown)", sum.t.map((x) => (x ?? '—').slice(0, 60)).join(' | '));
  ok(sum.writes.length === 3 && sum.writes.every((n) => n >= 1 && n <= 2), "the charts' words are written when the steady reading comes and at the end only", `writes ${sum.writes.join(' / ')}`);

  // ── the keyboard alone
  const stops = await walk();
  const names = stops.map((s) => s.text);
  const at = (t) => names.findIndex((n) => n.startsWith(t));
  const order = ['断面', '平面図', '条件を反映してやり直す', '入側板厚', 'ロールバイト。', '拡大', '損傷最大', '荷重の推移（CSV）', '条件の URL をコピー'].map(at);
  ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'Tab alone goes round the page: view switch → conditions → colour tabs → roll bite → view tools → stress state → export', `${stops.length} stops, at ${order.join(' / ')}`);
  const inGroup = (g) => stops.filter((s) => s.role === 'radio' && s.group === g);
  const tabs = inGroup('field-tabs');
  ok(tabs.length === 1 && tabs[0].checked === 'true', 'the colour tabs (a radio group) are one Tab stop, the checked tab', `${tabs.length} stops: ${tabs.map((s) => s.text).join(' / ')}`);
  ok(stops.every((s) => s.text), 'every Tab stop has a name', names.filter((n) => !n).length + ' without');
  const noName = await unnamed();
  ok(noName.length === 0, 'Chrome computes a name for everything that takes the focus', noName.join(', '));
  const bare = stops.filter((s) => !s.outline && s.id !== 'bite');
  ok(bare.length === 0, 'every Tab stop draws a 2 px outline when focused by the keyboard', bare.map((s) => s.text).join(', '));

  // the arrow keys move the colour tab (and Home / End go to the ends); the legend follows
  const legendField = () => c.evaluate(`document.getElementById('legend').dataset.field`);
  await c.evaluate(`document.querySelector('#field-tabs [aria-checked="true"]').focus(); true`);
  const f0 = await legendField();
  await key('ArrowRight');
  await c.waitFor(`document.getElementById('legend').dataset.field !== ${JSON.stringify(f0)}`, 3000).catch(() => {});
  const a1 = await active();
  const f1 = await legendField();
  await key('End');
  const aEnd = await active();
  await key('Home');
  const aHome = await active();
  await key('ArrowLeft');
  const aWrap = await active();
  const allTabs = await c.evaluate(`[...document.querySelectorAll('#field-tabs [role=radio]')].map((b) => b.dataset.field)`);
  ok(
    a1?.field === allTabs[1] && a1.checked === 'true' && f1 === allTabs[1] && f0 === allTabs[0] && aEnd?.field === allTabs.at(-1) && aHome?.field === allTabs[0] && aWrap?.field === allTabs.at(-1),
    'the arrow keys choose the next colour tab and take the focus there; Home and End go to the ends, ← from the first wraps',
    `→ ${a1?.field} (legend ${f0} → ${f1}), End ${aEnd?.field}, Home ${aHome?.field}, ← ${aWrap?.field}`,
  );
  await key('Home');

  // the focus rings that sit on the picture: the roll bite's own and the view tools' (a real Tab onto each)
  const tabOnto = async (sel) => {
    await c.evaluate(`document.querySelector(${JSON.stringify(sel)}).focus(); true`);
    await key('Tab', true);
    await key('Tab');
    return active();
  };
  const onBite = await tabOnto('#bite');
  const rb = onBite?.id === 'bite' ? await ring() : null;
  ok(rb && Object.values(rb).every((v) => v.cover >= 0.9 && v.outside >= 3), "the roll bite's focus ring shows on all four sides (the handles beside it do not cover it), 3:1 against what is outside it", rb ? sidesText(rb) : `focus on ${onBite?.text}`);
  const onTool = await tabOnto('#view-tools button');
  const rt = onTool?.text === '拡大' ? await ring() : null;
  ok(rt && Object.values(rt).every((v) => v.cover >= 0.9 && v.outside >= 3), 'the view tools\' focus ring stands out from the roll under it (3:1)', rt ? sidesText(rt) : `focus on ${onTool?.text}`);
  const rs = (await tabOnto('.split-left'))?.role === 'separator' ? await ring() : null;
  ok(rs && rs.left.cover >= 0.9 && rs.right.cover >= 0.9, "a handle's focus ring shows along its length", rs ? sidesText(rs) : '');

  // choosing a point with the keyboard: Enter (or Space) on the focused roll bite takes the point nearest the middle
  // of the view, as a click on it would; the arrows pan, and Enter takes the new middle's point
  const nearest = () =>
    c.evaluate(`(() => {
      const r = document.getElementById('bite').getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      let id = -1, d = Infinity;
      for (let p = 0; ; p++) { const s = __mpm.screenOf(p); if (!s) break; const e = Math.hypot(s.x - cx, s.y - cy); if (e < d) { d = e; id = p; } }
      return { id, d };
    })()`);
  await tabOnto('#bite');
  const aim = await c.evaluate(`(() => { const a = document.querySelector('.pick-aim'); if (!a) return null; const r = a.getBoundingClientRect(), b = document.getElementById('bite').getBoundingClientRect(); return { shown: a.checkVisibility(), text: a.textContent, dx: r.x - (b.x + b.width / 2), dy: r.y - (b.y + b.height / 2) }; })()`);
  ok(aim?.shown && aim.text.includes('Enter') && Math.abs(aim.dx) < 1 && Math.abs(aim.dy) < 1, 'with the roll bite focused, a mark in its middle says that Enter chooses the point there', JSON.stringify(aim));
  const picks = [];
  // after the pass the sheet is on the exit side: the view goes right along it
  for (const [press, pans] of [['Enter', []], ['Enter', ['ArrowRight', 'ArrowRight']], [' ', ['ArrowRight', 'ArrowRight', 'ArrowDown']]]) {
    for (const k of pans) await key(k);
    const want = await nearest();
    await key(press);
    await c.waitFor(`__mpm.explorer?.role === 'selected' && __mpm.explorer.id === ${want.id}`, 5000).catch(() => {});
    picks.push({ key: press === ' ' ? 'Space' : press, want: want.id, got: (await c.evaluate('__mpm.explorer'))?.id });
  }
  const said = await c.evaluate(`[...document.querySelectorAll('.bite [aria-live]')].map((e) => e.textContent).join(' / ')`);
  ok(picks.every((p) => p.want >= 0 && p.got === p.want) && new Set(picks.map((p) => p.got)).size === 3 && (await active())?.id === 'bite',
    'Enter or Space chooses the point nearest the middle of the view as 選んだ点 (again after the arrows move the view); the focus stays', picks.map((p) => `${p.key} ${p.got} (nearest ${p.want})`).join(', '));
  ok(said.includes('選んだ'), 'the choice is said (aria-live)', said.slice(0, 80));
  const blurred = await c.evaluate(`(() => { document.getElementById('bite').blur(); const a = document.querySelector('.pick-aim'); return a ? a.checkVisibility() : false; })()`);
  ok(!blurred, 'the mark goes when the roll bite loses the focus');

  // the handles take the mouse 12 px wide, drawn 1 px; the left one keeps clear of the conditions pane (its scrollbar)
  const hits = await c.evaluate(`[...document.querySelectorAll('.splitter')].filter((e) => e.checkVisibility()).map((e) => {
    const r = e.getBoundingClientRect(); const across = r.height > r.width;
    let n = 0;
    for (let s = -12; s <= 18; s++) {
      const x = across ? r.x + s + 0.5 : r.x + r.width / 2, y = across ? r.y + r.height / 2 : r.y + s + 0.5;
      if (document.elementFromPoint(x, y) === e) n++;
    }
    const line = getComputedStyle(e, '::after'); const drawn = across ? line.width : line.height;
    const left = e.classList.contains('split-left') ? document.elementFromPoint(r.x - 1, r.y + r.height / 2)?.closest('.conditions') != null : true;
    return { size: e.dataset.size, n, drawn, left };
  })`);
  ok(hits.length === 5 && hits.every((h) => h.n >= 12 && h.n <= 14 && h.drawn === '1px' && h.left), 'each handle takes the mouse 12 px across while its line stays 1 px; the left one leaves the conditions pane its edge', hits.map((h) => `${h.size} ${h.n} px (${h.drawn})`).join(', '));

  // headers and contrast
  const scopes = await c.evaluate(`['results', 'explorer-state'].map((id) => [id, [...document.querySelectorAll('#' + id + ' th')].filter((h) => !h.getAttribute('scope')).length, document.querySelectorAll('#' + id + ' th').length])`);
  ok(scopes.every(([, bare, n]) => n > 0 && bare === 0), "the results tables' header cells say what they head (scope)", scopes.map(([id, bare, n]) => `${id} ${n - bare} / ${n}`).join(', '));
  const low = await c.evaluate('__a11y.lowText()');
  ok(low.length === 0, 'text on the page has 4.5:1 (3:1 when large) against its background', low.map((x) => `${x.what} ${f2(x.r)}`).join(', '));
  const pic = await c.evaluate('__a11y.overPicture()');
  const lowPic = pic.filter((x) => x.r < x.need);
  ok(pic.length >= 4 && lowPic.length === 0, 'text on the roll-bite picture (status line, legend, scale note) has 4.5:1 against every pixel under it', lowPic.length ? lowPic.map((x) => `${x.what} ${f2(x.r)}`).join(', ') : `${pic.length} texts, lowest ${f2(Math.min(...pic.map((x) => x.r)))}`);
  const marker = await c.evaluate(`(() => { const s = document.querySelector('.group.fold summary'); return __a11y.ratio(__a11y.parse(getComputedStyle(s, '::marker').color), __a11y.backdrop(s)); })()`);
  ok(marker >= 3, "the folded groups' ▸ marker (a control's state, non-text) has 3:1", f2(marker));
  if (prefix) console.log(`shot  ${await c.screenshot(`${prefix}-section.png`)}`);

  // ── a tandem of five stands: the stands' colours as text, and the stand numbers on the picture
  await open('?stands=5&cells=4&L=4&autorun=1', '__mpm.standResults.length >= 1');
  const stand = await c.evaluate(`(() => {
    const ths = [...document.querySelectorAll('#stand-results thead th')];
    const paper = __a11y.backdrop(document.querySelector('.charts figure'));
    return ths.map((h) => { const col = __a11y.parse(getComputedStyle(h).color); return { k: h.textContent.trim(), table: __a11y.ratio(col, __a11y.backdrop(h)), charts: __a11y.ratio(col, paper) }; });
  })()`);
  ok(stand.length === 5 && stand.every((s) => s.table >= 4.5 && s.charts >= 4.5), "the five stands' colours have 4.5:1 as text, on the stand table and on the charts (the load paths' numbers)", stand.map((s) => `${s.k} ${f2(s.table)} / ${f2(s.charts)}`).join(', '));
  const labels = (await c.evaluate('__a11y.overPicture()')).filter((x) => x.what.includes('stand-label'));
  ok(labels.length === 5 && labels.every((x) => x.r >= x.need), 'the stand numbers on the pictures have 4.5:1 against every pixel under them', labels.map((x) => `${x.what.split('"')[1]} ${f2(x.r)}`).join(', '));
  if (prefix) console.log(`shot  ${await c.screenshot(`${prefix}-tandem.png`)}`);
  await c.navigate('about:blank');

  // ── the plan view: its tabs, the provisional values, its table's headers and its status line
  await open('?view=plan&cells=6&L=8', '__mpm.plan.active && __mpm.plan.ready');
  await c.evaluate(`(() => {
    const e = document.getElementById('plan-phase');
    window.__phase = { writes: 0, changes: 0, last: e.textContent };
    new MutationObserver(() => { window.__phase.writes++; if (e.textContent !== window.__phase.last) { window.__phase.changes++; window.__phase.last = e.textContent; } })
      .observe(e, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  await c.evaluate("document.getElementById('run').click(); true");
  // 8 mm has no steady window in the plan view: the last look stays shown faint to the end
  await c.waitFor('__mpm.plan.done', 120000);
  await painted();
  const pph = await c.evaluate('window.__phase');
  ok(pph.writes <= pph.changes, "the plan view's status line is rewritten only when its words change", `${pph.writes} rewrites for ${pph.changes} changes over ${await c.evaluate('__mpm.plan.frames')} frames`);
  const prov = await c.evaluate(`__a11y.lowText(document.getElementById('plan-results'))`);
  const provN = await c.evaluate(`document.querySelectorAll('#plan-results tr.provisional').length`);
  ok(provN > 0 && prov.length === 0, 'the last look shown faint until the steady values come still has 4.5:1', `${provN} rows faint; ${prov.map((x) => `${x.what} ${f2(x.r)}`).join(', ')}`);
  const pscope = await c.evaluate(`[[...document.querySelectorAll('#plan-results th')].filter((h) => !h.getAttribute('scope')).length, document.querySelectorAll('#plan-results th').length]`);
  ok(pscope[1] > 0 && pscope[0] === 0, "the plan view's results table says its header cells' scope", `${pscope[1] - pscope[0]} / ${pscope[1]}`);
  const pstops = await walk();
  const ptabs = pstops.filter((s) => s.role === 'radio' && s.group === 'plan-tabs');
  ok(ptabs.length === 1 && ptabs[0].checked === 'true', "the plan view's colour tabs are one Tab stop, the checked tab", `${ptabs.length} stops`);
  const plow = await c.evaluate('__a11y.lowText()');
  ok(plow.length === 0, 'text in the plan view has 4.5:1 against its background', plow.map((x) => `${x.what} ${f2(x.r)}`).join(', '));
  // the words drawn on the plan view's canvas (one draw of the frame shown, recorded by the fillText hook)
  await c.evaluate('window.__texts.length = 0; __mpm.plan.drawMs(1); true');
  const ptext = await c.evaluate(`__a11y.canvasText('plan-canvas')`);
  ok(ptext.length >= 4 && ptext.every((t) => t.r >= 4.5 && t.seen >= 3), "the words on the plan view's picture (ロールの接触, 板幅の中央, 入口, 出口) show, 4.5:1 against what is around them", ptext.map((t) => `${t.text} ${f2(t.r)}${t.seen < 3 ? ' (covered)' : ''}`).join(', '));
  await c.navigate('about:blank');

  // ── narrow screens: no sideways scroll, the view tools clear of the status line and 24 px tall
  for (const w of [700, 400]) {
    await c.setViewport(w, 900);
    await open('?cells=6&L=8&autorun=1&stopafter=3000', '__mpm.diag?.step >= 3000 && !__mpm.running');
    const n = await c.evaluate(`(() => {
      const ph = document.getElementById('phase').getBoundingClientRect();
      const tools = [...document.querySelectorAll('#view-tools button, #view-tools select, #view-tools label')];
      const cross = tools.filter((t) => { const r = t.getBoundingClientRect(); return Math.min(r.right, ph.right) - Math.max(r.x, ph.x) > 0 && Math.min(r.bottom, ph.bottom) - Math.max(r.y, ph.y) > 0; });
      return { scroll: document.documentElement.scrollWidth - innerWidth, cross: cross.map((t) => t.textContent.trim().slice(0, 10)), phase: document.getElementById('phase').textContent,
        small: tools.map((t) => [t.textContent.trim().slice(0, 8) || t.tagName, Math.round(t.getBoundingClientRect().height)]).filter(([, h]) => h < 24) };
    })()`);
    ok(n.scroll <= 0, `${w} px: no sideways scroll`, `${n.scroll} px`);
    ok(n.phase && n.cross.length === 0, `${w} px: the status line does not sit on the view tools`, `「${n.phase}」 over ${n.cross.join(', ') || 'nothing'}`);
    ok(n.small.length === 0, `${w} px: the view tools are at least 24 px tall (WCAG 2.5.8; the roll bite under them is a target too)`, n.small.map(([t, h]) => `${t} ${h} px`).join(', '));
    if (prefix) console.log(`shot  ${await c.screenshot(`${prefix}-${w}.png`)}`);
  }
  await c.setViewport(1600, 1000);

  // ── the preset's note: a paragraph, and a real button (aria-expanded, aria-controls) that opens and folds it, by
  //    the keyboard and by a click; a note short enough for its three lines has no button
  const note = () =>
    c.evaluate(`(() => {
      const p = document.getElementById('preset-note'), b = document.querySelector('button[aria-controls="preset-note"]');
      return { role: p.getAttribute('role'), tab: p.tabIndex, clamped: p.scrollHeight > p.clientHeight + 1,
        button: b ? { name: b.textContent.trim(), expanded: b.getAttribute('aria-expanded'), shown: b.checkVisibility() } : null };
    })()`);
  await open('?preset=central-burst&cells=4&L=4', 'window.__mpm?.ready');
  const n0 = await note();
  const moves = [];
  if (n0.button?.shown) {
    await tabOnto('button[aria-controls="preset-note"]');
    for (const [how, act] of [['Enter', () => key('Enter')], ['Space', () => key(' ')], ['click', () => c.evaluate(`document.querySelector('button[aria-controls="preset-note"]').click()`)]]) {
      await act();
      const n = await note();
      moves.push(`${how}: ${n.button.expanded} ${n.clamped ? 'folded' : 'open'} 「${n.button.name}」`);
    }
  }
  ok(n0.role === null && n0.tab < 0 && n0.clamped && n0.button?.shown && n0.button.expanded === 'false' && n0.button.name.length <= 6,
    "the preset's note is a paragraph, with a button of a short name (aria-controls) to read on", JSON.stringify(n0));
  ok(moves.length === 3 && moves[0].startsWith('Enter: true open') && moves[1].startsWith('Space: false folded') && moves[2].startsWith('click: true open') && !moves[0].endsWith('「' + n0.button?.name + '」'),
    'Enter, Space and a click open and fold the note, aria-expanded and the words following', moves.join(', '));
  await open('?cells=4&L=4', 'window.__mpm?.ready');
  const n1 = await note();
  ok(!n1.clamped && !n1.button?.shown, 'a note that fits its three lines has no button', JSON.stringify(n1));

  // ── less motion: a crack's stamp is pressed without moving (and with motion it does move, so the check can fail)
  // a weak spot at the mid-plane with 4340's damage cracks early (tools/browser/tandem.mjs)
  const weak = Buffer.from(JSON.stringify({ damage: { ...DAMAGE_4340, etaCutoff: -2 }, defects: [{ kind: 'weak', x: 2e-3, y: 0, ax: 0.15e-3, ay: 0.3e-3, ductility: 0.02 }] })).toString('base64url');
  await open(`?cells=4&L=4&autorun=1&cond=${weak}`, '__mpm.cracks.length > 0 && document.querySelector("#crack-log .stamp")');
  await c.evaluate("document.getElementById('pause').click(); true");
  await c.waitFor('!__mpm.running', 10000);
  await painted();
  const enabled = await c.evaluate(`document.querySelectorAll('.explorer-roles [role=radio]:not(:disabled)').length`);
  const roleStops = (await walk()).filter((s) => s.role === 'radio' && s.group === '表示する点');
  ok(enabled >= 2 && roleStops.length === 1 && roleStops[0].checked === 'true', "the stress state's points (a radio group) are one Tab stop, the checked one", `${enabled} to choose from, ${roleStops.length} stops`);
  const press = () => c.evaluate(`(() => { __mpm.pressAgain(); const s = document.querySelector('#crack-log .stamp'); return { sheet: __mpm.pressing, record: getComputedStyle(s).animationName }; })()`);
  const moving = await press();
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const still = await press();
  await c.send('Emulation.setEmulatedMedia', { features: [] });
  ok(moving.sheet && moving.record === 'stamp-press' && !still.sheet && still.record === 'none', 'prefers-reduced-motion: the stamp is set down without moving, on the sheet and in the record', `motion: ${moving.sheet} / ${moving.record}; reduce: ${still.sheet} / ${still.record}`);
} finally {
  if (c) {
    await c.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    await c.navigate('about:blank').catch(() => {});
    c.close();
  }
}
done();
