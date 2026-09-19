// Canvas text does not resolve CSS custom properties (`12px var(--font-ui)` is
// ignored and falls back to 10px sans-serif): read the page's UI font once.
let family: string | null = null;

export function uiFont(px: number, weight = 400): string {
  family ??= getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
  return `${weight} ${px}px ${family}`;
}
