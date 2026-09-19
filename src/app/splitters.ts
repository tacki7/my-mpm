// Draggable boundaries between the page's panes: the conditions and the stage, the stage and the
// record, the roll bite and its charts, and between the three charts. Each `.splitter` element says
// what it sizes (data-size); the sizes are CSS variables on the page root, so the grids in
// styles.css follow them. A splitter moves with the mouse (pointer events), with the arrow keys
// when focused (Shift for bigger steps), and goes back to the default on a double click. The sizes
// are kept per viewer in localStorage (it can be missing or throw: the page works without it).

type Size = 'left' | 'right' | 'charts' | 'c12' | 'c23';

interface Limits {
  min: number;
  max: number;
}

const KEY = 'mpm-layout-v1';
const STEP = 16; // px per arrow key
const BIG = 64; // with Shift

/** px limits of the one-number sizes (the chart columns keep at least MIN_COL each) */
const LIMITS: Record<'left' | 'right' | 'charts', Limits> = {
  left: { min: 180, max: 520 },
  right: { min: 200, max: 560 },
  charts: { min: 90, max: 480 },
};
const MIN_COL = 160;

const VARS: Record<'left' | 'right' | 'charts', string> = {
  left: '--w-left',
  right: '--w-right',
  charts: '--chart-h',
};

function load(): Record<string, string> {
  try {
    const s = localStorage.getItem(KEY);
    const v = s ? JSON.parse(s) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function save(values: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(values));
  } catch {
    // no storage (private window, blocked): the sizes last for this page only
  }
}

const clamp = (v: number, l: Limits) => Math.min(l.max, Math.max(l.min, v));

/**
 * Wire every `.splitter` on the page. `changed` is called after each change of size (the charts
 * redraw from it; the roll bite follows its own ResizeObserver).
 */
export function setupSplitters(changed: () => void): void {
  const root = document.documentElement;
  const values = load();
  // only the known variables, only plain numbers with a unit (a stored value never becomes CSS we did not write)
  for (const [k, v] of Object.entries(values)) {
    if (/^--(w-left|w-right|chart-h|c[123])$/.test(k) && /^\d+(\.\d+)?(px|fr)$/.test(v)) root.style.setProperty(k, v);
    else delete values[k];
  }

  const set = (name: string, value: string) => {
    root.style.setProperty(name, value);
    values[name] = value;
  };
  const unset = (name: string) => {
    root.style.removeProperty(name);
    delete values[name];
  };

  const width = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  const figures = () => Array.from(document.querySelectorAll<HTMLElement>('.charts > figure'));
  const chartHeight = () => (document.querySelector('.charts canvas') as HTMLElement | null)?.getBoundingClientRect().height ?? 190;

  /** the size a splitter shows as its value (aria-valuenow) */
  const current = (size: Size): number => {
    if (size === 'left') return width('.conditions');
    if (size === 'right') return width('.record');
    if (size === 'charts') return chartHeight();
    const f = figures();
    return size === 'c12' ? f[0]?.getBoundingClientRect().width ?? 0 : f[1]?.getBoundingClientRect().width ?? 0;
  };

  /** move a splitter by d px (along its axis, + = right or down) from the sizes at the start */
  const apply = (size: Size, start: number[], d: number) => {
    if (size === 'left') set(VARS.left, `${Math.round(clamp(start[0] + d, LIMITS.left))}px`);
    else if (size === 'right') set(VARS.right, `${Math.round(clamp(start[0] - d, LIMITS.right))}px`);
    else if (size === 'charts') set(VARS.charts, `${Math.round(clamp(start[0] - d, LIMITS.charts))}px`);
    else {
      // two neighbouring chart columns trade width; the three are kept as proportions (fr), so they
      // follow when the window or the side panes change
      const [a, b, c] = start;
      const i = size === 'c12' ? 0 : 1;
      const w = [a, b, c];
      const pair = w[i] + w[i + 1];
      const left = Math.min(pair - MIN_COL, Math.max(MIN_COL, w[i] + d));
      w[i] = left;
      w[i + 1] = pair - left;
      w.forEach((v, k) => set(`--c${k + 1}`, `${Math.round(v)}fr`));
    }
    changed();
  };

  const startSizes = (size: Size): number[] =>
    size === 'c12' || size === 'c23' ? figures().map((f) => f.getBoundingClientRect().width) : [current(size)];

  const reset = (size: Size) => {
    if (size === 'c12' || size === 'c23') ['--c1', '--c2', '--c3'].forEach(unset);
    else unset(VARS[size]);
    changed();
  };

  for (const el of document.querySelectorAll<HTMLElement>('.splitter')) {
    const size = el.dataset.size as Size;
    const horizontal = size === 'charts'; // a line across: it moves up and down
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    const lim = size === 'c12' || size === 'c23' ? { min: MIN_COL, max: 2000 } : LIMITS[size];
    el.setAttribute('aria-valuemin', String(lim.min));
    el.setAttribute('aria-valuemax', String(lim.max));
    const show = () => el.setAttribute('aria-valuenow', String(Math.round(current(size))));
    show();

    let origin = 0;
    let start: number[] = [];
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      origin = horizontal ? e.clientY : e.clientX;
      start = startSizes(size);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      apply(size, start, (horizontal ? e.clientY : e.clientX) - origin);
      show();
    });
    const end = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      save(values);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => {
      reset(size);
      save(values);
      requestAnimationFrame(show);
    });
    el.addEventListener('keydown', (e) => {
      const keys = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      const i = keys.indexOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      const step = (e.shiftKey ? BIG : STEP) * (i === 0 ? -1 : 1);
      apply(size, startSizes(size), step);
      save(values);
      requestAnimationFrame(show);
    });
  }
  changed();
}
