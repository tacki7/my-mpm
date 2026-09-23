// How often the workers send a frame to draw (the masthead's 「描画の更新」 select, src/main.ts). The choice goes to
// every worker as it is made and whenever it changes (a 'frame-ms' message), so a run that is going takes it up at
// its next frame. 0 is 「自動」: each worker's own cadence (the section and the plan view 33 ms, the 3D model 80 ms).
// Kept in the browser (localStorage) as a convenience of this viewer, not in the conditions URL.

export const FRAME_RATES: readonly [number, string][] = [
  [0, '自動'],
  [33, '30 回/秒'],
  [80, '12 回/秒'],
  [250, '4 回/秒'],
  [1000, '1 回/秒'],
  [5000, '5 秒に 1 回'],
];

const KEY = 'mpm-frame-ms';
let current = 0;
try {
  const v = parseInt(localStorage.getItem(KEY) ?? '', 10);
  if (FRAME_RATES.some(([ms]) => ms === v)) current = v;
} catch {
  // no storage: the default
}
const listeners: ((ms: number) => void)[] = [];

/** the chosen interval [ms]; 0 for each worker's own */
export function frameMs(): number {
  return current;
}

export function setFrameMs(ms: number): void {
  if (!FRAME_RATES.some(([v]) => v === ms) || ms === current) return;
  current = ms;
  try {
    localStorage.setItem(KEY, String(ms));
  } catch {
    // no storage: the choice lasts the page
  }
  for (const fn of listeners) fn(ms);
  for (const s of selects) s.value = String(ms);
}

/** called at once with the current choice, then on every change */
export function onFrameMs(fn: (ms: number) => void): void {
  listeners.push(fn);
  fn(current);
}

const selects: HTMLSelectElement[] = [];

/** the select's options and its binding to the choice */
export function mountFrameRate(select: HTMLSelectElement): void {
  for (const [ms, label] of FRAME_RATES) {
    const o = document.createElement('option');
    o.value = String(ms);
    o.textContent = label;
    select.append(o);
  }
  select.value = String(current);
  select.addEventListener('change', () => setFrameMs(parseInt(select.value, 10)));
  selects.push(select);
}
