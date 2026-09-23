// The page's density (the masthead's 「レイアウト」 select): 標準, or コンパクト for a small screen or a run watched
// beside other windows. The choice is one attribute on <html>, data-density, and the stylesheet does the rest
// (src/styles.css「density」: a smaller type scale, tighter gaps, the panel's hints and the masthead's subtitle
// folded away, lower charts). Kept in the browser (localStorage) as a convenience of this viewer, like the frame
// interval; not in the conditions URL.

export type Density = 'standard' | 'compact';

export const DENSITIES: readonly [Density, string][] = [
  ['standard', '標準'],
  ['compact', 'コンパクト'],
];

const KEY = 'mpm-density';
let current: Density = 'standard';
try {
  const v = localStorage.getItem(KEY);
  if (DENSITIES.some(([d]) => d === v)) current = v as Density;
} catch {
  // no storage: the default
}
const listeners: ((d: Density) => void)[] = [];
const selects: HTMLSelectElement[] = [];

function apply(): void {
  const root = document.documentElement;
  if (current === 'standard') root.removeAttribute('data-density');
  else root.dataset.density = current;
}

/** the chosen density */
export function density(): Density {
  return current;
}

export function setDensity(d: Density): void {
  if (!DENSITIES.some(([v]) => v === d) || d === current) return;
  current = d;
  try {
    localStorage.setItem(KEY, d);
  } catch {
    // no storage: the choice lasts the page
  }
  apply();
  for (const s of selects) s.value = d;
  for (const fn of listeners) fn(d);
}

/** called at once with the current choice, then on every change (the views redraw: their canvases change size) */
export function onDensity(fn: (d: Density) => void): void {
  listeners.push(fn);
  fn(current);
}

/** the select's options and its binding to the choice; the attribute is set at once so the first paint is right */
export function mountDensity(select: HTMLSelectElement): void {
  apply();
  for (const [d, label] of DENSITIES) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = label;
    select.append(o);
  }
  select.value = current;
  select.addEventListener('change', () => setDensity(select.value as Density));
  selects.push(select);
}

/** --masthead-h follows the masthead's real height (it changes with the density and the screen's width) */
export function trackMasthead(masthead: HTMLElement): void {
  const set = () => document.documentElement.style.setProperty('--masthead-h', `${masthead.offsetHeight}px`);
  set();
  new ResizeObserver(set).observe(masthead);
}
